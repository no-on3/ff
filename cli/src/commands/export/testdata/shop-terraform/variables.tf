# ff export wrote this on 2026-10-31 from FF's account 123456789012.
variable "region" {
  type        = string
  description = "The AWS region to move to, such as eu-west-3"
}

variable "schedule_state" {
  type        = string
  default     = "DISABLED"
  description = "ENABLED once FF's schedules are off, so that no schedule runs on both: MIGRATION.md says when"
  validation {
    condition     = contains(["ENABLED", "DISABLED"], var.schedule_state)
    error_message = "ENABLED or DISABLED."
  }
}

variable "bucket_events" {
  type        = bool
  default     = false
  description = "true once the buckets' files are copied, so that the copy calls nothing: MIGRATION.md says when"
}

variable "photos_bucket_name" {
  type        = string
  default     = "photos"
  description = "The bucket photos's name on S3, which names a bucket for all of S3: FF's may be taken there"
}

variable "www_bucket_name" {
  type        = string
  default     = "www"
  description = "The site www's bucket on S3, for the roles that use it: the output Bucket of data/s3-website.md's stack, FF's name until it is made"
}

variable "send_receipts_log_level" {
  type        = string
  description = "send-receipts's variable LOG_LEVEL, which `ff env list send-receipts --show` gives"
}

variable "send_receipts_database_url" {
  type        = string
  sensitive   = true
  description = "send-receipts's secret DATABASE_URL"
}
