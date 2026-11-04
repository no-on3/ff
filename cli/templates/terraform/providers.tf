# Terraform's AWS provider, pointed at FF: its region, its Lambda, S3, SQS and SES endpoints, and the four checks
# the provider makes of AWS that FF has no answer for: no STS to ask the account's ID of, no IAM to check the key
# with, no metadata service, a region outside AWS's list. The key is one of `ff keys create`'s, reaching the
# account's functions, buckets and queues, in AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, as AWS's.
#
# To move to AWS: an AWS region below, the lines between the two "FF" comments removed, and function_role set to
# null, so that each module makes its function's role. The modules stay as they are.
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.69" }
    archive = { source = "hashicorp/archive", version = "~> 2.8" }
  }
}

provider "aws" {
  region = "{{region}}"

  # FF: from here...
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  s3_use_path_style           = true
  endpoints {
{{endpoints}}
  }
  # ...to here.
}

locals {
  # Each function's execution role. FF has no IAM: a function's own key stands for its role, and FF keeps the
  # role's ARN without effect. On AWS, null: each module makes its function's role.
  function_role = "arn:aws:iam::{{account}}:role/{{name}}"
}
