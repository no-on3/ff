output "queue_url" {
  description = "The queue's URL, for AWS's SDKs and CLI"
  value       = aws_sqs_queue.queue.url
}

output "queue_arn" {
  description = "The queue's ARN"
  value       = aws_sqs_queue.queue.arn
}

output "dead_letters_url" {
  description = "The dead-letter queue's URL"
  value       = aws_sqs_queue.dead_letters.url
}

output "function_name" {
  description = "The function that reads the queue"
  value       = module.function.name
}
