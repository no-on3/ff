# Terraform's AWS provider against FF's own S3 and SQS front doors (front-doors.sh): the step-5 plan's provider block, the
# endpoints of these two services alone. Each flow's directory gets this file and the flow's own.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.69.1" }
  }
}

variable "s3_endpoint" { type = string }
variable "sqs_endpoint" { type = string }
variable "name" { type = string }
# The site flow's: a queue made through FF's API, which the bucket's notification names.
variable "events_queue_arn" {
  type    = string
  default = ""
}
# The tagged flow's: the provider's default tags, which many teams set, so that every resource has them.
variable "default_tags" {
  type    = map(string)
  default = {}
}

provider "aws" {
  region                      = "tn-tunis-1"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  s3_use_path_style           = true
  endpoints {
    s3  = var.s3_endpoint
    sqs = var.sqs_endpoint
  }
  default_tags {
    tags = var.default_tags
  }
}
