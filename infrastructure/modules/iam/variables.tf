variable "project_name" {
  description = "Project name prefix for role names."
  type        = string
}

variable "jobs_table_arn" {
  description = "ARN of the DynamoDB jobs table. The GSI ARN is derived as ${jobs_table_arn}/index/*."
  type        = string
}

variable "staging_bucket_arn" {
  description = "ARN of the staging S3 bucket (PR source code)."
  type        = string
}

variable "results_bucket_arn" {
  description = "ARN of the results S3 bucket (scan output JSON)."
  type        = string
}

variable "secret_arns" {
  description = "ARNs of Secrets Manager secrets Lambdas need to read (webhook HMAC, GitHub App private key)."
  type        = list(string)
}

variable "state_machine_arn" {
  description = "ARN of the Step Functions state machine. webhook-receiver gets StartExecution on this."
  type        = string
}

variable "lambda_function_arns" {
  description = "ARNs of the Lambdas Step Functions invokes (fetch-code, post-comment)."
  type        = list(string)
}

variable "high_severity_topic_arn" {
  description = "ARN of the SNS topic published to on HIGH-severity scan results."
  type        = string
}
