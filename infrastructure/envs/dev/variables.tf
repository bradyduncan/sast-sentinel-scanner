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
