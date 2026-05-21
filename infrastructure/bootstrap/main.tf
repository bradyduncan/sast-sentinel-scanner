# Bootstrap: creates the remote Terraform state backend.
# Runs ONCE, uses LOCAL state (terraform.tfstate is gitignored).
# Outputs the S3 bucket name + DynamoDB lock table name for envs/dev/backend.tf to reference.
#
# TODO (Person 2, Week 0): implement S3 bucket (versioned, encrypted) + DynamoDB lock table.
