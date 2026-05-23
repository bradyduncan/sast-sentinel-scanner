# Remote state config. Run `infrastructure/bootstrap` first to create the
# S3 bucket and DynamoDB lock table, then copy its outputs into the values
# below and remove the comments.
#
# terraform {
#   backend "s3" {
#     bucket         = "<state_bucket from bootstrap output>"
#     key            = "envs/dev/terraform.tfstate"
#     region         = "<region from bootstrap output>"
#     dynamodb_table = "<lock_table from bootstrap output>"
#     encrypt        = true
#   }
# }
