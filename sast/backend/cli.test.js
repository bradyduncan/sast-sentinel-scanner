import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import path from "path";

import {
  readEnv,
  computeSummary,
  flattenAndStripPaths,
  markScanning,
  markFailed,
} from "./cli.js";

const ddbMock = mockClient(DynamoDBClient);

beforeEach(() => {
  ddbMock.reset();
});

describe("readEnv", () => {
  const REQUIRED = [
    "JOB_ID",
    "STAGING_BUCKET",
    "STAGING_KEY",
    "RESULTS_BUCKET",
    "RESULTS_KEY",
    "JOBS_TABLE",
  ];

  let saved;

  beforeEach(() => {
    saved = {};
    for (const k of [...REQUIRED, "AWS_REGION"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("throws listing every missing var", () => {
    expect(() => readEnv()).toThrow(/Missing required env vars: JOB_ID/);
  });

  it("returns parsed env when all required vars are set", () => {
    for (const k of REQUIRED) process.env[k] = `${k}_value`;
    const env = readEnv();
    expect(env.jobId).toBe("JOB_ID_value");
    expect(env.stagingBucket).toBe("STAGING_BUCKET_value");
    expect(env.jobsTable).toBe("JOBS_TABLE_value");
  });

  it("defaults region to us-east-1 when AWS_REGION is unset", () => {
    for (const k of REQUIRED) process.env[k] = "x";
    expect(readEnv().region).toBe("us-east-1");
  });
});

describe("computeSummary", () => {
  it("returns zeros for an empty array", () => {
    expect(computeSummary([])).toEqual({ total: 0, high: 0, medium: 0, low: 0 });
  });

  it("counts findings by severity", () => {
    const findings = [
      { severity: "HIGH" },
      { severity: "HIGH" },
      { severity: "MEDIUM" },
      { severity: "LOW" },
      { severity: "LOW" },
      { severity: "LOW" },
    ];
    expect(computeSummary(findings)).toEqual({
      total: 6,
      high: 2,
      medium: 1,
      low: 3,
    });
  });
});

describe("flattenAndStripPaths", () => {
  const extractDir = path.join(path.sep, "tmp", "abc");
  const fileA = path.join(extractDir, "src", "users.js");
  const fileB = path.join(extractDir, "lib", "db.js");

  it("strips the extract-dir prefix and normalizes to forward slashes", () => {
    const scanResults = {
      [fileA]: [
        { severity: "HIGH", line: 10, name: "X", id: "X", file: fileA },
      ],
    };
    const out = flattenAndStripPaths(scanResults, extractDir);
    expect(out).toHaveLength(1);
    expect(out[0].file).toBe("src/users.js");
  });

  it("sorts HIGH before MEDIUM before LOW, then by file, then by line", () => {
    const scanResults = {
      [fileA]: [
        { severity: "LOW", line: 5, name: "L", id: "L", file: fileA },
        { severity: "HIGH", line: 20, name: "H2", id: "H", file: fileA },
      ],
      [fileB]: [
        { severity: "HIGH", line: 1, name: "H1", id: "H", file: fileB },
        { severity: "MEDIUM", line: 99, name: "M", id: "M", file: fileB },
      ],
    };
    const out = flattenAndStripPaths(scanResults, extractDir);
    expect(out.map((f) => `${f.severity}:${f.file}:${f.line}`)).toEqual([
      "HIGH:lib/db.js:1",
      "HIGH:src/users.js:20",
      "MEDIUM:lib/db.js:99",
      "LOW:src/users.js:5",
    ]);
  });
});

describe("markScanning", () => {
  it("sends an UpdateItem setting status=SCANNING and returns the unmarshalled item", async () => {
    ddbMock.on(UpdateItemCommand).resolves({
      Attributes: marshall({
        job_id: "job-123",
        repo_owner: "anthropics",
        repo_name: "claude-code",
        pr_number: 42,
        commit_sha: "abc1234",
        status: "SCANNING",
      }),
    });

    const ddb = new DynamoDBClient({});
    const job = await markScanning(ddb, "sast-jobs", "job-123");

    expect(job).toMatchObject({
      job_id: "job-123",
      repo_owner: "anthropics",
      repo_name: "claude-code",
      pr_number: 42,
      commit_sha: "abc1234",
      status: "SCANNING",
    });

    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.TableName).toBe("sast-jobs");
    expect(input.UpdateExpression).toMatch(/SET #s = :scanning/);
    expect(input.ReturnValues).toBe("ALL_NEW");
    expect(input.ExpressionAttributeValues[":scanning"].S).toBe("SCANNING");
  });
});

describe("markFailed", () => {
  it("sends an UpdateItem setting status=FAILED with the error message", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    const ddb = new DynamoDBClient({});
    await markFailed(ddb, "sast-jobs", "job-123", "boom");

    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.UpdateExpression).toMatch(/SET #s = :failed/);
    expect(input.ExpressionAttributeValues[":failed"].S).toBe("FAILED");
    expect(input.ExpressionAttributeValues[":err"].S).toBe("boom");
  });

  it("truncates very long error messages to 1024 chars", async () => {
    ddbMock.on(UpdateItemCommand).resolves({});

    const ddb = new DynamoDBClient({});
    const longErr = "x".repeat(2000);
    await markFailed(ddb, "sast-jobs", "job-123", longErr);

    const input = ddbMock.commandCalls(UpdateItemCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues[":err"].S).toHaveLength(1024);
  });
});
