# post-comment Lambda.
# Step Functions PostComment + PostFailureComment states both invoke this
# Lambda. Internal branch on DynamoDB job.status: SCANNING -> success
# comment + transition to DONE; FAILED -> failure comment, no status change.

data "archive_file" "post_comment" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lambda/post-comment"
  output_path = "${path.module}/.build/post-comment.zip"
  excludes = [
    "index.test.js",
    "package-lock.json",
    "__fixtures__",
    "__fixtures__/results.json",
  ]
}

resource "aws_lambda_function" "post_comment" {
  function_name    = "${var.project_name}-post-comment"
  role             = data.aws_iam_role.lab.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.post_comment.output_path
  source_code_hash = data.archive_file.post_comment.output_base64sha256
  timeout          = 60
  memory_size      = 256

  environment {
    variables = {
      GITHUB_APP_ID                    = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_SECRET_ID = aws_secretsmanager_secret.github_app_private_key.id
      JOBS_TABLE                       = aws_dynamodb_table.jobs.name
      RESULTS_BUCKET                   = aws_s3_bucket.results.id
    }
  }
}

resource "aws_cloudwatch_log_group" "post_comment" {
  name              = "/aws/lambda/${aws_lambda_function.post_comment.function_name}"
  retention_in_days = 7
}
