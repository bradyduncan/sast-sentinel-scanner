output "state_bucket" {
  description = "S3 bucket name for Terraform remote state. Copy into envs/dev/backend.tf."
  value       = aws_s3_bucket.tf_state.id
}

output "lock_table" {
  description = "DynamoDB table name for Terraform state locking. Copy into envs/dev/backend.tf."
  value       = aws_dynamodb_table.tf_lock.name
}

output "region" {
  description = "Region the state backend lives in."
  value       = var.region
}
