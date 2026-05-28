output "lambda_exec_role_arn" {
  description = "ARN of the shared Lambda execution role."
  value       = aws_iam_role.lambda_exec.arn
}

output "lambda_exec_role_name" {
  description = "Name of the shared Lambda execution role."
  value       = aws_iam_role.lambda_exec.name
}

output "fargate_task_role_arn" {
  description = "ARN of the Fargate task (application) role."
  value       = aws_iam_role.fargate_task.arn
}

output "fargate_task_exec_role_arn" {
  description = "ARN of the Fargate task execution role (ECR pull + CloudWatch Logs)."
  value       = aws_iam_role.fargate_task_exec.arn
}

output "step_functions_role_arn" {
  description = "ARN of the Step Functions state-machine role."
  value       = aws_iam_role.step_functions.arn
}
