#!/usr/bin/env bash
# Every SAM template the repository keeps, checked as AWS's users check one: `sam validate --lint`, SAM's transform
# with cfn-lint inside it, as hack/install-tools.sh pins them. The ff command's fixtures, its templates, and the SAM
# spike's app: a template FF refuses is still SAM's own, so each must be valid there, and one ff export writes must
# deploy on AWS. Found by their Transform line, so that a new fixture is checked without a word here. The region is one
# of AWS's, as cfn-lint knows no other; nothing reaches AWS. About 2 s a template.
#   hack/test-sam-fixtures.sh
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sam="$repo/hack/bin/sam"
work="$(mktemp -d)"
source "$repo/hack/lib/checks.sh"
on_exit 'rm -rf "$work"'
[ -x "$sam" ] || fail "the SAM CLI, which hack/install-tools.sh sam installs in hack/bin"

section "the SAM templates kept as fixtures, which sam validate --lint takes"
mapfile -t templates < <(git -C "$repo" grep -l -E '^Transform: AWS::Serverless-2016-10-31' -- '*.yaml' '*.yml')
check "the fixtures found: the ff command's, its templates' and the spike's" "true" \
  "$([ "${#templates[@]}" -ge 10 ] && echo true || echo false)"
for template in "${templates[@]}"; do
  # A copy alone in a folder, as the SAM CLI reads a template's folder for its code; ff init's own filled as ff init
  # fills it for Node.js.
  rm -rf "$work/app"
  mkdir "$work/app"
  sed -e 's/{{name}}/hello/g' -e 's|{{code_uri}}|hello-world/|g' -e 's/{{handler}}/app.lambdaHandler/g' \
    -e 's/{{runtime}}/nodejs24.x/g' "$repo/$template" >"$work/app/template.yaml"
  code=0
  (cd "$work/app" && SAM_CLI_TELEMETRY=0 "$sam" validate --lint --region eu-west-3) >"$work/out" 2>&1 || code=$?
  check "$template" "0 true" "$code $(grep 'is a valid SAM Template' "$work/out" >/dev/null && echo true || echo false)"
  [ "$code" = 0 ] || sed 's/^/       /' "$work/out"
done
checks_done sam-fixtures
