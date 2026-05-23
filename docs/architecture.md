# Architecture

_TODO (Week 0): drop the architecture diagram image here and add a paragraph-per-component explainer._

## Component summary

- **API Gateway** — HTTPS + throttling for the webhook endpoint.
- **webhook-receiver Lambda** — validates HMAC signature, writes job to DynamoDB, kicks Step Functions.
- **Step Functions** — orchestrates fetch → scan → comment with retry/error branches.
- **fetch-code Lambda** — uses GitHub App auth to download PR code into S3 staging.
- **ECS Fargate (SAST scanner)** — pulls image from ECR, scans code from S3, writes results JSON to S3.
- **post-comment Lambda** — reads results, formats markdown, posts PR comment.
- **get-status Lambda** — debug/polling endpoint backed by DynamoDB.
- **SNS + Email** — fires when scan finds HIGH-severity vulnerabilities.
- **Secrets Manager** — holds GitHub App private key + webhook HMAC secret.
- **CloudWatch** — logs from Lambda, Step Functions, Fargate, API Gateway.
