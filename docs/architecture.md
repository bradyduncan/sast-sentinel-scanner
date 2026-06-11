# Architecture

_TODO: drop the architecture diagram image here and add a paragraph-per-component explainer._

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

## IAM design

The pipeline is designed around four least-privilege IAM roles. However, in the production environment, every component uses the lab-provided `LabRole` because AWS Academy Learner Lab restricts `iam:CreateRole`. 

The intended design lives in [`infrastructure/modules/iam/main.tf`](../infrastructure/modules/iam/main.tf) for reference. This module is not instantiated in the deployed infrastructure due to the mentioned IAM restrictions.

| Role | Components | Permissions |
|---|---|---|
| `lambda_exec` (shared) | webhook-receiver, fetch-code, post-comment, get-status | CloudWatch Logs; DynamoDB `GetItem`/`PutItem`/`UpdateItem`/`Query` on jobs table + GSI; S3 Get/Put on staging + results; Secrets Manager `GetSecretValue` on App key + webhook secret; Step Functions `StartExecution` |
| `fargate_task` | scanner container (application role) | S3 `GetObject` from staging; S3 `PutObject` to results; DynamoDB `GetItem`/`UpdateItem` on jobs |
| `fargate_task_exec` | scanner container (ECS agent role) | `AmazonECSTaskExecutionRolePolicy` (managed) — ECR pull + CloudWatch Logs |
| `step_functions` | state machine | Lambda `InvokeFunction`; ECS `RunTask`/`StopTask`/`DescribeTasks`; `iam:PassRole` on Fargate roles; EventBridge rule management for `ecs:runTask.sync`; DynamoDB `GetItem`/`UpdateItem`; SNS `Publish` on high-severity topic |

In Learner Lab, all four are collapsed into `LabRole`, which provides a broader set of permissions sufficient to cover the component's needs.

## Retries & failure alerts

Step Functions retries transient errors on an interval basis (For example, BackoffRate: 2.0, retries after 5 seconds, then 10 seconds, then 20 seconds) before considering a task as failed. Each Task state has its own `Retry` block:

| State | Retry on | Reason |
|---|---|---|
| `FetchCode` (Lambda) | `Lambda.ServiceException`, `Lambda.AWSLambdaException`, `Lambda.SdkClientException`, `Lambda.TooManyRequestsException` | GitHub API rate limits, transient AWS Lambda issues |
| `RunScanner` (ECS) | `ECS.AmazonECSException`, `States.TaskFailed` | Fargate cold-start, ECR pull blips |
| `ReadJobSummary` (DynamoDB) | `States.TaskFailed` | DynamoDB hiccups |
| `PostComment` / `PostFailureComment` (Lambda) | Same as `FetchCode` | GitHub API for comment posting |

Each Task retries up to **3 times**. If all retries exhaust (or the error is non-transient and not in `ErrorEquals`), the `Catch` routes the job through the failure path:

```
... → HandleFailure → NotifyFailure → PostFailureComment → FailTerminal
```

The failure path:

1. **`HandleFailure`** — `dynamodb:updateItem` sets `status = FAILED` and stores the error message on the job row.
2. **`NotifyFailure`** — `sns:publish` to the `sast-sentinel-failures` topic. Email subscribers (configured via `var.alert_email`) get notified.
3. **`PostFailureComment`** — invokes post-comment Lambda to post a failure comment on the PR. This Lambda also has its own `Retry` block in case posting the failure comment itself hits a transient error.
4. **`FailTerminal`** — terminal `Fail` state.

**No alerts fire during retries themselves** — only on final failure after all retries are exhausted. This avoids noisy alerts during normal transient hiccups while ensuring real failures notify subscribers.

## Networking

The Fargate scanner task runs in a **private subnet** with no public IP. Outbound traffic to AWS service endpoints (ECR for image pull, S3 for staging + results, DynamoDB for job state, CloudWatch for logs) is routed through a **NAT Gateway** that lives in a public subnet.

```
VPC 10.0.0.0/16
├── Public subnets   (10.0.0.0/24, 10.0.1.0/24)   across 2 AZs
│   └── NAT Gateway in public[0]
├── Private subnets                               across 2 AZs
│   └── Fargate task placed here (ECS picks an AZ at runtime)
├── Internet Gateway (default route for public subnets)
└── Route tables
    ├── public-rt:  0.0.0.0/0 → IGW
    └── private-rt: 0.0.0.0/0 → NAT Gateway
```

| Item | Where it's wired |
|---|---|
| VPC + subnets + IGW + NAT + route tables + Fargate SG | [`vpc.tf`](../infrastructure/envs/dev/vpc.tf) |
| Fargate task network config | [`stepfunctions.tf`](../infrastructure/envs/dev/stepfunctions.tf) — `Subnets = aws_subnet.private[*].id`, `SecurityGroups = [aws_security_group.fargate.id]`, `AssignPublicIp = "DISABLED"` |
| Outbound rule | `aws_security_group.fargate` allows TCP 443 to `0.0.0.0/0` (NAT then routes to the AWS service endpoints) |

### Design choice of having only one NAT gateway

**2 AZs:** if one AZ has an outage, ECS places the task in the other. 
**A single NAT Gateway:**: a failure in the AZ hosting the NAT would isolate Fargate even though there's a healthy private subnet in the other AZ.

For production, the standard pattern is one NAT per AZ (each private subnet routing to its same-AZ NAT). For the class scope and Learner Lab credit constraints, this architecture uses one NAT gateway.

### Cost-saving destroy/recreate

To avoid idle AWS costs, between testing sessions the NAT and its Elastic IP can be destroyed independently:

```sh
terraform destroy \
  -target=aws_route.private_nat \
  -target=aws_nat_gateway.main \
  -target=aws_eip.nat
# ...later, to bring it back:
terraform apply
```

This is why the NAT-bound default route is defined as a separate `aws_route` resource rather than inline in `aws_route_table.private`. It lets the route be destroyed alongside the NAT without tearing down the route table.