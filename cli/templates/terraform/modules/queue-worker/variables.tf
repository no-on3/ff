variable "name" {
  description = "The queue's name, and its function's: its dead-letter queue is <name>-dead-letters"
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

variable "timeout" {
  description = "The seconds the function may take on a batch; the queue hides a message six times as long, as AWS advises"
  type        = number
  default     = 10
}

variable "batch_size" {
  description = "The most messages the function gets at once"
  type        = number
  default     = 10
}

variable "max_receive_count" {
  description = "The tries of a message before it goes to the dead-letter queue"
  type        = number
  default     = 3
}

variable "environment" {
  description = "The function's environment's variables"
  type        = map(string)
  default     = {}
}

variable "role_arn" {
  description = "The function's execution role's ARN: on FF any role's, kept without effect; null makes one, as AWS needs, that may read the queue"
  type        = string
  default     = null
}

variable "tags" {
  description = "Tags on the queues and the function"
  type        = map(string)
  default     = {}
}
