terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State lives in an encrypted S3 bucket with S3-native locking, never on a laptop or in the repo.
  # The bucket, key and region come from a backend.hcl that is not committed (see
  # backend.hcl.example and docs/runbook/hosting.md):
  #
  #   terraform init -backend-config=backend.hcl
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "testnotary"
      ManagedBy = "terraform"
      Source    = "github.com/${var.github_repository}/infra"
    }
  }
}
