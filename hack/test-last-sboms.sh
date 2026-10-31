#!/usr/bin/env bash
# hack/lib/last-sboms.sh against a stand-in gh, which answers the artifacts' list from a file, a page at a time, and
# records what it was asked to download: the newest SBOMs of the branch are taken, not another branch's, newer, nor
# those GitHub no longer keeps; with none, it fails saying so. In a second or so.
#   hack/test-last-sboms.sh
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/last-sboms.sh"
work="$(mktemp -d)"
source "$(dirname "${BASH_SOURCE[0]}")/lib/checks.sh"
on_exit 'rm -rf "$work"'

mkdir "$work/bin"
cat >"$work/bin/gh" <<'GH'
#!/usr/bin/env bash
# The artifacts' list from artifacts.json (--paginate's pages, one after the other); a download recorded, and a file
# written where it was asked.
case "$1 $2" in
  'api --paginate') cat "$GH_WORK/artifacts.json" ;;
  'run download') echo "$3" >"$GH_WORK/downloaded"; while [ $# -gt 0 ]; do [ "$1" = --dir ] && touch "$2/ff-backend.cdx.json"; shift; done ;;
esac
GH
chmod +x "$work/bin/gh"
artifact() { # <run id> <branch> <created at> <expired>
  printf '{"workflow_run": {"id": %s, "head_branch": "%s"}, "created_at": "%s", "expired": %s}' "$1" "$2" "$3" "$4"
}
# Two pages, as --paginate prints them: the newest of master's is on the second, a newer one of another branch's on
# the first, and the newest of all master's has expired.
{
  echo "{\"artifacts\": [$(artifact 101 master 2026-10-29T03:00:00Z false), $(artifact 102 feat/step-5 2026-10-31T04:00:00Z false)]}"
  echo "{\"artifacts\": [$(artifact 103 master 2026-10-30T03:00:00Z false), $(artifact 104 master 2026-10-31T03:00:00Z true)]}"
} >"$work/artifacts.json"
run() { # <branch>: the script's exit status; its output in $work/out
  rm -f "$work/downloaded" && rm -rf "$work/sbom"
  local status=0
  PATH="$work/bin:$PATH" GH_WORK="$work" GH_REPO=owner/repo "$script" "$1" "$work/sbom" >"$work/out" 2>&1 || status=$?
  echo "$status"
}

check "master: the newest SBOMs it still has, run 103's, downloaded and listed" "0 103 the SBOMs of run 103: ff-backend.cdx.json" \
  "$(run master) $(cat "$work/downloaded") $(cat "$work/out")"
check "another branch: its own, run 102's" "0 102" "$(run feat/step-5) $(cat "$work/downloaded")"
check "a branch with none kept: it fails, saying so, and downloads nothing" "1 no SBOM kept for wip: its next push's security job writes them false" \
  "$(run wip) $(cat "$work/out") $([ -f "$work/downloaded" ] && echo true || echo false)"

checks_done last-sboms
