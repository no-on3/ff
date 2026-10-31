# ff export wrote this on 2026-10-31 from FF's account 123456789012.
resource "aws_iam_role" "make_thumbnail" {
  name_prefix        = "make-thumbnail-"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "make_thumbnail_logs" {
  role       = aws_iam_role.make_thumbnail.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "make_thumbnail" {
  statement {
    actions   = ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.photos.arn}/*"]
  }
  statement {
    actions   = ["s3:ListAllMyBuckets"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "make_thumbnail" {
  name   = "uses"
  role   = aws_iam_role.make_thumbnail.id
  policy = data.aws_iam_policy_document.make_thumbnail.json
}

resource "aws_lambda_function" "make_thumbnail" {
  function_name                  = "make-thumbnail"
  role                           = aws_iam_role.make_thumbnail.arn
  filename                       = "${path.module}/../code/make-thumbnail.zip"
  source_code_hash               = filebase64sha256("${path.module}/../code/make-thumbnail.zip")
  handler                        = "app.handler"
  runtime                        = "python3.13"
  memory_size                    = 512
  timeout                        = 30
  reserved_concurrent_executions = 10
  publish                        = true
}

resource "aws_lambda_alias" "make_thumbnail" {
  name             = "live"
  function_name    = aws_lambda_function.make_thumbnail.function_name
  function_version = aws_lambda_function.make_thumbnail.version
}

resource "aws_lambda_provisioned_concurrency_config" "make_thumbnail" {
  function_name                     = aws_lambda_alias.make_thumbnail.function_name
  qualifier                         = aws_lambda_alias.make_thumbnail.name
  provisioned_concurrent_executions = 1
}

resource "aws_iam_role" "report_v1" {
  name_prefix        = "report_v1-"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "report_v1_logs" {
  role       = aws_iam_role.report_v1.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_lambda_function" "report_v1" {
  function_name    = "report_v1"
  role             = aws_iam_role.report_v1.arn
  filename         = "${path.module}/../code/report_v1.zip"
  source_code_hash = filebase64sha256("${path.module}/../code/report_v1.zip")
  handler          = "function.handler"
  runtime          = "nodejs24.x"
  memory_size      = 128
  timeout          = 3
}

resource "aws_iam_role" "send_receipts" {
  name_prefix        = "send-receipts-"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

resource "aws_iam_role_policy_attachment" "send_receipts_logs" {
  role       = aws_iam_role.send_receipts.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "send_receipts" {
  statement {
    actions   = ["s3:GetBucketNotification", "s3:ListBucket"]
    resources = [aws_s3_bucket.photos.arn]
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["arn:aws:s3:::archive/*"]
  }
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.photos.arn}/*"]
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["arn:aws:s3:::${var.www_bucket_name}/*"]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.failed_receipts.arn]
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = ["arn:aws:sqs:${var.region}:${data.aws_caller_identity.current.account_id}:invoices"]
  }
  statement {
    actions   = ["sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage"]
    resources = [aws_sqs_queue.orders.arn]
  }
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = ["arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:audit"]
  }
  statement {
    actions   = ["ses:SendEmail"]
    resources = ["arn:aws:ses:${var.region}:${data.aws_caller_identity.current.account_id}:identity/shop.tn"]
  }
  statement {
    actions   = ["ses:GetAccount"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "send_receipts" {
  name   = "uses"
  role   = aws_iam_role.send_receipts.id
  policy = data.aws_iam_policy_document.send_receipts.json
}

resource "aws_lambda_function" "send_receipts" {
  function_name    = "send-receipts"
  role             = aws_iam_role.send_receipts.arn
  filename         = "${path.module}/../code/send-receipts.zip"
  source_code_hash = filebase64sha256("${path.module}/../code/send-receipts.zip")
  handler          = "function.handler"
  runtime          = "nodejs24.x"
  memory_size      = 256
  timeout          = 60
  environment {
    variables = {
      LOG_LEVEL    = var.send_receipts_log_level
      DATABASE_URL = var.send_receipts_database_url
    }
  }
}

resource "aws_lambda_function_url" "send_receipts" {
  function_name      = aws_lambda_function.send_receipts.function_name
  authorization_type = "AWS_IAM"
  cors {
    allow_methods = ["POST"]
    allow_origins = ["https://shop.tn"]
    max_age       = 300
  }
}

resource "aws_cloudwatch_event_rule" "send_receipts_nightly" {
  name                = "send-receipts-nightly"
  schedule_expression = "cron(0 2 * * ? *)"
  state               = var.schedule_state
}

resource "aws_cloudwatch_event_target" "send_receipts_nightly" {
  rule = aws_cloudwatch_event_rule.send_receipts_nightly.name
  arn  = aws_lambda_function.send_receipts.arn
  input = jsonencode({
    report = true
  })
}

resource "aws_lambda_permission" "send_receipts_schedule_nightly" {
  statement_id  = "schedule-nightly"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.send_receipts.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.send_receipts_nightly.arn
}

resource "aws_cloudwatch_event_rule" "send_receipts_weekly" {
  name                = "send-receipts-weekly"
  schedule_expression = "rate(7 days)"
  state               = "DISABLED"
}

resource "aws_cloudwatch_event_target" "send_receipts_weekly" {
  rule = aws_cloudwatch_event_rule.send_receipts_weekly.name
  arn  = aws_lambda_function.send_receipts.arn
}

resource "aws_lambda_permission" "send_receipts_schedule_weekly" {
  statement_id  = "schedule-weekly"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.send_receipts.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.send_receipts_weekly.arn
}

resource "aws_lambda_event_source_mapping" "send_receipts_orders" {
  event_source_arn                   = aws_sqs_queue.orders.arn
  function_name                      = aws_lambda_function.send_receipts.arn
  batch_size                         = 10
  maximum_batching_window_in_seconds = 2
  function_response_types            = ["ReportBatchItemFailures"]
  scaling_config {
    maximum_concurrency = 5
  }
}

resource "aws_lambda_function_event_invoke_config" "send_receipts" {
  function_name          = aws_lambda_function.send_receipts.function_name
  maximum_retry_attempts = 1
  destination_config {
    on_success {
      destination = "arn:aws:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:audit"
    }
    on_failure {
      destination = aws_sqs_queue.failed_receipts.arn
    }
  }
}
