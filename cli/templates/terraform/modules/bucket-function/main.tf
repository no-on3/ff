# A bucket that runs a function: each event of the bucket's that S3 sends, a new file by default, calls the function's
# alias live, as S3 calls a function, which the permission lets S3 do.
resource "aws_s3_bucket" "bucket" {
  bucket = var.bucket
  tags   = var.tags
}

module "function" {
  source      = "../function"
  name        = var.name
  source_dir  = var.source_dir
  handler     = var.handler
  runtime     = var.runtime
  environment = merge({ BUCKET = var.bucket }, var.environment)
  role_arn    = var.role_arn
  tags        = var.tags
}

resource "aws_lambda_permission" "bucket" {
  statement_id  = "bucket-events"
  action        = "lambda:InvokeFunction"
  function_name = module.function.name
  qualifier     = module.function.alias_name
  principal     = "s3.amazonaws.com"
  # In AWS's partition, as the project's other ARNs are: the provider builds a bucket's `arn` from its region's
  # partition, and FF's region is in none it knows.
  source_arn = "arn:aws:s3:::${aws_s3_bucket.bucket.bucket}"
}

resource "aws_s3_bucket_notification" "bucket" {
  bucket = aws_s3_bucket.bucket.id
  lambda_function {
    lambda_function_arn = module.function.alias_arn
    events              = var.events
    filter_prefix       = var.prefix == "" ? null : var.prefix
  }
  depends_on = [aws_lambda_permission.bucket]
}
