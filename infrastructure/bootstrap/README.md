# Bootstrap

Creates the remote Terraform state backend used by `infrastructure/envs/dev/`:

- **S3 bucket** for state files (versioned, encrypted, public access blocked, non-current versions expire after 90 days).
- **DynamoDB table** for state locking (PAY_PER_REQUEST, encryption at rest).

This module is the **chicken-and-egg solution**: it uses local state because the remote backend doesn't exist yet. Every other Terraform module in this repo uses the resources this module creates.

## Prerequisites

- Terraform `>= 1.6`
- AWS credentials configured for the target account (`aws configure` or `AWS_PROFILE`).
- Permission to create S3 buckets and DynamoDB tables in the target account.

## Run (once per account)

```sh
cd infrastructure/bootstrap
terraform init
terraform apply
```

Confirm the plan, then approve. After apply, capture the outputs:

```sh
terraform output
```

## Wire up the dev environment

Copy the outputs into `infrastructure/envs/dev/backend.tf`:

```hcl
terraform {
  backend "s3" {
    bucket         = "<state_bucket from output>"
    key            = "envs/dev/terraform.tfstate"
    region         = "<region from output>"
    dynamodb_table = "<lock_table from output>"
    encrypt        = true
  }
}
```

Then in `envs/dev/`:

```sh
terraform init
```

Terraform will detect the remote backend config and prompt to migrate (there's nothing to migrate on first run — just answer "yes").

## Do not commit

The local `terraform.tfstate` produced by this module is gitignored at the repo root. **Do not commit it** — it contains the bucket and table identifiers, which are fine to lose (you can re-derive them by reading the actual AWS resources or re-running `terraform output`).

## Destroying

You almost never want to. If you do, first destroy every environment (`envs/dev`, etc.) so its state is gone, then `terraform destroy` here. The S3 bucket must be empty before it can be deleted — versioned buckets need explicit version cleanup.
