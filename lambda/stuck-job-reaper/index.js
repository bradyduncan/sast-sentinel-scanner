// stuck-job-reaper Lambda.
// Triggered on an EventBridge schedule. Scans the jobs table for items
// in non-terminal states (PENDING/FETCHING/SCANNING/COMMENTING) whose
// updated_at is older than STUCK_THRESHOLD_HOURS, marks them FAILED in
// DynamoDB, and publishes a single SNS alert summarizing the batch.

import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REQUIRED_ENV = ["JOBS_TABLE", "FAILURES_TOPIC_ARN"];

const NON_TERMINAL_STATUSES = ["PENDING", "FETCHING", "SCANNING", "COMMENTING"];

const ddb = new DynamoDBClient({});
const sns = new SNSClient({});

function stuckThresholdMs() {
  const hours = Number(process.env.STUCK_THRESHOLD_HOURS) || 1;
  return hours * 60 * 60 * 1000;
}

export async function findStuckJobs(table, cutoffIso) {
  const stuck = [];
  let exclusiveStartKey;

  do {
    const resp = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression:
          "#s IN (:s0, :s1, :s2, :s3) AND updated_at < :cutoff",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: marshall({
          ":s0": NON_TERMINAL_STATUSES[0],
          ":s1": NON_TERMINAL_STATUSES[1],
          ":s2": NON_TERMINAL_STATUSES[2],
          ":s3": NON_TERMINAL_STATUSES[3],
          ":cutoff": cutoffIso,
        }),
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    for (const item of resp.Items || []) {
      stuck.push(unmarshall(item));
    }
    exclusiveStartKey = resp.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return stuck;
}

export async function markJobStuck(table, jobId, prevStatus) {
  await ddb.send(
    new UpdateItemCommand({
      TableName: table,
      Key: marshall({ job_id: jobId }),
      UpdateExpression: "SET #s = :failed, #e = :err, updated_at = :now",
      ExpressionAttributeNames: { "#s": "status", "#e": "error" },
      ExpressionAttributeValues: marshall({
        ":failed": "FAILED",
        ":err": `stuck-job-reaper: job stuck in ${prevStatus} past threshold`,
        ":now": new Date().toISOString(),
      }),
    })
  );
}

export async function publishAlert(topicArn, stuckJobs) {
  const lines = stuckJobs.map(
    (j) =>
      `- ${j.job_id} (${j.repo_owner}/${j.repo_name} PR #${j.pr_number}, was ${j.status}, last update ${j.updated_at})`
  );
  await sns.send(
    new PublishCommand({
      TopicArn: topicArn,
      Subject: `SAST Sentinel — ${stuckJobs.length} stuck job${
        stuckJobs.length === 1 ? "" : "s"
      } reaped`,
      Message: [
        `${stuckJobs.length} stuck job(s) were found in non-terminal states past the configured threshold and marked FAILED:`,
        "",
        ...lines,
      ].join("\n"),
    })
  );
}

export const handler = async () => {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const cutoffIso = new Date(Date.now() - stuckThresholdMs()).toISOString();
  console.log(`scanning for non-terminal jobs with updated_at < ${cutoffIso}`);

  const stuck = await findStuckJobs(process.env.JOBS_TABLE, cutoffIso);

  if (stuck.length === 0) {
    console.log("no stuck jobs found");
    return { stuckCount: 0 };
  }

  console.log(`found ${stuck.length} stuck job(s); marking FAILED`);
  for (const job of stuck) {
    await markJobStuck(process.env.JOBS_TABLE, job.job_id, job.status);
  }

  await publishAlert(process.env.FAILURES_TOPIC_ARN, stuck);
  console.log(`published SNS alert for ${stuck.length} stuck job(s)`);

  return { stuckCount: stuck.length };
};
