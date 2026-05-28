# fetch-code Lambda.
# Step Functions FetchCode state invokes this. Reads PR-changed files from
# GitHub, bundles into staging/<job_id>/pr_files.tar.gz. Uses LabRole.

data "archive_file" "fetch_code" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lambda/fetch-code"
  output_path = "${path.module}/.build/fetch-code.zip"
  excludes = [
    "index.test.js",
    "package-lock.json",
    "__fixtures__",
    "__fixtures__/sfn-input.json",
  ]
}

resource "aws_lambda_function" "fetch_code" {
  function_name    = "${var.project_name}-fetch-code"
  role             = data.aws_iam_role.lab.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.fetch_code.output_path
  source_code_hash = data.archive_file.fetch_code.output_base64sha256
  timeout          = 120
  memory_size      = 512

  environment {
    variables = {
      GITHUB_APP_ID                    = var.github_app_id
      GITHUB_APP_PRIVATE_KEY_SECRET_ID = aws_secretsmanager_secret.github_app_private_key.id
      JOBS_TABLE                       = aws_dynamodb_table.jobs.name
      STAGING_BUCKET                   = aws_s3_bucket.staging.id
    }
  }
}

resource "aws_cloudwatch_log_group" "fetch_code" {
  name              = "/aws/lambda/${aws_lambda_function.fetch_code.function_name}"
  retention_in_days = 7
}
