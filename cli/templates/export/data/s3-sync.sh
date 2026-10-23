#!/usr/bin/env bash
# Your FF bucket, to AWS S3, with the AWS CLI's own `aws s3 sync`: FF's endpoint speaks S3's API, so nothing of FF's is
# in between. First from FF to a folder here, with an access key of your FF account; then from that folder to a bucket
# on S3, with your AWS credentials as the AWS CLI finds them (a profile, or the environment once FF's are gone).
#
#   eval "$(ff buckets keys create --read-only | grep '^export ')"    # FF's key, endpoint and region, for this shell
#   ./s3-sync.sh <ff-bucket> <s3-bucket> [<folder>]                    # <s3-bucket> made on S3 first; - for the folder only
#
# Run it again to copy what changed since: sync copies the files that differ, and only those. With --delete-gone, the
# files deleted on FF since go from the folder and from S3 too. AWS_S3_REGION names the S3 bucket's region when your
# profile has none. Then revoke the key: ff buckets keys revoke <id>.
set -euo pipefail

delete=()
if [ "${1:-}" = "--delete-gone" ]; then
  delete=(--delete)
  shift
fi
if [ $# -lt 2 ]; then
  echo "usage: $0 [--delete-gone] <ff-bucket> <s3-bucket> [<folder>]   (<s3-bucket> - copies to the folder only)" >&2
  exit 2
fi
ff_bucket=$1
s3_bucket=$2
folder=${3:-./$ff_bucket}
if [ -z "${AWS_ENDPOINT_URL_S3:-}" ] || [ -z "${AWS_ACCESS_KEY_ID:-}" ]; then
  echo "FF's key isn't in this shell: eval \"\$(ff buckets keys create --read-only | grep '^export ')\" first" >&2
  exit 2
fi

# The objects a listing has, as the AWS CLI prints them, one a line.
count() { aws s3 ls "$1" --recursive | wc -l | tr -d ' '; }

echo "1. FF's s3://$ff_bucket, at $AWS_ENDPOINT_URL_S3, to $folder"
mkdir -p "$folder"
aws s3 sync "s3://$ff_bucket" "$folder" --only-show-errors ${delete[@]+"${delete[@]}"}
echo "   $(count "s3://$ff_bucket") object(s) on FF, $(find "$folder" -type f | wc -l | tr -d ' ') file(s) in $folder"

if [ "$s3_bucket" = "-" ]; then
  echo "2. Not to S3: the folder alone was asked for"
  exit 0
fi
# FF's variables out of the way: the AWS CLI then reaches AWS, with your profile or AWS's own variables.
aws_s3() {
  env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN -u AWS_ENDPOINT_URL_S3 -u AWS_ENDPOINT_URL \
    -u AWS_REGION -u AWS_DEFAULT_REGION ${AWS_S3_REGION:+AWS_REGION=$AWS_S3_REGION} aws "$@"
}
echo "2. $folder to AWS's s3://$s3_bucket"
aws_s3 s3 sync "$folder" "s3://$s3_bucket" --only-show-errors ${delete[@]+"${delete[@]}"}
on_s3="$(aws_s3 s3 ls "s3://$s3_bucket" --recursive | wc -l | tr -d ' ')"
echo "   $on_s3 object(s) on S3"
echo "Done. Point your code at S3 (on AWS Lambda, a role and no endpoint), then delete the bucket on FF: ff buckets delete $ff_bucket --force"
