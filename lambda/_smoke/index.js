// Smoke Lambda. Writes a TTL'd item to the jobs table and returns 200.
// Validates: Lambda exec role works, API Gateway → Lambda wiring works,
// Lambda → DynamoDB write works. Single milestone-evidence artifact.

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { randomUUID } from "crypto";

const ddb = new DynamoDBClient({});

export const handler = async () => {
  const jobId = `smoke-${randomUUID()}`;
  const now = new Date().toISOString();

  await ddb.send(
    new PutItemCommand({
      TableName: process.env.JOBS_TABLE,
      Item: marshall({
        job_id: jobId,
        delivery_id: jobId,
        status: "SMOKE_TEST",
        created_at: now,
        updated_at: now,
        // TTL: 1 day from now so smoke items auto-clean.
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      }),
    })
  );

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "ok", job_id: jobId }),
  };
};
