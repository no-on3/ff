# The site module's bucket, made through FF's API and imported, so that what the provider asks of a bucket that exists
# shows whatever making one asks; its website configuration, a page, and a notification to a queue of the account's.
import {
  to = aws_s3_bucket.site
  id = "${var.name}-site"
}

resource "aws_s3_bucket" "site" {
  bucket = "${var.name}-site"
}

resource "aws_s3_bucket_website_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  index_document {
    suffix = "index.html"
  }
  error_document {
    key = "404.html"
  }
}

resource "aws_s3_object" "index" {
  bucket       = aws_s3_bucket.site.id
  key          = "index.html"
  content      = "<h1>hello from Terraform</h1>"
  content_type = "text/html"
}

resource "aws_s3_bucket_notification" "site" {
  bucket = aws_s3_bucket.site.id
  queue {
    queue_arn = var.events_queue_arn
    events    = ["s3:ObjectCreated:*"]
  }
}
