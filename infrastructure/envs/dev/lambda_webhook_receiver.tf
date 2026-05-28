# webhook-receiver Lambda + POST /webhook route on the existing HTTP API.
# Validates GitHub HMAC, deduplicates by delivery_id, writes job row,
# and starts the Step Functions execution.

data "archive_file" "webhook_receiver" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lambda/webhook-receiver"
  output_path = "${path.module}/.build/webhook-receiver.zip"
  excludes = [
    "index.test.js",
    "package-lock.json",
    "__fixtures__",
    "__fixtures__/github-pr-opened.json",
  ]
}

resource "aws_lambda_function" "webhook_receiver" {
  function_name    = "${var.project_name}-webhook-receiver"
  role             = data.aws_iam_role.lab.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.webhook_receiver.output_path
  source_code_hash = data.archive_file.webhook_receiver.output_base64sha256
  timeout          = 10
  memory_size      = 256

  environment {
    variables = {
      JOBS_TABLE        = aws_dynamodb_table.jobs.name
      DELIVERY_ID_INDEX = "delivery-id-index"
      STATE_MACHINE_ARN = aws_sfn_state_machine.pipeline.arn
      WEBHOOK_SECRET_ID = aws_secretsmanager_secret.webhook_secret.id
    }
  }
}

resource "aws_cloudwatch_log_group" "webhook_receiver" {
  name              = "/aws/lambda/${aws_lambda_function.webhook_receiver.function_name}"
  retention_in_days = 7
}

# ---- HTTP API route: POST /webhook on the existing API ----

resource "aws_apigatewayv2_integration" "webhook" {
  api_id                 = aws_apigatewayv2_api.smoke.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.webhook_receiver.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "webhook" {
  api_id    = aws_apigatewayv2_api.smoke.id
  route_key = "POST /webhook"
  target    = "integrations/${aws_apigatewayv2_integration.webhook.id}"
}

resource "aws_lambda_permission" "webhook_apigw" {
  statement_id  = "AllowAPIGWInvokeWebhook"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhook_receiver.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.smoke.execution_arn}/*/*"
}
