# {{name}}: four parts, each a module of ./modules that applies on FF and, with only providers.tf changed, on AWS.
# `tofu apply` or `terraform apply` makes them, a second plan finds nothing to change, and `destroy` removes them.
locals {
  app     = "{{name}}"
  runtime = "{{runtime}}"
  code    = "${path.root}/src"
}

# A function with a URL anyone may call, on its alias live, which each change of its code publishes and moves.
module "api" {
  source      = "./modules/function"
  name        = "${local.app}-api"
  source_dir  = local.code
  handler     = "api.handler"
  runtime     = local.runtime
  role_arn    = local.function_role
  public_url  = true
  environment = { APP = local.app }
}

# A queue, its dead-letter queue, and a function that reads it in batches.
module "jobs" {
  source     = "./modules/queue-worker"
  name       = "${local.app}-jobs"
  source_dir = local.code
  handler    = "worker.handler"
  runtime    = local.runtime
  role_arn   = local.function_role
}

# A bucket whose new files each run a function. A bucket's name is once across FF, as across S3.
module "uploads" {
  source     = "./modules/bucket-function"
  bucket     = "${local.app}-uploads"
  name       = "${local.app}-uploads"
  source_dir = local.code
  handler    = "uploads.handler"
  runtime    = local.runtime
  role_arn   = local.function_role
}

# A site: ./site's files in a bucket with a website configuration, public to read.
module "site" {
  source     = "./modules/site"
  bucket     = "${local.app}-site"
  source_dir = "${path.root}/site"
}

output "api_url" {
  description = "The API's URL, on its alias live"
  value       = module.api.url
}

output "jobs_queue_url" {
  description = "The jobs' queue, for AWS's SDKs and CLI"
  value       = module.jobs.queue_url
}

output "uploads_bucket" {
  description = "The bucket whose new files run the uploads function"
  value       = module.uploads.bucket
}

output "site_bucket" {
  description = "The site's bucket: on FF, `ff sites get` gives its address; on AWS, its website endpoint"
  value       = module.site.bucket
}
