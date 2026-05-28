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
