# The queue worker module's queues: a queue and its dead-letter queue.
resource "aws_sqs_queue" "jobs_dlq" {
  name = "${var.name}-jobs-dlq"
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.name}-jobs"
  visibility_timeout_seconds = 60
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 3
  })
}
