variable "region" {
  description = "AWS region for all dev resources."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short project name. Used as a prefix for resource names."
  type        = string
  default     = "sast-sentinel"
}

variable "alert_email" {
  description = "Email address subscribed to the HIGH-severity SNS topic. Leave empty to skip the subscription (add manually in the console)."
  type        = string
  default     = ""
}

variable "github_app_id" {
  description = "GitHub App numeric ID. Set out-of-band once the App is registered on github.com (terraform apply -var=github_app_id=12345)."
  type        = string
  default     = ""
}

