#!/bin/sh
# Copies the bucket's legal records to the second site: the issued invoices' PDFs and the withholding
# certificates. A copy, never a sync: a file gone from the bucket stays at the site; a file replaced keeps its
# old version under s3-replaced/<run>/.
# Then functions' packages, the zips their code images are made of: a sync, so that what FF deletes there
# (unused packages, a closed account's) goes from the site too, kept 30 days under s3-deleted/<run>/ first, about
# as long as the database's backups keep what was deleted. A run that would delete more than half of the site's
# packages, and more than PACKAGES_MAX_DELETE (10), deletes nothing and fails, saying so: a bucket lost, or
# replaced by an empty one, never empties the copy. After checking the bucket, run it once with
# PACKAGES_MAX_DELETE set to the number it gave.
# rclone reads both sites from its environment (RCLONE_CONFIG_PRIMARY_*, RCLONE_CONFIG_SITE_*); the buckets are
# PRIMARY_BUCKET and SITE_BUCKET. The CronJob runs it hourly, and hack/backup-drill.sh the same script.
set -eu
run="$(date -u +%Y-%m-%dT%H%M%S)"
for records in invoices withholding-certificates; do
  rclone copy --backup-dir "site:$SITE_BUCKET/s3-replaced/$run" "primary:$PRIMARY_BUCKET/$records" "site:$SITE_BUCKET/s3/$records"
done
echo "legal records copied to the second site ($run)"

lists="$(mktemp -d)"
trap 'rm -rf "$lists"' EXIT
# files <remote path> <file>: the files under the path, sorted, one a line; none where it has none yet, which
# rclone answers with 3, no such directory.
files() {
  status=0
  rclone lsf -R --files-only "$1" >"$2.unsorted" 2>"$2.error" || status=$?
  if [ "$status" -ne 0 ] && [ "$status" -ne 3 ]; then
    cat "$2.error" >&2
    exit "$status"
  fi
  sort "$2.unsorted" >"$2"
}
files "primary:$PRIMARY_BUCKET/packages" "$lists/primary"
files "site:$SITE_BUCKET/s3/packages" "$lists/site"
gone="$(comm -13 "$lists/primary" "$lists/site" | wc -l | tr -d ' ')"
held="$(wc -l <"$lists/site" | tr -d ' ')"
if [ "$gone" -gt "${PACKAGES_MAX_DELETE:-10}" ] && [ $((gone * 2)) -gt "$held" ]; then
  echo "packages not copied: this run would delete $gone of the second site's $held. Check the bucket; if FF did delete them, run it once with PACKAGES_MAX_DELETE=$gone" >&2
  exit 1
fi
if [ -s "$lists/primary" ]; then
  rclone sync --backup-dir "site:$SITE_BUCKET/s3-deleted/$run/packages" "primary:$PRIMARY_BUCKET/packages" "site:$SITE_BUCKET/s3/packages"
elif [ -s "$lists/site" ]; then
  # None left in the bucket, which a sync can't read from: the site's go where a sync would put them.
  rclone move "site:$SITE_BUCKET/s3/packages" "site:$SITE_BUCKET/s3-deleted/$run/packages"
fi
echo "packages copied to the second site, $gone deleted there ($run)"

# What was deleted 30 days ago or more goes now: each run's folder is named after its time.
cutoff="$(date -u -d "@$(($(date -u +%s) - 30 * 86400))" +%Y%m%d%H%M%S)"
rclone lsf --dirs-only "site:$SITE_BUCKET/s3-deleted" 2>/dev/null | while read -r folder; do
  folder="${folder%/}"
  case "$folder" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) continue ;; # not a run's: left alone
  esac
  if [ "$(echo "$folder" | tr -d 'T-')" -lt "$cutoff" ]; then
    rclone purge "site:$SITE_BUCKET/s3-deleted/$folder"
    echo "packages deleted at $folder: gone from the second site, after 30 days"
  fi
done
