#!/usr/bin/env bash
# hack/lib/npm-audit.py, on reports of each kind against a list of its own: what fails, what is let through and
# until when, and what it can't read. In a second or so.
#   hack/test-npm-audit.sh
set -euo pipefail
checker="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/npm-audit.py"
work="$(mktemp -d)"
source "$(dirname "${BASH_SOURCE[0]}")/lib/checks.sh"
on_exit 'rm -rf "$work"'
# The checker's exit status, then its lines, on one line: <directory> <report> [list]
run() { local out status=0; out="$(python3 "$checker" "$1" "${3:-$work/list}" --today 2026-10-24 <<<"$2" 2>&1)" || status=$?; echo "$status ${out//$'\n'/ | }"; }
advisory() { # <package> <severity> <GHSA id>: a report with that advisory in that package, and a package it comes through
  printf '{"vulnerabilities": {"%s": {"via": [{"source": 1, "name": "%s", "title": "a flaw", "url": "https://github.com/advisories/%s", "severity": "%s", "range": "<2.0.0"}]}, "uses-it": {"via": ["%s"]}}}' "$1" "$1" "$3" "$2" "$1"
}

cat >"$work/list" <<'EOF'
# Why, above each line.
BE body-parser GHSA-aaaa-aaaa-aaaa 2026-11-05

BE zod GHSA-bbbb-bbbb-bbbb 2026-10-24
FE multer GHSA-cccc-cccc-cccc 2026-11-05
EOF

check "no advisory: it passes, naming this directory's entries nothing needs any more" \
  "0   note: $work/list accepts GHSA-aaaa-aaaa-aaaa in body-parser, which the audit no longer reports: remove it |   note: $work/list accepts GHSA-bbbb-bbbb-bbbb in zod, which the audit no longer reports: remove it |   BE: no high or critical advisory but those accepted (0)" \
  "$(run BE '{"vulnerabilities": {}}')"
check "a high advisory the list doesn't accept fails, named as npm names it, and not again for a package it comes through" \
  "1   FAIL left-pad <2.0.0: high, a flaw (https://github.com/advisories/GHSA-dddd-dddd-dddd)" \
  "$(run FE "$(advisory left-pad high GHSA-dddd-dddd-dddd)" | sed 's/ |   note:.*//')"
check "so does a critical one" "1" "$(run FE "$(advisory left-pad critical GHSA-dddd-dddd-dddd)" | cut -d' ' -f1)"
check "a moderate one passes, as before the list" "0" "$(run FE "$(advisory left-pad moderate GHSA-dddd-dddd-dddd)" | cut -d' ' -f1)"
check "one the list accepts for this directory and package, before its date, is let through and said" \
  "0   accepted body-parser <2.0.0: high, a flaw (https://github.com/advisories/GHSA-aaaa-aaaa-aaaa): accepted until 2026-11-05 |   note: $work/list accepts GHSA-bbbb-bbbb-bbbb in zod, which the audit no longer reports: remove it |   BE: no high or critical advisory but those accepted (1)" \
  "$(run BE "$(advisory body-parser high GHSA-aaaa-aaaa-aaaa)")"
check "on its date, it fails again" \
  "1   FAIL zod <2.0.0: high, a flaw (https://github.com/advisories/GHSA-bbbb-bbbb-bbbb): accepted until 2026-10-24 only" \
  "$(run BE "$(advisory zod high GHSA-bbbb-bbbb-bbbb)" | sed 's/ |   note:.*//')"
check "accepted for another directory, it fails here" "1" "$(run BE "$(advisory multer high GHSA-cccc-cccc-cccc)" | cut -d' ' -f1)"
check "accepted in another package, it fails" "1" "$(run BE "$(advisory express high GHSA-aaaa-aaaa-aaaa)" | cut -d' ' -f1)"
check "npm's own error fails, saying it" "1 BE: npm audit failed: request to the registry failed" \
  "$(run BE '{"error": {"code": "ENOTFOUND", "summary": "request to the registry failed"}}')"
check "no report at all fails, saying it" "1 BE: npm audit gave no report: npm ERR! something" "$(run BE 'npm ERR! something')"
printf 'BE zod GHSA-bbbb-bbbb-bbbb\n' >"$work/short"
check "a line of the list without its date fails, naming the line" \
  "1 $work/short:1: expected <directory> <package> <advisory> <expires>, got: BE zod GHSA-bbbb-bbbb-bbbb" \
  "$(run BE '{"vulnerabilities": {}}' "$work/short")"
printf 'BE zod GHSA-bbbb-bbbb-bbbb soon\n' >"$work/undated"
check "and one whose date is no date" "1 $work/undated:1: soon is no date (YYYY-MM-DD)" "$(run BE '{"vulnerabilities": {}}' "$work/undated")"
checks_done "npm audit's checker"
