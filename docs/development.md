# Development Conventions

## Local Lambda iteration

**Approach:** mocked unit tests for the inner loop, deploys to dev for integration testing. No SAM Local, no LocalStack.

### Test setup per Lambda

```
lambda/<name>/
├── index.js              # handler — exports `handler` function
├── index.test.js         # vitest unit tests
├── package.json          # dev deps: vitest, aws-sdk-client-mock
└── __fixtures__/         # sample event payloads (webhook bodies, Step Functions inputs, etc.)
```

### Stack

- **Test runner:** [vitest](https://vitest.dev/) — fast, native ESM, watch mode.
- **AWS SDK mocking:** [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock) — works with AWS SDK v3 clients.
- **AWS SDK:** v3 modular clients (`@aws-sdk/client-dynamodb`, `@aws-sdk/client-s3`, etc.) — not v2.

### Handler shape

Construct AWS clients at module scope so they can be mocked by `aws-sdk-client-mock`:

```js
// index.js
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({});

export const handler = async (event) => {
  await ddb.send(new PutItemCommand({ /* ... */ }));
  return { statusCode: 200 };
};
```

### Test shape

```js
// index.test.js
import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { handler } from "./index.js";

const ddbMock = mockClient(DynamoDBClient);

beforeEach(() => {
  ddbMock.reset();
});

describe("webhook-receiver", () => {
  it("creates a job when delivery_id is new", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutItemCommand).resolves({});

    const result = await handler(sampleWebhookEvent);

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(1);
  });

  it("returns 200 without creating a job when delivery_id already exists", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ job_id: { S: "existing" } }] });

    const result = await handler(sampleWebhookEvent);

    expect(result.statusCode).toBe(200);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });
});
```

### Running

From a Lambda directory:

```sh
npx vitest          # watch mode (default)
npx vitest run      # single run, for CI
```

### What this loop catches

- Handler logic and branching
- SDK call sequencing and parameters
- Error handling paths
- Input validation
- Output shape

### What this loop does NOT catch (requires dev deploy)

- IAM permission gaps
- API Gateway → Lambda payload mapping quirks
- Step Functions input/output transformation
- Real AWS service quirks (eventual consistency, throttling, region issues)
- Container packaging issues
- Cold start behavior

### Dev deploy & manual invoke

When integration matters, deploy to dev and invoke directly:

```sh
aws lambda invoke \
  --function-name sast-webhook-receiver-dev \
  --payload file://lambda/webhook-receiver/__fixtures__/github-webhook.json \
  --cli-binary-format raw-in-base64-out \
  out.json

cat out.json
```

For the full end-to-end (webhook → comment), open a real PR against a test repo where the GitHub App is installed.
