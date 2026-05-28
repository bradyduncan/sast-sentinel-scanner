import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";

import { mockClient } from "aws-sdk-client-mock";
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
import { marshall } from "@aws-sdk/util-dynamodb";

import {
  handler,
  formatSuccessComment,
  formatFailureComment,
  _resetAuthCache,
  _setAppFactory,
} from "./index.js";

const ddbMock = mockClient(DynamoDBClient);
const s3Mock = mockClient(S3Client);
const secretsMock = mockClient(SecretsManagerClient);

const RESULTS = readFileSync(
  new URL("./__fixtures__/results.json", import.meta.url),
  "utf-8"
);

const REQUIRED_ENV = {
  GITHUB_APP_ID: "111",
  GITHUB_APP_PRIVATE_KEY_SECRET_ID: "sast-sentinel/github-app-private-key",
  JOBS_TABLE: "sast-sentinel-jobs",
  RESULTS_BUCKET: "sast-sentinel-results-test",
};

const BASE_JOB = {
  job_id: "test-job-1",
  status: "SCANNING",
  repo_owner: "anthropics",
  repo_name: "claude-code",
  pr_number: 42,
  commit_sha: "abc1234",
  installation_id: 12345,
  s3_results_key: "results/test-job-1/results.json",
};

let savedEnv;
let createComment;

function makeFakeOctokit() {
  createComment = vi.fn(async () => ({ data: { id: 1 } }));
  return { rest: { issues: { createComment } } };
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  secretsMock.reset();
  _resetAuthCache();

  savedEnv = {};
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  secretsMock
    .on(GetSecretValueCommand)
    .resolves({ SecretString: "fake-pem" });
  ddbMock.on(UpdateItemCommand).resolves({});
  s3Mock.on(GetObjectCommand).resolves({
    Body: { transformToString: async () => RESULTS },
  });

  _setAppFactory(() => ({
    getInstallationOctokit: async () => makeFakeOctokit(),
  }));
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("handler", () => {
  it("throws when env vars missing", async () => {
    delete process.env.JOBS_TABLE;
    await expect(handler({ job_id: "x" })).rejects.toThrow(
      /Missing required env vars/
    );
  });

  it("throws when job_id missing", async () => {
    await expect(handler({})).rejects.toThrow(/Missing job_id/);
  });

  it("success path: SCANNING -> COMMENTING -> DONE, posts success comment", async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: marshall(BASE_JOB) });

    await handler({ job_id: BASE_JOB.job_id });

    const updates = ddbMock.commandCalls(UpdateItemCommand);
    expect(updates).toHaveLength(2);
    expect(updates[0].args[0].input.ExpressionAttributeValues[":status"].S).toBe(
      "COMMENTING"
    );
    expect(updates[1].args[0].input.ExpressionAttributeValues[":status"].S).toBe(
      "DONE"
    );

    expect(createComment).toHaveBeenCalledOnce();
    const arg = createComment.mock.calls[0][0];
    expect(arg.owner).toBe("anthropics");
    expect(arg.repo).toBe("claude-code");
    expect(arg.issue_number).toBe(42);
    expect(arg.body).toMatch(/SAST Sentinel/);
    expect(arg.body).toMatch(/SQL Injection/);
  });

  it("failure path: status=FAILED skips S3 read + status updates, posts failure comment", async () => {
    ddbMock
      .on(GetItemCommand)
      .resolves({ Item: marshall({ ...BASE_JOB, status: "FAILED", error: "boom" }) });

    await handler({ job_id: BASE_JOB.job_id });

    // Zero UpdateItem calls — failure path doesn't transition status.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    // Zero S3 reads — don't need results.json for failure comment.
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);

    expect(createComment).toHaveBeenCalledOnce();
    expect(createComment.mock.calls[0][0].body).toMatch(/Scan failed/);
    expect(createComment.mock.calls[0][0].body).toMatch(/boom/);
  });

  it("empty findings: posts a clean-scan comment", async () => {
    ddbMock.on(GetItemCommand).resolves({ Item: marshall(BASE_JOB) });
    const emptyResults = JSON.stringify({
      ...JSON.parse(RESULTS),
      summary: { total: 0, high: 0, medium: 0, low: 0 },
      findings: [],
    });
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToString: async () => emptyResults },
    });

    await handler({ job_id: BASE_JOB.job_id });

    expect(createComment.mock.calls[0][0].body).toMatch(
      /No vulnerabilities found/
    );
  });
});

describe("formatters (pure)", () => {
  it("formatSuccessComment includes severity counts and a findings table", () => {
    const body = formatSuccessComment(BASE_JOB, JSON.parse(RESULTS));
    expect(body).toMatch(/2 findings \(1 high, 1 medium, 0 low\)/);
    expect(body).toMatch(/SQL Injection/);
    expect(body).toMatch(/`src\/db\.js:42`/);
  });

  it("formatFailureComment shows the error and job id", () => {
    const body = formatFailureComment({ ...BASE_JOB, error: "no GH token" });
    expect(body).toMatch(/Scan failed/);
    expect(body).toMatch(/no GH token/);
    expect(body).toMatch(/test-job-1/);
  });
});
