variable "bucket" {
  description = "The bucket's name: once across FF, as across S3"
  type        = string
}

variable "name" {
  description = "The function's name"
  type        = string
}

variable "source_dir" {
  description = "The folder of the function's code, zipped as Lambda takes it"
  type        = string
}

variable "handler" {
  description = "The function's handler, as Lambda's"
  type        = string
}

variable "runtime" {
  description = "Lambda's runtime: FF runs nodejs24.x and python3.13"
  type        = string
}

variable "events" {
  description = "The bucket's events that run the function, as S3 names them"
  type        = list(string)
  default     = ["s3:ObjectCreated:*"]
}

variable "prefix" {
  description = "The keys' start that runs the function; empty for every key"
  type        = string
  default     = ""
}

variable "environment" {
  description = "The function's environment's variables"
  type        = map(string)
  default     = {}
}

variable "role_arn" {
  description = "The function's execution role's ARN: on FF any role's, kept without effect; null makes one, as AWS needs"
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags on the bucket and the function"
  type        = map(string)
  default     = {}
}
