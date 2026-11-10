# shellcheck shell=bash
# Where a spike works: hack/.spikes/<name>, which git ignores, for its downloads, logs and results; and one folder
# beside them, hack/.spikes/target, where every Rust spike builds, with the workers capped as the machine needs (the
# repository's CLAUDE.md). Sourced by hack/spikes/*/ scripts once $repo is set:
#   source "$repo/hack/lib/spikes.sh"; spike_work <name>      # sets $work, and CARGO_TARGET_DIR for cargo
spike_work() {
  work="$repo/hack/.spikes/$1"
  mkdir -p "$work"
  export CARGO_TARGET_DIR="$repo/hack/.spikes/target" CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" RUST_TEST_THREADS="${RUST_TEST_THREADS:-2}"
}
