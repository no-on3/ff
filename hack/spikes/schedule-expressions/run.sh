#!/usr/bin/env bash
# The developer tools' spike of EventBridge's schedule expressions read in Rust, as `ff local` will run a function's
# schedules (src/lib.rs, the backend's reader ported). Its tests read the table the backend's own tests read
# (BE/src/schedules/schedule-expressions.json); then both readers read the same expressions made at random
# (generate.mjs), the backend's run by Node.js as it is (backend.mts), and must say the same of each, word for word:
# its next runs to the millisecond, or its refusal. Then what each takes for an expression that never runs, which is
# read to its last year. What it found lands in hack/.spike-schedule-expressions/results.md.
#   hack/spikes/schedule-expressions/run.sh                    # under a minute
#   LINES=100000 SEED=2 hack/spikes/schedule-expressions/run.sh   # more expressions, others
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
work="$repo/hack/.spike-schedule-expressions"
source "$repo/hack/lib/checks.sh"
lines="${LINES:-20000}"
seed="${SEED:-1}"
mkdir -p "$work"
results="$work/results.md"
export CARGO_TARGET_DIR="$work/target" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" RUST_TEST_THREADS="${RUST_TEST_THREADS:-2}"
backend() { node --no-warnings "$here/backend.mts"; }
spike="$work/target/release/schedule-expressions-spike"

section "the Rust reader's tests, the backend's table among them"
"$repo/hack/check-resources.sh"
tests="$( (cd "$here" && cargo test --locked --quiet --lib 2>&1) | sed -n 's/^test result: \(ok\. [0-9]* passed\).*/\1/p')"
check "the tests pass" true "$([[ "$tests" == "ok. "* ]] && echo true || echo "$tests")"
table="$(node -e '
  const t = require(process.argv[1]);
  const cases = t.runs.reduce((n, test) => n + test.cases.length, 0);
  console.log(`${t.rates.length} rates, ${t.refused.length} refusals, ${t.runs.length} tests of runs with ${cases} cases`);
' "$repo/BE/src/schedules/schedule-expressions.json")"
(cd "$here" && cargo build --locked --quiet --release)

section "both readers, on $lines expressions made at random (seed $seed)"
node "$here/generate.mjs" "$lines" "$seed" >"$work/expressions.tsv"
timed() { # <output file> <command…> < input: the command's milliseconds
  local out="$1" started ended
  shift
  started="$(date +%s%N)"
  "$@" >"$out"
  ended="$(date +%s%N)"
  echo $(((ended - started) / 1000000))
}
rust_ms="$(timed "$work/rust.txt" "$spike" <"$work/expressions.tsv")"
backend_ms="$(timed "$work/backend.txt" backend <"$work/expressions.tsv")"
check "each reader answers every line" "$lines $lines" "$(wc -l <"$work/rust.txt" | tr -d ' ') $(wc -l <"$work/backend.txt" | tr -d ' ')"
differences="$(paste "$work/rust.txt" "$work/backend.txt" | awk -F'\t' '$1 != $2' | wc -l | tr -d ' ')"
check "they say the same of every expression" 0 "$differences"
if [ "$differences" != 0 ]; then
  paste "$work/rust.txt" "$work/backend.txt" | awk -F'\t' '$1 != $2 { print NR }' | head -5 |
    while read -r line; do echo "  line $line: $(sed -n "${line}p" "$work/expressions.tsv")"; done
fi
with_runs="$(grep -c '^runs: [0-9]' "$work/rust.txt" || true)"
none_left="$(grep -c '^runs: $' "$work/rust.txt" || true)"
refused="$(grep -c '^refused: ' "$work/rust.txt" || true)"
# The refusals' kinds: each message with what it quotes and the value it got taken out.
kinds="$(sed -n 's/^refused: //p' "$work/rust.txt" | sed 's/"[^"]*"/"…"/g; s/; got .*//; s/rate([^)]*) must/rate(…) must/' | sort -u | wc -l | tr -d ' ')"
check "some expressions run, some have no run left, some are refused" true \
  "$([ "$with_runs" -gt 0 ] && [ "$none_left" -gt 0 ] && [ "$refused" -gt 0 ] && echo true || echo "$with_runs $none_left $refused")"

section "an expression that never runs, read to its last year"
# February has no 31st: each reader walks every day to 2199's end before saying so.
never="$work/never.tsv"
for _ in $(seq 100); do printf '%s\t5\t%s\n' 1792540800000 'cron(0 0 31 2 ? *)'; done >"$never"
never_rust_ms="$(timed "$work/never-rust.txt" "$spike" <"$never")"
never_backend_ms="$(timed "$work/never-backend.txt" backend <"$never")"
check "neither finds a run" "100 100" "$(grep -c '^runs: $' "$work/never-rust.txt") $(grep -c '^runs: $' "$work/never-backend.txt")"

lines_of() { grep -cvE '^\s*(//|/?\*|$)' "$1"; }
rust_reader="$(sed '/^#\[cfg(test)\]/,$d' "$here/src/lib.rs" | grep -cvE '^\s*(//|$)')"
{ echo "# EventBridge's schedule expressions read in Rust ($(date -u +%F))"; echo
  echo "Rust $(rustc --version | cut -d' ' -f2), Node.js $(node --version), release build."
  echo; echo "| | |"; echo "|---|---|"
  echo "| The Rust reader's tests | $tests, the backend's table among them: $table |"
  echo "| Expressions made at random, seed $seed | $lines: $with_runs with runs, $none_left with no run left, $refused refused, in $kinds kinds of refusal |"
  echo "| Where the two readers differ | $differences |"
  echo "| Each reader on them | Rust $rust_ms ms, the backend's $backend_ms ms (Node.js's start included) |"
  echo "| \`cron(0 0 31 2 ? *)\`, which never runs, 100 times | Rust $never_rust_ms ms, the backend's $never_backend_ms ms |"
  echo "| The reader's lines, without comments or tests | Rust $rust_reader, the backend's $(lines_of "$repo/BE/src/schedules/schedule-expression.ts") |"
} >"$results"
cat "$results"
checks_done spike-schedule-expressions
