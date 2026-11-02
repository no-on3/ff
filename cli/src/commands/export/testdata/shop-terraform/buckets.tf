# ff export wrote this on 2026-10-31 from FF's account 123456789012.
resource "aws_s3_bucket" "photos" {
  bucket = var.photos_bucket_name
}

resource "aws_lambda_permission" "make_thumbnail_s3_photos" {
  statement_id   = "s3-photos"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.make_thumbnail.function_name
  qualifier      = aws_lambda_alias.make_thumbnail.name
  principal      = "s3.amazonaws.com"
  source_arn     = aws_s3_bucket.photos.arn
  source_account = data.aws_caller_identity.current.account_id
}

resource "aws_s3_bucket_notification" "photos" {
  count  = var.bucket_events ? 1 : 0
  bucket = aws_s3_bucket.photos.id
  lambda_function {
    id                  = "thumbnails"
    lambda_function_arn = aws_lambda_alias.make_thumbnail.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "in/"
    filter_suffix       = ".jpg"
  }
  queue {
    id        = "removed"
    queue_arn = aws_sqs_queue.orders.arn
    events    = ["s3:ObjectRemoved:Delete", "s3:ObjectRemoved:DeleteMarkerCreated"]
  }
  depends_on = [aws_lambda_permission.make_thumbnail_s3_photos, aws_sqs_queue_policy.orders]
}
