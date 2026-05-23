variable "region" {
  description = "AWS region the state backend lives in."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short project name. Used as a prefix for the state bucket and lock table."
  type        = string
  default     = "sast-sentinel"
}
