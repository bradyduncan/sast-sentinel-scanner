# SAST Sentinel Scanner

A GitHub App that scans pull requests for security vulnerabilities and posts findings as PR comments. Runs as a serverless pipeline on AWS: API Gateway → Lambda → Step Functions → Fargate scanner → S3 results → Lambda PR comment.

Course project for CS6620. Built on top of a regex-based SAST scanner originally from <https://github.com/aanchan/cs6620>.

## Architecture

Webhook arrives at API Gateway, a Lambda validates the GitHub HMAC signature and writes a job to DynamoDB, Step Functions orchestrates Fetch → Scan → Comment with retry/error branches, the scanner runs as a one-shot Fargate task, results land in S3, and a final Lambda posts the markdown comment. HIGH-severity findings additionally fan out to SNS for email alerts.

See [docs/architecture.md](docs/architecture.md) for the diagram and per-component explainer, and [docs/contracts.md](docs/contracts.md) for the data contracts between components (DynamoDB schema, job status lifecycle, S3 layout, scanner output JSON, Step Functions state I/O).

## Repository layout

```
sast-sentinel-scanner/
├── sast/backend/          Existing Node.js scanner — Express server for local dev,
│                          plus a batch CLI (cli.js) used by the Fargate task.
├── docker/                Dockerfile that wraps cli.js for the Fargate scanner.
├── lambda/
│   ├── webhook-receiver/  Validates HMAC, deduplicates by delivery_id, kicks off
│   │                      Step Functions. Tested with vitest + aws-sdk-client-mock.
│   ├── fetch-code/        (placeholder)
│   ├── post-comment/      (placeholder)
│   ├── get-status/        (placeholder)
│   ├── shared/            GitHub App JWT helper for the Lambdas that talk to GitHub.
│   └── _smoke/            Trivial Lambda used to validate deploy plumbing.
├── infrastructure/
│   ├── bootstrap/         One-shot Terraform that creates the remote state backend
│   │                      (S3 bucket + DynamoDB lock table) used by envs/dev.
│   ├── modules/iam/       Baseline IAM roles for Lambdas / Fargate / Step Functions.
│   │                      Kept as reference; not instantiated in the Learner Lab
│   │                      account because iam:CreateRole is blocked there.
│   └── envs/dev/          Single deployable environment. DynamoDB, S3, ECR,
│                          Secrets Manager, Fargate cluster + task, smoke Lambda.
└── docs/                  contracts.md, architecture.md, development.md
```

## Prerequisites

- AWS credentials with permission to create the resources in [infrastructure/envs/dev/](infrastructure/envs/dev/). In an AWS Academy Learner Lab account, that means using the lab-provided credentials and the pre-existing `LabRole`.
- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.6
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) v2
- [Docker](https://www.docker.com/products/docker-desktop/) (only required to build and push the scanner image)
- [Node.js](https://nodejs.org/) 20.x (for local scanner work and Lambda tests)

## Deploy from scratch

```sh
# 1. Bootstrap the remote state backend (runs once per account).
cd infrastructure/bootstrap
terraform init
terraform apply
terraform output  # copy state_bucket / lock_table / region into envs/dev/backend.tf

# 2. Deploy the dev environment.
cd ../envs/dev
terraform init
terraform apply

# 3. Build and push the scanner image.
cd ../../..
docker build -f docker/Dockerfile -t sast-scanner:dev sast/backend
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker tag sast-scanner:dev <account>.dkr.ecr.us-east-1.amazonaws.com/sast-sentinel-scanner:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/sast-sentinel-scanner:latest
```

Terraform outputs print every resource name and ARN you need (jobs table, buckets, ECR URL, smoke URL, task definition ARN).

## Local development

**Run the Express scanner server:**
```sh
cd sast/backend
npm install
npm run dev    # auto-restarts on save
```
POST to `http://localhost:3000/scan/code`, `/scan/file`, or `/scan/directory`. The HTTP server is for local development only; Fargate runs `cli.js` directly.

**Run the scanner CLI locally** (against a tarball and live AWS resources):
```sh
cd sast/backend
JOB_ID=local-$RANDOM \
STAGING_BUCKET=sast-sentinel-staging-<account> \
STAGING_KEY=staging/<job_id>/pr_files.tar.gz \
RESULTS_BUCKET=sast-sentinel-results-<account> \
RESULTS_KEY=results/<job_id>/results.json \
JOBS_TABLE=sast-sentinel-jobs \
node cli.js
```

**Run a Lambda test suite:**
```sh
cd lambda/webhook-receiver
npm install
npm test
```

See [docs/development.md](docs/development.md) for the local Lambda iteration approach (vitest + aws-sdk-client-mock, with deploys to dev for integration testing).

## End-to-end Fargate smoke test

The scanner runs end-to-end without Step Functions by manually invoking the task with container overrides:

1. Make a tarball with sample code.
2. Upload to `s3://<staging-bucket>/staging/<job_id>/pr_files.tar.gz`.
3. Seed a `sast-sentinel-jobs` item with `repo_owner`, `repo_name`, `pr_number`, `commit_sha`, `installation_id`, and `status=FETCHING`.
4. `aws ecs run-task --cluster sast-sentinel --task-definition sast-sentinel-scanner --launch-type FARGATE --network-configuration ... --overrides '{"containerOverrides":[{"name":"scanner","environment":[…]}]}'`
5. Check CloudWatch (`/ecs/sast-sentinel-scanner`), the results bucket, and the DynamoDB item.

## Current status

| Component | State |
|---|---|
| Terraform remote state backend | deployed |
| DynamoDB jobs table (+ delivery-id GSI) | deployed |
| S3 staging + results buckets | deployed |
| ECR scanner repo + image | deployed |
| Secrets Manager (webhook secret + GitHub App private key) | deployed, populated |
| Smoke Lambda + API Gateway | deployed |
| Fargate cluster + task definition | deployed, smoke-tested end-to-end |
| Step Functions state machine | deployed |
| fetch-code Lambda | deployed |
| post-comment Lambda | deployed |
| SNS topic + email alert | deployed |
| webhook-receiver Lambda + `POST /webhook` route | deployed, tested on `sast-sentinel-scanner` GitHub org's [cs6620 fork](https://github.com/sast-sentinel-scanner/cs6620) |
| GitHub App registration | registered under `sast-sentinel-scanner` GitHub org |
| End-to-end PR test against a real repo | performed, tested on `sast-sentinel-scanner` GitHub org's [cs6620 fork](https://github.com/sast-sentinel-scanner/cs6620) |

## Notes on the deployment account

This project deploys into an AWS Academy Learner Lab account, which blocks `iam:CreateRole` and uses short-lived (~4h) credentials. Every IAM role reference uses the pre-existing `LabRole`. When the lab session expires, re-grab the credentials from the lab page → AWS Details → AWS CLI → Show, and re-paste them into `~/.aws/credentials` (no extension, no quotes, `[default]` header, all three lines).
