# Baseline IAM roles for the SAST pipeline.
#
# Roles created:
#   * lambda_exec       — shared Lambda execution role (CloudWatch Logs + per-Lambda
#                         policies attached inline by callers when needed).
#   * fargate_task      — application role assumed by the running scanner container.
#                         Reads from the staging bucket, writes to results bucket,
#                         reads/writes the jobs table.
#   * fargate_task_exec — ECS-managed role used by the agent to pull the image
#                         from ECR and ship container logs to CloudWatch.
#   * step_functions    — state-machine role: invoke Lambdas, RunTask on ECS,
#                         read/write DynamoDB, publish SNS.
#
# Bucket / table / topic / state-machine ARNs are passed in so this module
# stays decoupled from envs/dev/ resource names.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_partition" "current" {}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.name
  account_id = data.aws_caller_identity.current.account_id
}

# ---------------------------------------------------------------------
# Lambda execution role (shared by all Lambdas)
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "${var.project_name}-lambda-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Basic CloudWatch Logs permissions (matches AWSLambdaBasicExecutionRole).
resource "aws_iam_role_policy_attachment" "lambda_basic_logs" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Pipeline-specific permissions for the Lambdas in this project.
data "aws_iam_policy_document" "lambda_pipeline" {
  # DynamoDB: read + write the jobs table and query the delivery-id GSI.
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = [
      var.jobs_table_arn,
      "${var.jobs_table_arn}/index/*",
    ]
  }

  # S3: read PR code from staging, read scan results.
  statement {
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:ListBucket",
    ]
    resources = [
      var.staging_bucket_arn,
      "${var.staging_bucket_arn}/*",
      var.results_bucket_arn,
      "${var.results_bucket_arn}/*",
    ]
  }

  # Secrets Manager: read GitHub App key + webhook HMAC secret.
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = var.secret_arns
  }

  # Step Functions: webhook-receiver kicks off executions.
  statement {
    effect    = "Allow"
    actions   = ["states:StartExecution"]
    resources = [var.state_machine_arn]
  }
}

resource "aws_iam_role_policy" "lambda_pipeline" {
  name   = "${var.project_name}-lambda-pipeline"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_pipeline.json
}

# ---------------------------------------------------------------------
# Fargate task role (application — used by the scanner container)
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "fargate_task" {
  name               = "${var.project_name}-fargate-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "fargate_task" {
  # Read code from staging.
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${var.staging_bucket_arn}/*"]
  }

  # Write results.
  statement {
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${var.results_bucket_arn}/*"]
  }

  # Update job status / summary in DynamoDB.
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:UpdateItem",
      "dynamodb:GetItem",
    ]
    resources = [var.jobs_table_arn]
  }
}

resource "aws_iam_role_policy" "fargate_task" {
  name   = "${var.project_name}-fargate-task"
  role   = aws_iam_role.fargate_task.id
  policy = data.aws_iam_policy_document.fargate_task.json
}

# ---------------------------------------------------------------------
# Fargate task execution role (ECS agent — image pull + log shipping)
# ---------------------------------------------------------------------

resource "aws_iam_role" "fargate_task_exec" {
  name               = "${var.project_name}-fargate-task-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "fargate_task_exec_managed" {
  role       = aws_iam_role.fargate_task_exec.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ---------------------------------------------------------------------
# Step Functions role
# ---------------------------------------------------------------------

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "step_functions" {
  name               = "${var.project_name}-step-functions"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "step_functions" {
  # Invoke the pipeline Lambdas.
  statement {
    effect    = "Allow"
    actions   = ["lambda:InvokeFunction"]
    resources = var.lambda_function_arns
  }

  # ECS RunTask (.sync) for the Fargate scanner + PassRole for the two task roles.
  statement {
    effect    = "Allow"
    actions   = ["ecs:RunTask", "ecs:StopTask", "ecs:DescribeTasks"]
    resources = ["*"]
  }
  statement {
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.fargate_task.arn,
      aws_iam_role.fargate_task_exec.arn,
    ]
  }

  # Required for ecs:runTask.sync managed-rule wiring.
  statement {
    effect = "Allow"
    actions = [
      "events:PutTargets",
      "events:PutRule",
      "events:DescribeRule",
    ]
    resources = ["arn:${local.partition}:events:${local.region}:${local.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"]
  }

  # DynamoDB SDK integration: read summary, update on failure path.
  statement {
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:UpdateItem",
    ]
    resources = [var.jobs_table_arn]
  }

  # SNS publish for HIGH-severity branch.
  statement {
    effect    = "Allow"
    actions   = ["sns:Publish"]
    resources = [var.high_severity_topic_arn]
  }
}

resource "aws_iam_role_policy" "step_functions" {
  name   = "${var.project_name}-step-functions"
  role   = aws_iam_role.step_functions.id
  policy = data.aws_iam_policy_document.step_functions.json
}
