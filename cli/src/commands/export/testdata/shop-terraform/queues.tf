# ff export wrote this on 2026-10-31 from FF's account 123456789012.
resource "aws_sqs_queue" "failed_receipts" {
  name                       = "failed-receipts"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600
  delay_seconds              = 0
  max_message_size           = 1048576
  receive_wait_time_seconds  = 0
}

resource "aws_sqs_queue" "orders" {
  name                       = "orders"
  visibility_timeout_seconds = 60
  message_retention_seconds  = 345600
  delay_seconds              = 0
  max_message_size           = 1048576
  receive_wait_time_seconds  = 0
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.orders_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue" "orders_dlq" {
  name                       = "orders-dlq"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 345600
  delay_seconds              = 0
  max_message_size           = 1048576
  receive_wait_time_seconds  = 0
}

data "aws_iam_policy_document" "orders_from_buckets" {
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.orders.arn]
    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.photos.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sqs_queue_policy" "orders" {
  queue_url = aws_sqs_queue.orders.id
  policy    = data.aws_iam_policy_document.orders_from_buckets.json
}
