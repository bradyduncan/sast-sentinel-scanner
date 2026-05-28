// post-comment Lambda.
// Step Functions invokes this from BOTH the success path (PostComment state)
// AND the failure path (PostFailureComment state). The Lambda reads the job
// status from DynamoDB and formats accordingly.
//
// Success path: status is SCANNING coming in. Read results.json from S3,
//   format findings as markdown, post comment, mark status DONE.
// Failure path: status is FAILED coming in. Read error from DynamoDB,
//   format failure comment, post. Status stays FAILED.

import { App } from "@octokit/app";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REQUIRED_ENV = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_SECRET_ID",
  "JOBS_TABLE",
  "RESULTS_BUCKET",
];

const SEVERITY_EMOJI = { HIGH: "🔴", MEDIUM: "🟡", LOW: "🟢" };

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});

let cachedApp = null;
let cachedPrivateKey = null;

export function _resetAuthCache() {
  cachedApp = null;
  cachedPrivateKey = null;
}

let appFactory = (opts) => new App(opts);
export function _setAppFactory(fn) {
  appFactory = fn;
}

async function getGitHubApp() {
  if (cachedApp) return cachedApp;
  if (!cachedPrivateKey) {
    const resp = await secrets.send(
      new GetSecretValueCommand({
        SecretId: process.env.GITHUB_APP_PRIVATE_KEY_SECRET_ID,
      })
    );
    cachedPrivateKey = resp.SecretString;
  }
  cachedApp = appFactory({
    appId: process.env.GITHUB_APP_ID,
    privateKey: cachedPrivateKey,
  });
  return cachedApp;
}

async function getJob(jobId) {
  const resp = await ddb.send(
    new GetItemCommand({
      TableName: process.env.JOBS_TABLE,
      Key: marshall({ job_id: jobId }),
    })
  );
  if (!resp.Item) throw new Error(`Job ${jobId} not found`);
  return unmarshall(resp.Item);
}

async function setStatus(jobId, status) {
  await ddb.send(
    new UpdateItemCommand({
      TableName: process.env.JOBS_TABLE,
      Key: marshall({ job_id: jobId }),
      UpdateExpression: "SET #s = :status, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: marshall({
        ":status": status,
        ":now": new Date().toISOString(),
      }),
    })
  );
}

async function readResults(resultsKey) {
  const resp = await s3.send(
    new GetObjectCommand({
      Bucket: process.env.RESULTS_BUCKET,
      Key: resultsKey,
    })
  );
  const body = await resp.Body.transformToString();
  return JSON.parse(body);
}

export function formatSuccessComment(job, results) {
  const { summary, findings, commit_sha } = results;
  if (summary.total === 0) {
    return [
      "## ✅ SAST Sentinel — No vulnerabilities found",
      "",
      `Scanned commit \`${commit_sha.slice(0, 7)}\`. Clean.`,
      "",
      "---",
      `_Job \`${job.job_id}\`_`,
    ].join("\n");
  }

  const heading = `## 🛡️ SAST Sentinel — ${summary.total} finding${
    summary.total === 1 ? "" : "s"
  } (${summary.high} high, ${summary.medium} medium, ${summary.low} low)`;

  const tableRows = findings
    .map(
      (f) =>
        `| ${SEVERITY_EMOJI[f.severity] || ""} ${f.severity} | ${f.name} | \`${f.file}:${f.line}\` |`
    )
    .join("\n");

  const details = findings
    .map((f) => {
      const lang = f.file.endsWith(".ts") ? "ts" : "js";
      return [
        `### ${SEVERITY_EMOJI[f.severity] || ""} ${f.name} — \`${f.file}:${f.line}\``,
        `**Why:** ${f.description}`,
        `**Evidence:**`,
        "```" + lang,
        f.evidence,
        "```",
      ].join("\n");
    })
    .join("\n\n");

  return [
    heading,
    "",
    "| Severity | Rule | Location |",
    "| --- | --- | --- |",
    tableRows,
    "",
    `<details><summary>Findings (${findings.length})</summary>`,
    "",
    details,
    "",
    "</details>",
    "",
    "---",
    `_Scanned commit \`${commit_sha.slice(0, 7)}\` · Job \`${job.job_id}\`_`,
  ].join("\n");
}

export function formatFailureComment(job) {
  return [
    "## ⚠️ SAST Sentinel — Scan failed",
    "",
    `The scan could not complete: \`${(job.error || "unknown error").slice(0, 500)}\``,
    "",
    "---",
    `_Job \`${job.job_id}\`_`,
  ].join("\n");
}

async function postComment(octokit, owner, repo, prNumber, body) {
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
}

export const handler = async (event) => {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  if (!event?.job_id) {
    throw new Error("Missing job_id in execution context");
  }

  const jobId = event.job_id;
  const job = await getJob(jobId);

  let body;
  const isFailure = job.status === "FAILED";

  if (isFailure) {
    body = formatFailureComment(job);
  } else {
    await setStatus(jobId, "COMMENTING");
    if (!job.s3_results_key) {
      throw new Error(`Job ${jobId} has no s3_results_key`);
    }
    const results = await readResults(job.s3_results_key);
    body = formatSuccessComment(job, results);
  }

  const app = await getGitHubApp();
  const octokit = await app.getInstallationOctokit(job.installation_id);
  await postComment(octokit, job.repo_owner, job.repo_name, job.pr_number, body);

  if (!isFailure) {
    await setStatus(jobId, "DONE");
  }

  console.log(
    `[${jobId}] posted ${isFailure ? "FAILURE" : "SUCCESS"} comment to ${job.repo_owner}/${job.repo_name} PR #${job.pr_number}`
  );
  return event;
};
