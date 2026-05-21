# Bootstrap

Creates the remote Terraform state backend (S3 bucket + DynamoDB lock table) used by `envs/dev/`.

**Runs exactly once.** Uses local state. Do not commit `terraform.tfstate`.

## Usage

```sh
cd infrastructure/bootstrap
terraform init
terraform apply
```

After this runs, copy the outputs into `infrastructure/envs/dev/backend.tf`.
