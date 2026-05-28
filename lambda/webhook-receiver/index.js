// GitHub webhook receiver Lambda.
// Validates the HMAC signature, deduplicates by X-GitHub-Delivery, writes
// the job to DynamoDB, and kicks off Step Functions.
// See docs/contracts.md for DynamoDB schema and Step Functions execution context.

import { createHmac, timingSafeEqual, randomUUID } from "crypto";

import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { marshall } from "@aws-sdk/util-dynamodb";

const REQUIRED_ENV = [
  "JOBS_TABLE",
  "DELIVERY_ID_INDEX",
  "STATE_MACHINE_ARN",
  "WEBHOOK_SECRET_ID",
];

const RELEVANT_ACTIONS = new Set(["opened", "synchronize", "reopened"]);
const TTL_SECONDS = 30 * 24 * 60 * 60;

const ddb = new DynamoDBClient({});
const sfn = new SFNClient({});
const secrets = new SecretsManagerClient({});

let cachedSecret = null;

// Exposed for tests; container reuse means in prod the cache persists across invocations.
export function _resetSecretCache() {
  cachedSecret = null;
}

async function getWebhookSecret() {
  if (cachedSecret) return cachedSecret;
  const resp = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.WEBHOOK_SECRET_ID })
  );
  cachedSecret = resp.SecretString;
  return cachedSecret;
}

export function verifySignature(body, signatureHeader, secret) {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = Buffer.from(
    createHmac("sha256", secret).update(body).digest("hex"),
    "hex"
  );
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

async function isDuplicateDelivery(deliveryId) {
  const resp = await ddb.send(
    new QueryCommand({
      TableName: process.env.JOBS_TABLE,
      IndexName: process.env.DELIVERY_ID_INDEX,
      KeyConditionExpression: "delivery_id = :d",
      ExpressionAttributeValues: marshall({ ":d": deliveryId }),
      Limit: 1,
    })
  );
  return (resp.Items || []).length > 0;
}

async function createJob(job) {
  await ddb.send(
    new PutItemCommand({
      TableName: process.env.JOBS_TABLE,
      Item: marshall(job),
      ConditionExpression: "attribute_not_exists(job_id)",
    })
  );
}

async function startScan(jobId, executionContext) {
  await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: process.env.STATE_MACHINE_ARN,
      name: jobId,
      input: JSON.stringify(executionContext),
    })
  );
}

function respond(statusCode, message) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  };
}

function extractPayloadFields(payload) {
  return {
    repoOwner: payload?.repository?.owner?.login,
    repoName: payload?.repository?.name,
    prNumber: payload?.pull_request?.number,
    commitSha: payload?.pull_request?.head?.sha,
    installationId: payload?.installation?.id,
  };
}

export const handler = async (event) => {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("missing env vars:", missing);
    return respond(500, "Server misconfigured");
  }

  const body = event.body || "";
  const headers = event.headers || {};
  const deliveryId = headers["x-github-delivery"];
  const signature = headers["x-hub-signature-256"];
  const eventType = headers["x-github-event"];

  if (!deliveryId) return respond(400, "Missing X-GitHub-Delivery header");

  const secret = await getWebhookSecret();
  if (!verifySignature(body, signature, secret)) {
    return respond(401, "Invalid signature");
  }

  if (eventType !== "pull_request") return respond(200, "Event ignored");

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return respond(400, "Invalid JSON body");
  }

  if (!RELEVANT_ACTIONS.has(payload.action)) {
    return respond(200, "Action ignored");
  }

  const fields = extractPayloadFields(payload);
  if (
    !fields.repoOwner ||
    !fields.repoName ||
    !fields.prNumber ||
    !fields.commitSha ||
    !fields.installationId
  ) {
    return respond(400, "Missing required payload fields");
  }

  if (await isDuplicateDelivery(deliveryId)) {
    console.log(`duplicate delivery ${deliveryId}, ignoring`);
    return respond(200, "Duplicate delivery");
  }

  const now = new Date().toISOString();
  const job = {
    job_id: randomUUID(),
    delivery_id: deliveryId,
    status: "PENDING",
    created_at: now,
    updated_at: now,
    expires_at: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    repo_owner: fields.repoOwner,
    repo_name: fields.repoName,
    pr_number: fields.prNumber,
    commit_sha: fields.commitSha,
    installation_id: fields.installationId,
  };

  await createJob(job);

  const executionContext = {
    job_id: job.job_id,
    repo: { owner: fields.repoOwner, name: fields.repoName },
    pr_number: fields.prNumber,
    commit_sha: fields.commitSha,
    installation_id: fields.installationId,
  };

  try {
    await startScan(job.job_id, executionContext);
  } catch (err) {
    console.error("failed to start Step Functions execution:", err);
    return respond(500, "Failed to start scan");
  }

  console.log(
    `created job ${job.job_id} for ${fields.repoOwner}/${fields.repoName} PR #${fields.prNumber}`
  );
  return respond(202, "Accepted");
};
