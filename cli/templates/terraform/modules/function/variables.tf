variable "name" {
  description = "The function's name: 1 to 64 letters, digits, hyphens or underscores, as Lambda's"
  type        = string
}

variable "source_dir" {
  description = "The folder of the function's code, zipped as Lambda takes it"
  type        = string
}

variable "handler" {
  description = "The handler, as Lambda's: the file's name without its extension, a dot, the function's name"
  type        = string
}

variable "runtime" {
  description = "Lambda's runtime: FF runs nodejs24.x and python3.13"
  type        = string
}

variable "memory_size" {
  description = "Its memory, in MB"
  type        = number
  default     = 128
}

variable "timeout" {
  description = "The seconds a call may take"
  type        = number
  default     = 3
}

variable "environment" {
  description = "Its environment's variables"
  type        = map(string)
  default     = {}
}

variable "role_arn" {
  description = "Its execution role's ARN. On FF any role's, kept without effect: the function's own key stands for it. Null makes one, as AWS needs, with Lambda's basic policy and policy_arns"
  type        = string
  default     = null
}

variable "policy_arns" {
  description = "The managed policies the role made here gets beside Lambda's basic one"
  type        = list(string)
  default     = []
}

variable "public_url" {
  description = "Whether the function has a URL anyone may call, on its alias live"
  type        = bool
  default     = false
}

variable "maximum_retry_attempts" {
  description = "The tries again of an asynchronous call that failed, 0 to 2"
  type        = number
  default     = 2
}

variable "maximum_event_age_in_seconds" {
  description = "How long an asynchronous call is kept before it is dropped, 60 to 21600 seconds"
  type        = number
  default     = 21600
}

variable "tags" {
  description = "Tags on the function, and on its role where one is made"
  type        = map(string)
  default     = {}
}
