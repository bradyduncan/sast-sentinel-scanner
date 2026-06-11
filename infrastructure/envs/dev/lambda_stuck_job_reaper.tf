# stuck-job-reaper Lambda + EventBridge schedule.
#
# An hourly schedule fires the Lambda; the Lambda scans the jobs table
# for items in non-terminal states (PENDING/FETCHING/SCANNING/COMMENTING)
# whose updated_at is older than STUCK_THRESHOLD_HOURS, marks them
# FAILED in DynamoDB, and publishes a summary alert to the existing
# failures SNS topic.

data "archive_file" "stuck_job_reaper" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lambda/stuck-job-reaper"
  output_path = "${path.module}/.build/stuck-job-reaper.zip"
  excludes = [
    "index.test.js",
    "package-lock.json",
  ]
}

resource "aws_lambda_function" "stuck_job_reaper" {
  function_name    = "${var.project_name}-stuck-job-reaper"
  role             = data.aws_iam_role.lab.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.stuck_job_reaper.output_path
  source_code_hash = data.archive_file.stuck_job_reaper.output_base64sha256
  timeout          = 30
  memory_size      = 256

  environment {
    variables = {
      JOBS_TABLE            = aws_dynamodb_table.jobs.name
      FAILURES_TOPIC_ARN    = aws_sns_topic.failures.arn
      STUCK_THRESHOLD_HOURS = "1"
    }
  }
}

resource "aws_cloudwatch_log_group" "stuck_job_reaper" {
  name              = "/aws/lambda/${aws_lambda_function.stuck_job_reaper.function_name}"
  retention_in_days = 7
}

# ---- EventBridge schedule: invoke the reaper every hour ----

resource "aws_cloudwatch_event_rule" "stuck_job_reaper_schedule" {
  name                = "${var.project_name}-stuck-job-reaper-schedule"
  description         = "Hourly trigger for the stuck-job-reaper Lambda."
  schedule_expression = "rate(1 hour)"
}

resource "aws_cloudwatch_event_target" "stuck_job_reaper" {
  rule      = aws_cloudwatch_event_rule.stuck_job_reaper_schedule.name
  target_id = "stuck-job-reaper"
  arn       = aws_lambda_function.stuck_job_reaper.arn
}

resource "aws_lambda_permission" "stuck_job_reaper_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.stuck_job_reaper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.stuck_job_reaper_schedule.arn
}
