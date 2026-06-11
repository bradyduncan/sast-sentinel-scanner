import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { marshall } from "@aws-sdk/util-dynamodb";

import { handler } from "./index.js";

const ddbMock = mockClient(DynamoDBClient);
const snsMock = mockClient(SNSClient);

beforeEach(() => {
  ddbMock.reset();
  snsMock.reset();
  process.env.JOBS_TABLE = "test-jobs";
  process.env.FAILURES_TOPIC_ARN = "arn:aws:sns:us-east-1:123:test-failures";
  process.env.STUCK_THRESHOLD_HOURS = "1";
});

afterEach(() => {
  delete process.env.JOBS_TABLE;
  delete process.env.FAILURES_TOPIC_ARN;
  delete process.env.STUCK_THRESHOLD_HOURS;
});

describe("handler", () => {
  it("returns stuckCount=0 and skips SNS when no stuck jobs exist", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    const result = await handler();

    expect(result).toEqual({ stuckCount: 0 });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(snsMock.commandCalls(PublishCommand)).toHaveLength(0);
  });

  it("marks each stuck job FAILED and publishes a single SNS alert", async () => {
    const stuckJobs = [
      {
        job_id: "job-a",
        status: "FETCHING",
        repo_owner: "octocat",
        repo_name: "demo",
        pr_number: 1,
        updated_at: "2026-01-01T00:00:00Z",
      },
      {
        job_id: "job-b",
        status: "SCANNING",
        repo_owner: "octocat",
        repo_name: "demo",
        pr_number: 2,
        updated_at: "2026-01-01T00:30:00Z",
      },
    ];
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: stuckJobs.map((j) => marshall(j)) });
    ddbMock.on(UpdateItemCommand).resolves({});
    snsMock.on(PublishCommand).resolves({ MessageId: "mid" });

    const result = await handler();

    expect(result).toEqual({ stuckCount: 2 });

    const updates = ddbMock.commandCalls(UpdateItemCommand);
    expect(updates).toHaveLength(2);
    expect(updates[0].args[0].input.Key.job_id.S).toBe("job-a");
    expect(updates[1].args[0].input.Key.job_id.S).toBe("job-b");
    expect(updates[0].args[0].input.ExpressionAttributeValues[":failed"].S).toBe(
      "FAILED"
    );

    const publishes = snsMock.commandCalls(PublishCommand);
    expect(publishes).toHaveLength(1);
    expect(publishes[0].args[0].input.Subject).toContain("2 stuck jobs");
    expect(publishes[0].args[0].input.Message).toContain("job-a");
    expect(publishes[0].args[0].input.Message).toContain("job-b");
  });

  it("paginates DynamoDB Scan via LastEvaluatedKey", async () => {
    const page1 = [
      {
        job_id: "job-1",
        status: "PENDING",
        repo_owner: "o",
        repo_name: "r",
        pr_number: 1,
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const page2 = [
      {
        job_id: "job-2",
        status: "PENDING",
        repo_owner: "o",
        repo_name: "r",
        pr_number: 2,
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: page1.map((j) => marshall(j)),
        LastEvaluatedKey: marshall({ job_id: "job-1" }),
      })
      .resolvesOnce({ Items: page2.map((j) => marshall(j)) });
    snsMock.on(PublishCommand).resolves({ MessageId: "mid" });

    const result = await handler();

    expect(result).toEqual({ stuckCount: 2 });
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(2);
  });

  it("throws on missing required env vars", async () => {
    delete process.env.JOBS_TABLE;
    await expect(handler()).rejects.toThrow(/JOBS_TABLE/);
  });
});
