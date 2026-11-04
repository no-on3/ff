# A site: a bucket with a website configuration, its files uploaded from a folder, and what AWS needs to let anyone
# read them, a public access block that lets a policy open the bucket and that policy. On FF the website
# configuration alone makes the bucket public, at its site's address; FF keeps the other two without effect.
locals {
  content_types = {
    html = "text/html; charset=utf-8"
    css  = "text/css; charset=utf-8"
    js   = "text/javascript; charset=utf-8"
    json = "application/json"
    svg  = "image/svg+xml"
    png  = "image/png"
    jpg  = "image/jpeg"
    jpeg = "image/jpeg"
    gif  = "image/gif"
    webp = "image/webp"
    ico  = "image/x-icon"
    txt  = "text/plain; charset=utf-8"
    xml  = "application/xml"
  }
}

resource "aws_s3_bucket" "site" {
  bucket = var.bucket
  tags   = var.tags
}

resource "aws_s3_bucket_website_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  index_document {
    suffix = var.index_document
  }
  error_document {
    key = var.error_document
  }
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

# The bucket's ARN in AWS's partition, as the project's other ARNs are: the provider builds a bucket's `arn` from its
# region's partition, and FF's region is in none it knows.
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Sid = "PublicRead", Effect = "Allow", Principal = "*", Action = "s3:GetObject", Resource = "arn:aws:s3:::${aws_s3_bucket.site.bucket}/*" }]
  })
  depends_on = [aws_s3_bucket_public_access_block.site]
}

resource "aws_s3_object" "file" {
  for_each     = fileset(var.source_dir, "**")
  bucket       = aws_s3_bucket.site.id
  key          = each.value
  source       = "${var.source_dir}/${each.value}"
  etag         = filemd5("${var.source_dir}/${each.value}")
  content_type = try(local.content_types[lower(regex("\\.([^./]+)$", each.value)[0])], "application/octet-stream")
}
