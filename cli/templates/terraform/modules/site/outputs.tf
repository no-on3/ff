output "bucket" {
  description = "The site's bucket"
  value       = aws_s3_bucket.site.id
}

output "files" {
  description = "The site's files, by their keys"
  value       = sort(keys(aws_s3_object.file))
}
