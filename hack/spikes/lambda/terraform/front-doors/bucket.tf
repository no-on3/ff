# A bucket Terraform makes, as the modules' buckets are.
resource "aws_s3_bucket" "files" {
  bucket = "${var.name}-files"
}
