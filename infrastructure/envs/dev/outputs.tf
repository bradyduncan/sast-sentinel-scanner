output "jobs_table_name" {
  description = "Name of the DynamoDB jobs table."
  value       = aws_dynamodb_table.jobs.name
}

output "jobs_table_arn" {
  description = "ARN of the DynamoDB jobs table."
  value       = aws_dynamodb_table.jobs.arn
}

output "staging_bucket_name" {
  description = "Name of the staging S3 bucket."
  value       = aws_s3_bucket.staging.id
}

output "results_bucket_name" {
  description = "Name of the results S3 bucket."
  value       = aws_s3_bucket.results.id
}

output "scanner_ecr_repo_url" {
  description = "URI of the scanner ECR repository (use for docker push)."
  value       = aws_ecr_repository.scanner.repository_url
}

output "webhook_secret_arn" {
  description = "ARN of the webhook HMAC Secrets Manager secret."
  value       = aws_secretsmanager_secret.webhook_secret.arn
}

output "github_app_private_key_arn" {
  description = "ARN of the GitHub App private key Secrets Manager secret."
  value       = aws_secretsmanager_secret.github_app_private_key.arn
}

output "smoke_url" {
  description = "Invoke URL for the smoke Lambda. curl <url>/smoke to exercise Lambda → DynamoDB."
  value       = "${aws_apigatewayv2_api.smoke.api_endpoint}/smoke"
}
