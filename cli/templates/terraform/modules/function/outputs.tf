output "name" {
  description = "The function's name"
  value       = aws_lambda_function.function.function_name
}

output "arn" {
  description = "The function's ARN, which runs $LATEST"
  value       = aws_lambda_function.function.arn
}

output "alias_name" {
  description = "Its alias, live, on the version its code last published"
  value       = aws_lambda_alias.live.name
}

output "alias_arn" {
  description = "Its alias's ARN, which runs the version published last"
  value       = aws_lambda_alias.live.arn
}

output "version" {
  description = "The version its code last published"
  value       = aws_lambda_function.function.version
}

output "url" {
  description = "Its URL on the alias live, when public_url is set; null otherwise"
  value       = one(aws_lambda_function_url.live[*].function_url)
}
