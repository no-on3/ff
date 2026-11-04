variable "bucket" {
  description = "The site's bucket: once across FF, as across S3"
  type        = string
}

variable "source_dir" {
  description = "The built site's folder, each of its files uploaded with its type"
  type        = string
}

variable "index_document" {
  description = "The file a folder's path answers"
  type        = string
  default     = "index.html"
}

variable "error_document" {
  description = "The page a path with no file answers, with 404"
  type        = string
  default     = "404.html"
}

variable "tags" {
  description = "Tags on the bucket"
  type        = map(string)
  default     = {}
}
