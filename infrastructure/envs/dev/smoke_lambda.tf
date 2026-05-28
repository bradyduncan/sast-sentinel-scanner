# Smoke Lambda + HTTP API Gateway.
# Single artifact that exercises Lambda exec, API GW → Lambda, and Lambda → DynamoDB.
# Delete this file (and the lambda/_smoke/ dir) once real Lambdas exist.
#
# Note: AWS Academy Learner Lab blocks iam:CreateRole. Reuses the pre-existing
# LabRole for execution. LabRole already has the permissions a smoke check needs.

data "aws_iam_role" "lab" {
  name = "LabRole"
}

# ---- Package source ----

data "archive_file" "smoke" {
  type        = "zip"
  source_dir  = "${path.module}/../../../lambda/_smoke"
  output_path = "${path.module}/.build/smoke.zip"
}

# ---- Lambda function ----

resource "aws_lambda_function" "smoke" {
  function_name    = "${var.project_name}-smoke"
  role             = data.aws_iam_role.lab.arn
  handler          = "index.handler"
  runtime          = "nodejs20.x"
  filename         = data.archive_file.smoke.output_path
  source_code_hash = data.archive_file.smoke.output_base64sha256
  timeout          = 10

  environment {
    variables = {
      JOBS_TABLE = aws_dynamodb_table.jobs.name
    }
  }
}

resource "aws_cloudwatch_log_group" "smoke" {
  name              = "/aws/lambda/${aws_lambda_function.smoke.function_name}"
  retention_in_days = 7
}

# ---- HTTP API Gateway ----

resource "aws_apigatewayv2_api" "smoke" {
  name          = "${var.project_name}-smoke"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "smoke" {
  api_id                 = aws_apigatewayv2_api.smoke.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.smoke.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "smoke" {
  api_id    = aws_apigatewayv2_api.smoke.id
  route_key = "GET /smoke"
  target    = "integrations/${aws_apigatewayv2_integration.smoke.id}"
}

resource "aws_apigatewayv2_stage" "smoke_default" {
  api_id      = aws_apigatewayv2_api.smoke.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "smoke_apigw" {
  statement_id  = "AllowAPIGWInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.smoke.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.smoke.execution_arn}/*/*"
}
