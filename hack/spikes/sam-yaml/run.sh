#!/usr/bin/env bash
# Step 5's spike of reading a SAM template's YAML in Rust, as `ff deploy` will (src/lib.rs, on yaml-rust2's events):
# its tests, then templates read as JSON and compared with what cfn-flip, AWS's own converter, makes of them: `sam
# init`'s hello-world for Node.js and for Python, the Lambda spike's small app (hack/spikes/lambda/sam/), and two
# fixtures, every short tag CloudFormation has and the plain scalars YAML 1.1 and 1.2 read otherwise. The SAM
# CLI is hack/install-tools.sh's, with a home of its own, where `sam init` keeps the templates it downloads. What it
# found lands in hack/.spike-sam-yaml/results.md.
#   hack/spikes/sam-yaml/run.sh      # about 2 minutes, the crate's first build and sam init's downloads included
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
work="$repo/hack/.spike-sam-yaml"
source "$repo/hack/lib/checks.sh"
CFN_FLIP_VERSION="${CFN_FLIP_VERSION:-1.3.0}"
mkdir -p "$work"
results="$work/results.md"
export CARGO_TARGET_DIR="$work/target" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" RUST_TEST_THREADS="${RUST_TEST_THREADS:-2}"

section "the reader: its tests and its build"
"$repo/hack/check-resources.sh"
(cd "$here" && cargo test --locked --quiet 2>&1) | tail -3
(cd "$here" && cargo build --locked --quiet)
reader="$work/target/debug/sam-yaml-spike"
check "built" true "$([ -x "$reader" ] && echo true || echo false)"

section "cfn-flip $CFN_FLIP_VERSION, and the SAM CLI"
[ -x "$work/venv/bin/python" ] || python3 -m venv "$work/venv"
[ "$("$work/venv/bin/pip" show cfn-flip 2>/dev/null | sed -n 's/^Version: //p')" = "$CFN_FLIP_VERSION" ] ||
  "$work/venv/bin/pip" install --quiet --disable-pip-version-check "cfn-flip==$CFN_FLIP_VERSION"
"$repo/hack/install-tools.sh" sam >/dev/null
sam=(env HOME="$work/home" SAM_CLI_TELEMETRY=0 "$repo/hack/bin/sam")
sam_version="$("${sam[@]}" --version)"
echo "  $sam_version"

section "sam init's hello-world, for Node.js and for Python"
rm -rf "$work/init"
for app in hello-node:nodejs22.x:npm hello-python:python3.13:pip; do
  IFS=: read -r name runtime manager <<<"$app"
  "${sam[@]}" init --no-interactive --name "$name" --runtime "$runtime" --dependency-manager "$manager" \
    --app-template hello-world --output-dir "$work/init" >"$work/init-$name.log" 2>&1
  check "$name: made" true "$([ -f "$work/init/$name/template.yaml" ] && echo true || echo false)"
done

section "each template read as cfn-flip reads it"
# The long forms in a template's JSON, by name, with their counts.
long_forms() { jq -c '[.. | objects | keys[] | select(. == "Ref" or . == "Condition" or startswith("Fn::"))] | group_by(.) | map({(.[0]): length}) | add // {}'; }
{ echo "# A SAM template's YAML, read in Rust ($(date -u +%F))"; echo
  echo "yaml-rust2 0.13's events, against cfn-flip $CFN_FLIP_VERSION; the templates of $sam_version's \`sam init\` and the Lambda spike's small app."
  echo; echo "| template | lines | the reader's JSON and cfn-flip's | long forms | the first tagged value's text, where it starts |"; echo "|---|---|---|---|---|"; } >"$results"
for template in "$work/init/hello-node/template.yaml" "$work/init/hello-python/template.yaml" "$repo/hack/spikes/lambda/sam/template.yaml" \
  "$here/fixtures/every-tag.yaml" "$here/fixtures/yaml-1-1.yaml"; do
  name="${template#"$repo/"}"
  ours="$("$reader" "$template" | jq -S .)"
  theirs="$("$work/venv/bin/cfn-flip" -j "$template" | jq -S .)"
  same="$([ "$ours" = "$theirs" ] && echo the same || diff <(echo "$theirs") <(echo "$ours") | head -12 | tr '\n' ' ')"
  check "${name#hack/.spike-sam-yaml/}: the same JSON as cfn-flip's" "the same" "$same"
  # The first !GetAtt's line and column, as a message would name it; else the first short tag's.
  first="$("$reader" "$template" --at | while read -r at pointer; do
      jq -e --arg p "$pointer" 'getpath($p | ltrimstr("/") | split("/") | map(tonumber? // .)) | objects | keys[0] | select(. == "Ref" or startswith("Fn::"))' \
        <<<"$ours" >/dev/null 2>&1 && { echo "$at $pointer"; break; }
    done || true)"
  echo "| \`${name#hack/.spike-sam-yaml/}\` | $(wc -l <"$template") | $same | $(long_forms <<<"$ours") | ${first:-none} |" >>"$results"
done

section "what it refuses, at its line"
printf 'Resources:\n  Fn:\n    Properties:\n      Role: !GetAttr Fn.Arn\n' >"$work/unknown-tag.yaml"
check "a tag CloudFormation doesn't have: named, with its line" \
  "$work/unknown-tag.yaml, line 4, column 22: !GetAttr: not one of CloudFormation's tags, which are !Ref, !Condition, !And, !Base64, !Cidr, !Equals, !FindInMap, !GetAtt, !GetAZs, !If, !ImportValue, !Join, !Not, !Or, !Select, !Split, !Sub, !Transform" \
  "$("$reader" "$work/unknown-tag.yaml" 2>&1 >/dev/null || true)"
{ echo; echo "A tag CloudFormation doesn't have, refused: \`$("$reader" "$work/unknown-tag.yaml" 2>&1 >/dev/null | sed "s|$repo/||" || true)\`"; } >>"$results"

echo "the results: $results"
checks_done spike-sam-yaml
