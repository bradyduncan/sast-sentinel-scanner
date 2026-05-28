import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { readFileSync } from "fs";

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { marshall } from "@aws-sdk/util-dynamodb";

import { handler, verifySignature, _resetSecretCache } from "./index.js";

const ddbMock = mockClient(DynamoDBClient);
const sfnMock = mockClient(SFNClient);
const secretsMock = mockClient(SecretsManagerClient);

const WEBHOOK_SECRET = "test-secret";
const VALID_PAYLOAD = readFileSync(
  new URL("./__fixtures__/github-pr-opened.json", import.meta.url),
  "utf-8"
);

function sign(body, secret = WEBHOOK_SECRET) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function makeEvent({ body = VALID_PAYLOAD, headers = {}, ...overrides } = {}) {
  return {
    body,
    headers: {
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(body),
      ...headers,
    },
    ...overrides,
  };
}

const REQUIRED_ENV = {
  JOBS_TABLE: "sast-jobs",
  DELIVERY_ID_INDEX: "delivery-id-index",
  STATE_MACHINE_ARN: "arn:aws:states:us-east-1:123:stateMachine:sast",
  WEBHOOK_SECRET_ID: "sast/webhook-secret",
};

let savedEnv;

beforeEach(() => {
  ddbMock.reset();
  sfnMock.reset();
  secretsMock.reset();
  _resetSecretCache();

  savedEnv = {};
  for (const [k, v] of Object.entries(REQUIRED_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }

  // Default mocks for the happy path.
  secretsMock
    .on(GetSecretValueCommand)
    .resolves({ SecretString: WEBHOOK_SECRET });
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(PutItemCommand).resolves({});
  sfnMock.on(StartExecutionCommand).resolves({
    executionArn: "arn:aws:states:us-east-1:123:execution:sast:job-1",
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("verifySignature (unit)", () => {
  it("returns true for a valid sha256 HMAC", () => {
    const body = "hello";
    expect(verifySignature(body, sign(body), WEBHOOK_SECRET)).toBe(true);
  });

  it("returns false when the header is missing the sha256= prefix", () => {
    expect(verifySignature("hello", "deadbeef", WEBHOOK_SECRET)).toBe(false);
  });

  it("returns false when the body is tampered with", () => {
    expect(verifySignature("tampered", sign("hello"), WEBHOOK_SECRET)).toBe(
      false
    );
  });
});

describe("handler", () => {
  it("returns 500 when required env vars are missing", async () => {
    delete process.env.JOBS_TABLE;
    const resp = await handler(makeEvent());
    expect(resp.statusCode).toBe(500);
  });

  it("returns 400 when X-GitHub-Delivery header is missing", async () => {
    const event = makeEvent();
    delete event.headers["x-github-delivery"];
    const resp = await handler(event);
    expect(resp.statusCode).toBe(400);
  });

  it("returns 401 on invalid signature", async () => {
    const event = makeEvent({
      headers: { "x-hub-signature-256": "sha256=deadbeef" },
    });
    const resp = await handler(event);
    expect(resp.statusCode).toBe(401);
  });

  it("returns 200 and ignores non-pull_request events", async () => {
    const event = makeEvent({ headers: { "x-github-event": "push" } });
    const resp = await handler(event);
    expect(resp.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("returns 200 and ignores irrelevant PR actions (e.g., closed)", async () => {
    const payload = JSON.parse(VALID_PAYLOAD);
    payload.action = "closed";
    const body = JSON.stringify(payload);
    const resp = await handler(
      makeEvent({
        body,
        headers: { "x-hub-signature-256": sign(body) },
      })
    );
    expect(resp.statusCode).toBe(200);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("returns 400 on missing payload fields (no installation id)", async () => {
    const payload = JSON.parse(VALID_PAYLOAD);
    delete payload.installation;
    const body = JSON.stringify(payload);
    const resp = await handler(
      makeEvent({
        body,
        headers: { "x-hub-signature-256": sign(body) },
      })
    );
    expect(resp.statusCode).toBe(400);
  });

  it("returns 200 without side effects on duplicate delivery", async () => {
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [marshall({ job_id: "existing" })] });
    const resp = await handler(makeEvent());
    expect(resp.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(sfnMock.commandCalls(StartExecutionCommand)).toHaveLength(0);
  });

  it("creates a job and starts Step Functions on the happy path", async () => {
    const resp = await handler(makeEvent());

    expect(resp.statusCode).toBe(202);

    const puts = ddbMock.commandCalls(PutItemCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item;
    expect(item.status.S).toBe("PENDING");
    expect(item.delivery_id.S).toBe("delivery-1");
    expect(item.repo_owner.S).toBe("anthropics");
    expect(item.repo_name.S).toBe("claude-code");
    expect(Number(item.pr_number.N)).toBe(42);
    expect(item.commit_sha.S).toBe("abc1234567890abcdef1234567890abcdef12345");
    expect(Number(item.installation_id.N)).toBe(12345);

    const executions = sfnMock.commandCalls(StartExecutionCommand);
    expect(executions).toHaveLength(1);
    const exInput = executions[0].args[0].input;
    expect(exInput.stateMachineArn).toBe(REQUIRED_ENV.STATE_MACHINE_ARN);
    const parsed = JSON.parse(exInput.input);
    expect(parsed.repo).toEqual({ owner: "anthropics", name: "claude-code" });
    expect(parsed.pr_number).toBe(42);
  });

  it("caches the webhook secret across invocations", async () => {
    await handler(makeEvent());
    await handler(makeEvent({ headers: { "x-github-delivery": "delivery-2" } }));
    expect(secretsMock.commandCalls(GetSecretValueCommand)).toHaveLength(1);
  });
});
