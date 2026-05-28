# Step Functions state machine that orchestrates the scan pipeline.
#
# States: FetchCode -> RunScanner -> ReadJobSummary -> ExtractSummary ->
#   HighSeverityCheck -> [NotifyHighSeverity ->] PostComment -> Success
# Error catch on RunScanner / ReadJobSummary -> HandleFailure ->
#   PostFailureComment -> FailTerminal
#
# FetchCode, PostComment, PostFailureComment are Pass stubs until real
# Lambdas are deployed. Real wiring swaps them to Task / Lambda Invoke
# without touching the rest of the machine.
#
# Network configuration uses the default VPC; replace with a dedicated
# VPC + subnets when Person 2's networking module ships.

# ---- Default VPC / subnets / SG lookup ----

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_security_group" "default" {
  name   = "default"
  vpc_id = data.aws_vpc.default.id
}

# ---- Log group for state machine executions ----

resource "aws_cloudwatch_log_group" "sfn" {
  name              = "/aws/states/${var.project_name}-pipeline"
  retention_in_days = 7
}

# ---- State machine ----

resource "aws_sfn_state_machine" "pipeline" {
  name     = "${var.project_name}-pipeline"
  role_arn = data.aws_iam_role.lab.arn

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.sfn.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  definition = jsonencode({
    Comment = "SAST scan pipeline: fetch code -> scan -> comment"
    StartAt = "FetchCode"
    States = {
      # ---- fetch-code Lambda: GitHub API -> staging tarball ----
      FetchCode = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.fetch_code.arn
          "Payload.$"  = "$"
        }
        ResultPath = null
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "HandleFailure"
        }]
        Next = "RunScanner"
      }

      # ---- Fargate scanner task ----
      RunScanner = {
        Type     = "Task"
        Resource = "arn:aws:states:::ecs:runTask.sync"
        Parameters = {
          Cluster        = aws_ecs_cluster.sast.arn
          TaskDefinition = aws_ecs_task_definition.scanner.arn
          LaunchType     = "FARGATE"
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              Subnets        = data.aws_subnets.default.ids
              SecurityGroups = [data.aws_security_group.default.id]
              AssignPublicIp = "ENABLED"
            }
          }
          Overrides = {
            ContainerOverrides = [{
              Name = "scanner"
              Environment = [
                { Name = "JOB_ID", "Value.$" = "$.job_id" },
                { Name = "STAGING_BUCKET", Value = aws_s3_bucket.staging.id },
                { Name = "STAGING_KEY", "Value.$" = "States.Format('staging/{}/pr_files.tar.gz', $.job_id)" },
                { Name = "RESULTS_BUCKET", Value = aws_s3_bucket.results.id },
                { Name = "RESULTS_KEY", "Value.$" = "States.Format('results/{}/results.json', $.job_id)" },
                { Name = "JOBS_TABLE", Value = aws_dynamodb_table.jobs.name },
              ]
            }]
          }
        }
        ResultPath = null
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "HandleFailure"
        }]
        Next = "ReadJobSummary"
      }

      # ---- Read job row to get summary written by the scanner ----
      ReadJobSummary = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:getItem"
        Parameters = {
          TableName = aws_dynamodb_table.jobs.name
          Key = {
            job_id = { "S.$" = "$.job_id" }
          }
        }
        ResultPath = "$.job"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "HandleFailure"
        }]
        Next = "ExtractSummary"
      }

      # ---- Coerce DynamoDB N (string) into a real number for Choice ----
      ExtractSummary = {
        Type = "Pass"
        Parameters = {
          "high_count.$" = "States.StringToJson($.job.Item.summary.M.high.N)"
        }
        ResultPath = "$.severity"
        Next       = "HighSeverityCheck"
      }

      # ---- Branch on HIGH severity ----
      HighSeverityCheck = {
        Type = "Choice"
        Choices = [{
          Variable                 = "$.severity.high_count"
          NumericGreaterThanEquals = 1
          Next                     = "NotifyHighSeverity"
        }]
        Default = "PostComment"
      }

      # ---- SNS alert (HIGH branch) ----
      NotifyHighSeverity = {
        Type     = "Task"
        Resource = "arn:aws:states:::sns:publish"
        Parameters = {
          TopicArn  = aws_sns_topic.high_severity.arn
          Subject   = "HIGH severity vulnerabilities found in PR"
          "Message.$" = "States.Format('{}/{} PR #{} - {} HIGH severity findings. Job: {}', $.repo.owner, $.repo.name, $.pr_number, $.severity.high_count, $.job_id)"
        }
        ResultPath = null
        Next       = "PostComment"
      }

      # ---- post-comment Lambda (success branch): S3 results -> PR comment ----
      PostComment = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.post_comment.arn
          "Payload.$"  = "$"
        }
        ResultPath = null
        Next       = "Success"
      }

      Success = { Type = "Succeed" }

      # ---- Error path ----
      HandleFailure = {
        Type     = "Task"
        Resource = "arn:aws:states:::dynamodb:updateItem"
        Parameters = {
          TableName = aws_dynamodb_table.jobs.name
          Key = {
            job_id = { "S.$" = "$.job_id" }
          }
          UpdateExpression = "SET #s = :failed, #e = :err, updated_at = :now"
          ExpressionAttributeNames = {
            "#s" = "status"
            "#e" = "error"
          }
          ExpressionAttributeValues = {
            ":failed" = { "S" = "FAILED" }
            ":err"    = { "S.$" = "States.Format('{}', $.error.Cause)" }
            ":now"    = { "S.$" = "$$.State.EnteredTime" }
          }
        }
        ResultPath = null
        Next       = "PostFailureComment"
      }

      # ---- post-comment Lambda (failure branch): reads FAILED status + error, posts failure comment ----
      PostFailureComment = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.post_comment.arn
          "Payload.$"  = "$"
        }
        ResultPath = null
        Next       = "FailTerminal"
      }

      FailTerminal = { Type = "Fail" }
    }
  })
}
