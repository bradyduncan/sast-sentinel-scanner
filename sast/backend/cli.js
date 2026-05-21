// Batch entrypoint for the Fargate scanner task.
// Env-var contract and output format live in docs/contracts.md.

import { readFileSync, mkdirSync, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import path from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as tar from "tar";

import { scanDirectory } from "./scanner.js";

const REQUIRED_ENV = [
  "JOB_ID",
  "STAGING_BUCKET",
  "STAGING_KEY",
  "RESULTS_BUCKET",
  "RESULTS_KEY",
  "JOBS_TABLE",
];

const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const SCHEMA_VERSION = "1.0.0";

export function readEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  return {
    jobId: process.env.JOB_ID,
    stagingBucket: process.env.STAGING_BUCKET,
    stagingKey: process.env.STAGING_KEY,
    resultsBucket: process.env.RESULTS_BUCKET,
    resultsKey: process.env.RESULTS_KEY,
    jobsTable: process.env.JOBS_TABLE,
    region: process.env.AWS_REGION || "us-east-1",
  };
}

export async function markScanning(ddb, table, jobId) {
  // Atomic: set status=SCANNING, bump updated_at, return the full item so we
  // can pull repo_owner / repo_name / pr_number / commit_sha without a separate GetItem.
  const resp = await ddb.send(
    new UpdateItemCommand({
      TableName: table,
      Key: marshall({ job_id: jobId }),
      UpdateExpression: "SET #s = :scanning, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: marshall({
        ":scanning": "SCANNING",
        ":now": new Date().toISOString(),
      }),
      ReturnValues: "ALL_NEW",
    })
  );
  return unmarshall(resp.Attributes);
}

export async function writeSummary(ddb, table, jobId, summary, resultsKey) {
  await ddb.send(
    new UpdateItemCommand({
      TableName: table,
      Key: marshall({ job_id: jobId }),
      UpdateExpression:
        "SET summary = :summary, s3_results_key = :key, updated_at = :now",
      ExpressionAttributeValues: marshall({
        ":summary": summary,
        ":key": resultsKey,
        ":now": new Date().toISOString(),
      }),
    })
  );
}

export async function markFailed(ddb, table, jobId, errorMessage) {
  await ddb.send(
    new UpdateItemCommand({
      TableName: table,
      Key: marshall({ job_id: jobId }),
      UpdateExpression: "SET #s = :failed, #e = :err, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status", "#e": "error" },
      ExpressionAttributeValues: marshall({
        ":failed": "FAILED",
        ":err": String(errorMessage).slice(0, 1024),
        ":now": new Date().toISOString(),
      }),
    })
  );
}

async function downloadTarball(s3, bucket, key, destPath) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  await pipeline(resp.Body, createWriteStream(destPath));
}

async function uploadResults(s3, bucket, key, body) {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
    })
  );
}

export function flattenAndStripPaths(scanResults, extractDir) {
  const findings = [];
  for (const [absPath, vulns] of Object.entries(scanResults)) {
    // Normalize to forward-slash repo-relative paths regardless of OS.
    const relPath = path
      .relative(extractDir, absPath)
      .split(path.sep)
      .join("/");
    for (const v of vulns) {
      findings.push({ ...v, file: relPath });
    }
  }
  findings.sort((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) return sevDiff;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });
  return findings;
}

export function computeSummary(findings) {
  const summary = { total: findings.length, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.severity === "HIGH") summary.high++;
    else if (f.severity === "MEDIUM") summary.medium++;
    else if (f.severity === "LOW") summary.low++;
  }
  return summary;
}

function readScannerVersion() {
  const pkg = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf-8")
  );
  return pkg.version;
}

export async function main() {
  const env = readEnv();
  const s3 = new S3Client({ region: env.region });
  const ddb = new DynamoDBClient({ region: env.region });

  console.log(`[${env.jobId}] starting scan`);

  const job = await markScanning(ddb, env.jobsTable, env.jobId);
  console.log(
    `[${env.jobId}] scanning ${job.repo_owner}/${job.repo_name} PR #${job.pr_number} @ ${job.commit_sha}`
  );

  const tarPath = path.join(tmpdir(), `${env.jobId}.tar.gz`);
  const extractDir = path.join(tmpdir(), env.jobId);
  mkdirSync(extractDir, { recursive: true });

  console.log(
    `[${env.jobId}] downloading s3://${env.stagingBucket}/${env.stagingKey}`
  );
  await downloadTarball(s3, env.stagingBucket, env.stagingKey, tarPath);

  console.log(`[${env.jobId}] extracting to ${extractDir}`);
  await tar.x({ file: tarPath, cwd: extractDir, strict: true });

  console.log(`[${env.jobId}] scanning extracted files`);
  const scanResults = scanDirectory(extractDir);
  const findings = flattenAndStripPaths(scanResults, extractDir);
  const summary = computeSummary(findings);
  console.log(
    `[${env.jobId}] ${summary.total} findings (high=${summary.high}, medium=${summary.medium}, low=${summary.low})`
  );

  const results = {
    schema_version: SCHEMA_VERSION,
    job_id: env.jobId,
    scanner_version: readScannerVersion(),
    scanned_at: new Date().toISOString(),
    repo: { owner: job.repo_owner, name: job.repo_name },
    pr_number: job.pr_number,
    commit_sha: job.commit_sha,
    summary,
    findings,
  };

  console.log(
    `[${env.jobId}] uploading results to s3://${env.resultsBucket}/${env.resultsKey}`
  );
  await uploadResults(
    s3,
    env.resultsBucket,
    env.resultsKey,
    JSON.stringify(results, null, 2)
  );

  await writeSummary(
    ddb,
    env.jobsTable,
    env.jobId,
    summary,
    env.resultsKey
  );

  console.log(`[${env.jobId}] done`);
}

const isDirectInvocation =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectInvocation) {
  main().catch(async (err) => {
    console.error("scanner failed:", err);
    try {
      if (process.env.JOB_ID && process.env.JOBS_TABLE) {
        const ddb = new DynamoDBClient({
          region: process.env.AWS_REGION || "us-east-1",
        });
        await markFailed(
          ddb,
          process.env.JOBS_TABLE,
          process.env.JOB_ID,
          err.message
        );
      }
    } catch (innerErr) {
      console.error("also failed to mark job as FAILED:", innerErr);
    }
    process.exit(1);
  });
}
