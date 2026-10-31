# Terraform's AWS provider against the spike's Lambda endpoint (run.sh's tofu and terraform clients): the resources the
# reference modules will hold for a function, made, planned again with nothing to change, and destroyed. The provider is
# told the endpoint and nothing else of AWS: no account lookup, no credentials check, a region of FF's own.
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "6.69.1" }
  }
}

variable "endpoint" { type = string }
variable "name" { type = string }
variable "code" { type = string }

provider "aws" {
  region                      = "tn-tunis-1"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  endpoints {
    lambda = var.endpoint
  }
}

resource "aws_lambda_function" "fn" {
  function_name    = var.name
  role             = "arn:aws:iam::123456789012:role/spike"
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  filename         = var.code
  source_code_hash = filebase64sha256(var.code)
  publish          = true
  timeout          = 10
  environment {
    variables = { STAGE = "spike" }
  }
  tags = { team = "spike" }
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.fn.function_name
  function_version = aws_lambda_function.fn.version
}

resource "aws_lambda_function_url" "url" {
  function_name      = aws_lambda_function.fn.function_name
  authorization_type = "NONE"
}

resource "aws_lambda_permission" "url" {
  statement_id           = "url"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.fn.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_event_source_mapping" "queue" {
  event_source_arn = "arn:aws:sqs:tn-tunis-1:123456789012:spike"
  function_name    = aws_lambda_function.fn.arn
  batch_size       = 5
}

resource "aws_lambda_function_event_invoke_config" "async" {
  function_name          = aws_lambda_function.fn.function_name
  maximum_retry_attempts = 1
}
