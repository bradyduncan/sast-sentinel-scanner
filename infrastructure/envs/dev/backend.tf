terraform {
  backend "s3" {
    bucket         = "sast-sentinel-tf-state-241044209804"
    key            = "envs/dev/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "sast-sentinel-tf-lock"
    encrypt        = true
  }
}
