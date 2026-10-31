#!/usr/bin/env bash
# The SBOMs the last security run on a branch wrote (its "sbom" artifact), for the nightly's advisories job, which
# scans them again with the day's advisories: an image unchanged since its push can have a new advisory, and the
# nightly no longer builds the images. The newest artifact of the branch's runs that GitHub still keeps; none, an error.
#   GH_TOKEN, GH_REPO   for gh, allowed actions: read
#   hack/lib/last-sboms.sh <branch> <directory>
set -euo pipefail
branch="${1:?the branch}"
dir="${2:?the directory}"
run="$(gh api --paginate "repos/$GH_REPO/actions/artifacts?name=sbom&per_page=100" |
  jq -rs --arg branch "$branch" '[.[].artifacts[] | select(.expired | not) | select(.workflow_run.head_branch == $branch)]
    | sort_by(.created_at) | last | .workflow_run.id // empty')"
if [ -z "$run" ]; then
  echo "no SBOM kept for $branch: its next push's security job writes them" >&2
  exit 1
fi
mkdir -p "$dir"
gh run download "$run" --name sbom --dir "$dir"
echo "the SBOMs of run $run: $(cd "$dir" && ls | paste -sd' ')"
