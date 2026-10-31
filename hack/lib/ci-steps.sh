# shellcheck shell=bash
# hack/ci.sh's steps: each one run, timed and reported, and a failed one listed while the next one runs, so that a run
# reports every failed step, not only the first; but for what the steps after it need (npm ci, the dev cluster), whose
# failure stops the run. At exit the cleanups run, then hack/.ci/report.md is written: its headline, each step with its
# result and its seconds, and the suites' failed checks, which hack/lib/checks.sh writes; GitHub shows it as the job's
# summary. FF_FAIL_FAST=1 stops at the first failure, as the suites do.
#   ci_dir=<directory>; source "$repo/hack/lib/ci-steps.sh"; ci_stages="<the stages>"
#   step <name> <command...>        a step on its own: its failure is reported, and the run goes on
#   prepare <name> <command...>     what the steps after it need: its failure stops the run
#   ci_cleanups+=("<command>")      run at exit, whatever happened
#   ci_done                         after the stages: exits 1 when a step failed
ci_report="$ci_dir/report.md"
ci_steps_rows="$ci_dir/report-steps.md"
export FF_CHECKS_REPORT="$ci_dir/report-checks.md"
: >"$ci_steps_rows"
: >"$FF_CHECKS_REPORT"
ci_stages=''
ci_failed_steps=()
ci_stopped_at=''
ci_outcome=''
ci_cleanups=()

# A step runs as an `if`'s condition, where bash ignores `set -e`: a step of several commands checks each one.
ci_run_step() { # step|prepare <name> <command...>
  local kind="$1" name="$2" start=$SECONDS
  shift 2
  echo "== $name"
  if "$@"; then
    echo "   ok, $((SECONDS - start)) s"
    echo "| $name | ok | $((SECONDS - start)) |" >>"$ci_steps_rows"
    return 0
  fi
  echo "FAILED: $name ($((SECONDS - start)) s)" >&2
  echo "| $name | **FAILED** | $((SECONDS - start)) |" >>"$ci_steps_rows"
  ci_failed_steps+=("$name")
  if [ "$kind" = prepare ] || [ "${FF_FAIL_FAST:-}" = 1 ]; then
    ci_stopped_at="$name"
    exit 1
  fi
}
step() { ci_run_step step "$@"; }
prepare() { ci_run_step prepare "$@"; }

ci_failed_list() { printf '"%s", ' "${ci_failed_steps[@]}" | sed 's/, $//'; }

ci_done() {
  if [ ${#ci_failed_steps[@]} -gt 0 ]; then
    echo "ci: $ci_stages: ${#ci_failed_steps[@]} step(s) failed: $(ci_failed_list)" >&2
    exit 1
  fi
  ci_outcome=passed
  echo "ci: $ci_stages passed"
}

ci_exit() {
  local status=$? command
  for command in "${ci_cleanups[@]}"; do eval "$command" || true; done
  {
    if [ ${#ci_failed_steps[@]} -gt 0 ]; then
      echo "## hack/ci.sh ${ci_stages}: failed at $(ci_failed_list)${ci_stopped_at:+; the run stopped at \"$ci_stopped_at\"}"
    else
      echo "## hack/ci.sh ${ci_stages}: ${ci_outcome:-stopped, exit status $status}"
    fi
    echo
    if [ -s "$ci_steps_rows" ]; then
      echo '| Step | Result | Seconds |'
      echo '|---|---|---|'
      cat "$ci_steps_rows"
      echo
    fi
    cat "$FF_CHECKS_REPORT"
  } >"$ci_report"
  # On GitHub, the job's summary page.
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || cat "$ci_report" >>"$GITHUB_STEP_SUMMARY"
  [ ! -d "$ci_dir/failure" ] || echo "what the failed suites left behind: hack/.ci/failure/; the failed checks: hack/.ci/report.md" >&2
}
trap ci_exit EXIT
