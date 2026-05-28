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
