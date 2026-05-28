// fetch-code Lambda.
// Step Functions input (execution context):
//   { job_id, repo: { owner, name }, pr_number, commit_sha, installation_id }
//
// Marks the job FETCHING in DynamoDB, authenticates as a GitHub App installation,
// lists the files changed in the PR, downloads each at commit_sha, bundles them
// into a tarball with their repo-relative paths, and uploads to
// s3://<staging>/staging/<job_id>/pr_files.tar.gz per docs/contracts.md.
//
// Returns the same execution context untouched (Step Functions ResultPath=null).

import { App } from "@octokit/app";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { marshall } from "@aws-sdk/util-dynamodb";
import * as tar from "tar";
import { mkdirSync, writeFileSync, createReadStream, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";

const REQUIRED_ENV = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_SECRET_ID",
  "JOBS_TABLE",
  "STAGING_BUCKET",
];

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const secrets = new SecretsManagerClient({});

let cachedApp = null;
let cachedPrivateKey = null;

// Exposed for tests; container reuse means in prod the cache persists.
export function _resetAuthCache() {
  cachedApp = null;
  cachedPrivateKey = null;
}

// Allow tests to inject a mock GitHub App instead of constructing a real one.
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

async function setStatus(jobId, status, errorMessage) {
  const exprNames = { "#s": "status" };
  const exprValues = {
    ":status": status,
    ":now": new Date().toISOString(),
  };
  let updateExpr = "SET #s = :status, updated_at = :now";
  if (errorMessage !== undefined) {
    exprNames["#e"] = "error";
    exprValues[":err"] = String(errorMessage).slice(0, 1024);
    updateExpr += ", #e = :err";
  }
  await ddb.send(
    new UpdateItemCommand({
      TableName: process.env.JOBS_TABLE,
      Key: marshall({ job_id: jobId }),
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: marshall(exprValues),
    })
  );
}

export async function listPrFiles(octokit, owner, repo, prNumber) {
  const files = [];
  for await (const page of octokit.paginate.iterator(
    octokit.rest.pulls.listFiles,
    { owner, repo, pull_number: prNumber, per_page: 100 }
  )) {
    files.push(...page.data);
  }
  // Skip deletes — scanner can't analyze something that no longer exists at this SHA.
  return files.filter((f) => f.status !== "removed");
}

export async function downloadFileContents(octokit, owner, repo, path, ref) {
  const { data } = await octokit.rest.repos.getContent({
    owner,
    repo,
    path,
    ref,
  });
  if (Array.isArray(data) || data.type !== "file") {
    return null; // directory or symlink — skip
  }
  return Buffer.from(data.content, "base64");
}

export async function buildTarball(files, jobId) {
  const stageDir = join(tmpdir(), `fetch-${jobId}`);
  rmSync(stageDir, { recursive: true, force: true });
  for (const file of files) {
    const fullPath = join(stageDir, file.path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content);
  }
  const tarPath = join(tmpdir(), `${jobId}.tar.gz`);
  await tar.create({ gzip: true, file: tarPath, cwd: stageDir }, ["."]);
  return tarPath;
}

async function uploadTarball(tarPath, jobId) {
  const key = `staging/${jobId}/pr_files.tar.gz`;
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.STAGING_BUCKET,
      Key: key,
      Body: createReadStream(tarPath),
      ContentType: "application/gzip",
    })
  );
  return key;
}

export const handler = async (event) => {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  if (
    !event?.job_id ||
    !event?.repo?.owner ||
    !event?.repo?.name ||
    !event?.pr_number ||
    !event?.commit_sha ||
    !event?.installation_id
  ) {
    throw new Error("Missing required fields in execution context");
  }

  const { job_id, repo, pr_number, commit_sha, installation_id } = event;

  try {
    await setStatus(job_id, "FETCHING");

    const app = await getGitHubApp();
    const octokit = await app.getInstallationOctokit(installation_id);

    const prFiles = await listPrFiles(octokit, repo.owner, repo.name, pr_number);
    console.log(`[${job_id}] PR has ${prFiles.length} non-deleted files`);

    const downloaded = [];
    for (const f of prFiles) {
      const content = await downloadFileContents(
        octokit,
        repo.owner,
        repo.name,
        f.filename,
        commit_sha
      );
      if (content) downloaded.push({ path: f.filename, content });
    }
    console.log(`[${job_id}] downloaded ${downloaded.length} file contents`);

    const tarPath = await buildTarball(downloaded, job_id);
    const stagingKey = await uploadTarball(tarPath, job_id);

    console.log(
      `[${job_id}] staged to s3://${process.env.STAGING_BUCKET}/${stagingKey}`
    );

    return event;
  } catch (err) {
    console.error(`[${job_id}] fetch-code failed:`, err);
    try {
      await setStatus(job_id, "FAILED", err.message);
    } catch (innerErr) {
      console.error(`[${job_id}] also failed to mark FAILED:`, innerErr);
    }
    throw err; // re-throw so Step Functions Catch fires
  }
};
