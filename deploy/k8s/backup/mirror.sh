#!/bin/sh
# Copies the bucket's legal records to the second site: the issued invoices' PDFs and the withholding
# certificates. A copy, never a sync: a file gone from the bucket stays at the site; a file replaced keeps its
# old version under s3-replaced/<run>/. rclone reads both sites from its environment (RCLONE_CONFIG_PRIMARY_*,
# RCLONE_CONFIG_SITE_*); the buckets are PRIMARY_BUCKET and SITE_BUCKET. The CronJob runs it hourly, and
# hack/backup-drill.sh the same script.
set -eu
run="$(date -u +%Y-%m-%dT%H%M%S)"
for records in invoices withholding-certificates; do
  rclone copy --backup-dir "site:$SITE_BUCKET/s3-replaced/$run" "primary:$PRIMARY_BUCKET/$records" "site:$SITE_BUCKET/s3/$records"
done
echo "legal records copied to the second site ($run)"
