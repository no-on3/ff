# A queue worker: a queue, its dead-letter queue for the messages that failed max_receive_count times, and a function
# that reads the queue in batches through its alias live.
resource "aws_sqs_queue" "dead_letters" {
  name                      = "${var.name}-dead-letters"
  message_retention_seconds = 1209600
  tags                      = var.tags
}

resource "aws_sqs_queue" "queue" {
  name                       = var.name
  visibility_timeout_seconds = var.timeout * 6
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead_letters.arn
    maxReceiveCount     = var.max_receive_count
  })
  tags = var.tags
}

module "function" {
  source      = "../function"
  name        = var.name
  source_dir  = var.source_dir
  handler     = var.handler
  runtime     = var.runtime
  timeout     = var.timeout
  environment = var.environment
  role_arn    = var.role_arn
  policy_arns = ["arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"]
  tags        = var.tags
}

resource "aws_lambda_event_source_mapping" "queue" {
  event_source_arn = aws_sqs_queue.queue.arn
  function_name    = module.function.alias_arn
  batch_size       = var.batch_size
}
