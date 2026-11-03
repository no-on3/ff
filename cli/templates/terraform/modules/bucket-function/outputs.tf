output "bucket" {
  description = "The bucket's name"
  value       = aws_s3_bucket.bucket.id
}

output "bucket_arn" {
  description = "The bucket's ARN"
  value       = aws_s3_bucket.bucket.arn
}

output "function_name" {
  description = "The function its events run"
  value       = module.function.name
}
