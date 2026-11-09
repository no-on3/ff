#!/usr/bin/env bash
# The runtime images of a release of ff, which `ff local` runs functions in, pinned by digest. Each built from
# runtimes/<runtime> for AWS Lambda's x86_64 (linux/amd64), which `ff package` builds for too, and tagged as the
# repository tags it (cli/src/local/mod.rs) with "-ff-<version>" after; pushed to <repository>/ff-runtime-<runtime>; then
# saved and compressed into <folder>/images/, the archive `ff local` loads when Docker can't pull the image (gzip, which
# every Docker's load reads). <folder>/runtime-images.json names, for each runtime, the image, its tag, its digest on
# the registry and its archive's path on the downloads site: the release's builds take it in FF_BUILD_RUNTIME_IMAGES,
# hack/release.sh signs the archives it names.
#   hack/runtime-images.sh <repository> <version> <folder> [--from-local] [--runtime nodejs|python]...
#   <repository>     where the images go, as ghcr.io/<owner>: lowercase, as Docker's names are
#   --from-local     the repository's images on this machine tagged rather than built, as the ff suite's are
#   --runtime        that runtime's image alone; both without it
#   FF_IMAGE_SOURCE  the repository's URL, the images' org.opencontainers.image.source label, which links GitHub's
#                    package to the repository
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
usage() {
  echo "usage: hack/runtime-images.sh <repository> <version> <folder> [--from-local] [--runtime nodejs|python]..." >&2
  exit 2
}
refuse() { echo "no runtime images made: $*" >&2; exit 1; }
[ $# -ge 3 ] || usage
repository="${1%/}" version=$2 folder=$3
shift 3
from_local=false
runtimes=()
while [ $# -gt 0 ]; do
  case "$1" in
    --from-local) from_local=true ;;
    --runtime) [ $# -ge 2 ] || usage; runtimes+=("$2"); shift ;;
    *) usage ;;
  esac
  shift
done
[ "${#runtimes[@]}" -gt 0 ] || runtimes=(nodejs python)

# What ff checks in the manifest it is built with, checked here first.
case "$repository" in '' | *[!a-z0-9._/:-]* | [-./]*) refuse "\"$repository\" isn't a lowercase repository's name" ;; esac
case "$version" in '' | *[!0-9A-Za-z.-]* | [-.]*) refuse "\"$version\" isn't a version" ;; esac
[ ! -e "$folder/runtime-images.json" ] || refuse "$folder has its manifest already"

# The repository's tag of a runtime's image, as ff names it: ff-runtime-python:3.13-v3.
repository_tag() {
  local constant
  case "$1" in nodejs) constant=NODEJS_IMAGE ;; python) constant=PYTHON_IMAGE ;; *) refuse "no runtime $1" ;; esac
  sed -n "s/^pub const $constant: &str = \"\\(.*\\)\";\$/\\1/p" "$repo/cli/src/local/mod.rs"
}

mkdir -p "$folder/images"
manifest='{}'
for runtime in "${runtimes[@]}"; do
  local_tag="$(repository_tag "$runtime")"
  [ -n "$local_tag" ] || refuse "cli/src/local/mod.rs names no image for $runtime"
  name="${local_tag%%:*}"
  tag="${local_tag#*:}-ff-$version"
  image="$repository/$name"
  if $from_local; then
    docker image inspect "$local_tag" >/dev/null 2>&1 || refuse "$local_tag isn't on this machine"
    docker tag "$local_tag" "$image:$tag"
  else
    label=()
    [ -z "${FF_IMAGE_SOURCE:-}" ] || label=(--label "org.opencontainers.image.source=$FF_IMAGE_SOURCE")
    docker build --quiet --platform linux/amd64 ${label[@]+"${label[@]}"} -t "$image:$tag" "$repo/runtimes/$runtime" >/dev/null
  fi
  docker push --quiet "$image:$tag" >/dev/null
  # Its digest on the registry, which the push recorded.
  digest=''
  while IFS= read -r pushed; do
    case "$pushed" in "$image@"*) digest="${pushed#"$image@"}" ;; esac
  done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image:$tag")
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "the push of $image:$tag recorded no digest"
  archive="images/$name-$tag.tar.gz"
  docker save "$image:$tag" | gzip -n >"$folder/$archive"
  manifest="$(jq -bc --arg runtime "$runtime" --arg image "$image" --arg tag "$tag" --arg digest "$digest" \
    --arg archive "$archive" '. + {($runtime): {image: $image, tag: $tag, digest: $digest, archive: $archive}}' \
    <<<"$manifest")"
  echo "$image:$tag pushed, $digest; its archive $folder/$archive, $(($(wc -c <"$folder/$archive") / 1048576)) MB"
done
printf '%s\n' "$manifest" >"$folder/runtime-images.json"
echo "the manifest: $folder/runtime-images.json"
