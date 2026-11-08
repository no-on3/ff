#!/usr/bin/env bash
# The developer tools' spike of minisign's signatures verified in Rust, as `ff` will verify its update notice's manifest
# and the images' archives it loads (src/lib.rs). Its fixtures are signed by the minisign hack/install-tools.sh pins,
# made once and committed, the keys' secret halves left in hack/.spike-minisign/ (FIXTURES=1 makes them again, new keys
# and all); then the crate's tests, with the blake2 crate and without it; minisign's own release files verified against
# its author's key, as `minisign -V` verifies them, and a changed one refused; then what each BLAKE2b costs: the crates
# the blake2 crate brings, the command's size with it and without, and the time each takes over 256 MB, beside
# openssl's. What it found lands in hack/.spike-minisign/results.md.
#   hack/spikes/minisign/run.sh      # about a minute the first time
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
work="$repo/hack/.spike-minisign"
source "$repo/hack/lib/checks.sh"
# minisign's own releases are signed by this key, as its README gives it.
AUTHORS_KEY=RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
mkdir -p "$work"
results="$work/results.md"
export CARGO_TARGET_DIR="$work/target" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" RUST_TEST_THREADS="${RUST_TEST_THREADS:-2}"
"$repo/hack/install-tools.sh" minisign >/dev/null
minisign="$repo/hack/bin/minisign"

section "the fixtures, signed by $("$minisign" -v)"
fixtures="$here/fixtures"
if [ "${FIXTURES:-}" = 1 ] || [ ! -f "$fixtures/latest.json.minisig" ]; then
  rm -f "$work"/*.key
  "$minisign" -G -W -f -p "$fixtures/release.pub" -s "$work/release.key" >/dev/null
  "$minisign" -G -W -f -p "$fixtures/other.pub" -s "$work/other.key" >/dev/null
  # A manifest as the update notice will read one: the newest version, each file's name and SHA-256.
  printf '%s\n' '{"version":"0.1.0","files":{"ff-linux-x86_64":"9a599b48ba6eb7b1e80f12f36b94ceca7c00b7a5173c95c3efc88d9822957e73"}}' \
    >"$fixtures/latest.json"
  "$minisign" -S -s "$work/release.key" -m "$fixtures/latest.json" >/dev/null
  "$minisign" -S -l -s "$work/release.key" -m "$fixtures/latest.json" -x "$fixtures/latest.json.legacy.minisig" >/dev/null
fi
check "minisign verifies its own fixture" 0 "$("$minisign" -Vqm "$fixtures/latest.json" -p "$fixtures/release.pub" >/dev/null; echo $?)"

section "the crate: its tests, with the blake2 crate and without it"
"$repo/hack/check-resources.sh"
tests() { (cd "$here" && cargo test --locked --quiet --lib "$@" 2>&1) | sed -n 's/^test result: \(ok\. [0-9]* passed\).*/\1/p'; }
with_crate="$(tests)"
without_crate="$(tests --no-default-features)"
check "the tests pass with the blake2 crate" true "$([[ "$with_crate" == "ok. "* ]] && echo true || echo "$with_crate")"
check "the tests pass with the hand-written BLAKE2b alone" true "$([[ "$without_crate" == "ok. "* ]] && echo true || echo "$without_crate")"
(cd "$here" && cargo build --locked --quiet --release --no-default-features)
cp "$work/target/release/minisign-spike" "$work/spike-by-hand"
(cd "$here" && cargo build --locked --quiet --release)
spike="$work/target/release/minisign-spike"

section "minisign's own release, verified against its author's key"
release_files=(minisign-0.12-linux.tar.gz minisign-0.12-macos.zip minisign-0.12-win64.zip minisign-0.12.tar.gz)
mkdir -p "$work/release"
for file in "${release_files[@]}"; do
  for name in "$file" "$file.minisig"; do
    [ -f "$work/release/$name" ] ||
      curl -fsSL --retry 3 -o "$work/release/$name" "https://github.com/jedisct1/minisign/releases/download/0.12/$name"
  done
  for hasher in by-hand crate; do
    check "$file, $hasher" true \
      "$("$spike" verify "$AUTHORS_KEY" "$work/release/$file" "$work/release/$file.minisig" "$hasher" >/dev/null && echo true || echo false)"
  done
done
cp "$work/release/minisign-0.12-macos.zip" "$work/release/changed.zip"
printf x >>"$work/release/changed.zip"
refusal="$("$spike" verify "$AUTHORS_KEY" "$work/release/changed.zip" "$work/release/minisign-0.12-macos.zip.minisig" 2>&1 >/dev/null)" &&
  status=0 || status=$?
check "a changed file refused, as minisign refuses it" \
  "$work/release/changed.zip: the signature doesn't match the file: it was changed, or another key signed it (exit 1)" "$refusal (exit $status)"
check "minisign refuses it too" 1 "$("$minisign" -Vqm "$work/release/changed.zip" -x "$work/release/minisign-0.12-macos.zip.minisig" -P "$AUTHORS_KEY" >/dev/null 2>&1; echo $?)"

section "what each BLAKE2b costs"
crates() { (cd "$here" && cargo tree --locked -e normal --prefix none "$@" | sed 's/ (\*)$//' | sort -u | grep -v '^minisign-spike'); }
crates --no-default-features >"$work/crates-by-hand"
crates >"$work/crates-with-blake2"
added="$(comm -13 "$work/crates-by-hand" "$work/crates-with-blake2" | awk '{ print $1 " " $2 }' | paste -sd, | sed 's/,/, /g')"
size() { stat -c %s "$1"; }
[ -f "$work/random-256m" ] || head -c 268435456 /dev/urandom >"$work/random-256m"
expected="$(openssl dgst -blake2b512 -r "$work/random-256m" | cut -d' ' -f1)"
timed() { # <command…>: its first word of output, then its milliseconds
  local started ended out
  started="$(date +%s%N)"
  out="$("$@" | cut -d' ' -f1)"
  ended="$(date +%s%N)"
  echo "$out $(((ended - started) / 1000000))"
}
read -r by_hand by_hand_ms < <(timed "$spike" hash "$work/random-256m" by-hand)
read -r crate crate_ms < <(timed "$spike" hash "$work/random-256m" crate)
read -r _ openssl_ms < <(timed openssl dgst -blake2b512 -r "$work/random-256m")
check "the hand-written BLAKE2b gives openssl's digest of 256 MB" "$expected" "$by_hand"
check "the blake2 crate gives it too" "$expected" "$crate"

{ echo "# minisign's signatures verified in Rust ($(date -u +%F))"; echo
  echo "With $("$minisign" -v), ring 0.17 and the blake2 crate $(sed -n 's/^blake2 v//p' "$work/crates-with-blake2"), Rust $(rustc --version | cut -d' ' -f2), release builds."
  echo; echo "| | the hand-written BLAKE2b (RFC 7693) | the blake2 crate |"; echo "|---|---|---|"
  echo "| tests | $without_crate | $with_crate |"
  echo "| crates it adds | none | $added |"
  echo "| the spike's command, release build | $(size "$work/spike-by-hand") bytes | $(size "$spike") bytes |"
  echo "| 256 MB hashed | $by_hand_ms ms | $crate_ms ms |"
  echo; echo "openssl hashes the same 256 MB in $openssl_ms ms. The lines of src/blake2b.rs: $(grep -cvE '^\s*(//|$)' "$here/src/blake2b.rs"), its tests among them; of src/lib.rs: $(grep -cvE '^\s*(//|$)' "$here/src/lib.rs")."
} >"$results"
cat "$results"
checks_done spike-minisign
