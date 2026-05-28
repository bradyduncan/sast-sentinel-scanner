import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "fs";

import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

import {
  handler,
  _resetAuthCache,
  _setAppFactory,
} from "./index.js";

const ddbMock = mockClient(DynamoDBClient);
const s3Mock = mockClient(S3Client);
const secretsMock = mockClient(SecretsManagerClient);

const SFN_INPUT = JSON.parse(
  readFileSync(new URL("./__fixtures__/sfn-input.json", import.meta.url), "utf-8")
);

const REQUIRED_ENV = {
  GITHUB_APP_ID: "111",
  GITHUB_APP_PRIVATE_KEY_SECRET_ID: "sast-sentinel/github-app-private-key",
  JOBS_TABLE: "sast-sentinel-jobs",
  STAGING_BUCKET: "sast-sentinel-staging-test",
};

let savedEnv;

function makeFakeOctokit({ files = [], contentByPath = {} } = {}) {
  return {
    paginate: {
      iterator: async function* () {
        yield { data: files };
      },
    },
    rest: {
      pulls: { listFiles: vi.fn() },
      repos: {
        getContent: vi.fn(async ({ path }) => ({
          data: {
            type: "file",
            content: Buffer.from(contentByPath[path] || "// hi", "utf-8").toString(
              "base64"
            ),
          },
        })),
      },
    },
  };
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
    .resolves({ SecretString: "fake-private-key-pem" });
  ddbMock.on(UpdateItemCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("handler", () => {
  it("throws when required env vars are missing", async () => {
    delete process.env.JOBS_TABLE;
    await expect(handler(SFN_INPUT)).rejects.toThrow(/Missing required env vars/);
  });

  it("throws when execution context lacks required fields", async () => {
    const bad = { ...SFN_INPUT, installation_id: undefined };
    await expect(handler(bad)).rejects.toThrow(/Missing required fields/);
  });

  it("marks FETCHING, fetches files, uploads tarball, returns input unchanged", async () => {
    const octokit = makeFakeOctokit({
      files: [
        { filename: "src/users.js", status: "added" },
        { filename: "lib/db.js", status: "modified" },
      ],
      contentByPath: {
        "src/users.js": "const x = 1;",
        "lib/db.js": "module.exports = {};",
      },
    });
    _setAppFactory(() => ({ getInstallationOctokit: async () => octokit }));

    const result = await handler(SFN_INPUT);

    expect(result).toEqual(SFN_INPUT); // pass-through

    const updates = ddbMock.commandCalls(UpdateItemCommand);
    expect(updates).toHaveLength(1);
    expect(
      updates[0].args[0].input.ExpressionAttributeValues[":status"].S
    ).toBe("FETCHING");

    const puts = s3Mock.commandCalls(PutObjectCommand);
    expect(puts).toHaveLength(1);
    expect(puts[0].args[0].input.Key).toBe(
      "staging/test-job-1/pr_files.tar.gz"
    );
    expect(puts[0].args[0].input.Bucket).toBe(REQUIRED_ENV.STAGING_BUCKET);
  });

  it("skips deleted files", async () => {
    const getContent = vi.fn(async ({ path }) => ({
      data: { type: "file", content: Buffer.from("// x", "utf-8").toString("base64") },
    }));
    const octokit = {
      paginate: {
        iterator: async function* () {
          yield {
            data: [
              { filename: "kept.js", status: "modified" },
              { filename: "gone.js", status: "removed" },
            ],
          };
        },
      },
      rest: {
        pulls: { listFiles: vi.fn() },
        repos: { getContent },
      },
    };
    _setAppFactory(() => ({ getInstallationOctokit: async () => octokit }));

    await handler(SFN_INPUT);

    expect(getContent).toHaveBeenCalledTimes(1);
    expect(getContent.mock.calls[0][0].path).toBe("kept.js");
  });

  it("marks FAILED and re-throws when GitHub API errors", async () => {
    const octokit = {
      paginate: {
        iterator: async function* () {
          throw new Error("github 500");
        },
      },
      rest: { pulls: { listFiles: vi.fn() }, repos: { getContent: vi.fn() } },
    };
    _setAppFactory(() => ({ getInstallationOctokit: async () => octokit }));

    await expect(handler(SFN_INPUT)).rejects.toThrow(/github 500/);

    const updates = ddbMock.commandCalls(UpdateItemCommand);
    expect(updates).toHaveLength(2); // FETCHING then FAILED
    const failed = updates[1].args[0].input.ExpressionAttributeValues;
    expect(failed[":status"].S).toBe("FAILED");
    expect(failed[":err"].S).toBe("github 500");
  });

  it("caches the private key across invocations", async () => {
    const octokit = makeFakeOctokit({
      files: [{ filename: "a.js", status: "added" }],
    });
    _setAppFactory(() => ({ getInstallationOctokit: async () => octokit }));

    await handler(SFN_INPUT);
    await handler({ ...SFN_INPUT, job_id: "test-job-2" });

    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
});
