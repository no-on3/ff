# A function: its code zipped from a folder, published at each change, its alias live moved to that version; a URL
# on the alias when asked; and the settings of its asynchronous calls. Its role is given (on FF, any role's ARN), or
# made here (on AWS).
data "archive_file" "code" {
  type             = "zip"
  source_dir       = var.source_dir
  output_path      = "${path.root}/.build/${var.name}.zip"
  output_file_mode = "0644"
}

resource "aws_iam_role" "function" {
  count = var.role_arn == null ? 1 : 0
  name  = var.name
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "function" {
  for_each   = var.role_arn == null ? toset(concat(["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"], var.policy_arns)) : toset([])
  role       = one(aws_iam_role.function[*].name)
  policy_arn = each.value
}

resource "aws_lambda_function" "function" {
  function_name    = var.name
  role             = coalesce(var.role_arn, one(aws_iam_role.function[*].arn))
  handler          = var.handler
  runtime          = var.runtime
  filename         = data.archive_file.code.output_path
  source_code_hash = data.archive_file.code.output_base64sha256
  memory_size      = var.memory_size
  timeout          = var.timeout
  publish          = true

  dynamic "environment" {
    for_each = length(var.environment) > 0 ? [var.environment] : []
    content {
      variables = environment.value
    }
  }

  tags = var.tags

  # A role made here can run the function once its policies are on it.
  depends_on = [aws_iam_role_policy_attachment.function]
}

resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.function.function_name
  function_version = aws_lambda_function.function.version
}

# Open to all: the provider adds the two permissions Lambda asks of a URL without authentication.
resource "aws_lambda_function_url" "live" {
  count              = var.public_url ? 1 : 0
  function_name      = aws_lambda_function.function.function_name
  qualifier          = aws_lambda_alias.live.name
  authorization_type = "NONE"
}

resource "aws_lambda_function_event_invoke_config" "function" {
  function_name                = aws_lambda_function.function.function_name
  maximum_retry_attempts       = var.maximum_retry_attempts
  maximum_event_age_in_seconds = var.maximum_event_age_in_seconds
}
