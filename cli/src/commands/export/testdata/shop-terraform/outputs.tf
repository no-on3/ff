# ff export wrote this on 2026-10-31 from FF's account 123456789012.
output "send_receipts_url" {
  description = "send-receipts's URL"
  value       = aws_lambda_function_url.send_receipts.function_url
}
