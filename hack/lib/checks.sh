# shellcheck shell=bash
# The suites' checks, one way for all of them. A check prints ok or FAIL; a failed one is recorded with its section and
# its time, and the suite goes on, so that one run reports every failure rather than the first. fail() is for what
# nothing after it can pass without (the backend not starting): it ends the run, or in a suite of sections
# (hack/lib/sections.sh) its section, those that need it then not run. At exit, the suite's own cleanup runs first
# (on_exit), then the failures are listed in order, last in the output, with where the run stopped if it did.
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/checks.sh"     then section, check, fail, on_exit, and checks_done last
#   FF_FAIL_FAST=1              stops at the first failed check, as the suites did before, for a laptop
#   FF_CHECKS_REPORT=<file>     also appends the failures there, in Markdown: hack/ci.sh's report, GitHub's summary
passed=0
checks_section=''
# A file, not a variable: a check in a subshell or a pipeline's loop is recorded too, where a variable would be lost.
checks_failures="$(mktemp)"
checks_exit_commands=()
checks_status=0
checks_finished=false
checks_stopped=''
checks_line=''
checks_command=''

section() { # <title>: prints it, and names the checks after it in the failures' list
  checks_section="$1"
  echo "== $1"
}

check() { # <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
    passed=$((passed + 1))
  else
    checks_record "$1 (expected '$2', got '$3')"
  fi
}

fail() { # <description>: recorded, and the run, or its section, ends: what follows can't pass without it
  checks_record "$1"
  checks_stopped="a failure nothing after it can pass without"
  exit 1
}

checks_record() { # <what failed>
  # One line each in the file, whatever the value held: its line breaks and tabs as " | " and spaces.
  local line="${1//$'\n'/ | }"
  printf '%s\t%s\t%s\n' "$(date -u +%T)" "${checks_section:-before the first section}" "${line//$'\t'/ }" >>"$checks_failures"
  echo "  FAIL $1" >&2
  if [ "${FF_FAIL_FAST:-}" = 1 ]; then
    checks_stopped="the first failed check, as FF_FAIL_FAST=1 asks"
    exit 1
  fi
  return 0
}

on_exit() { # <command>: run at exit, its status in $checks_status, the last added first, before the failures' list
  checks_exit_commands=("$1" "${checks_exit_commands[@]}")
}

checks_done() { # <suite>: the suite's last line; it fails the run when a check failed
  local failed
  failed="$(wc -l <"$checks_failures")"
  checks_finished=true
  checks_suite="$1"
  if [ "$failed" -eq 0 ]; then
    echo "$1: $passed checks passed"
  else
    echo "$1: $passed checks passed, $failed failed" >&2
    exit 1
  fi
}

# Ends a run that ran nothing, a list or a usage error: no report, and no cleanup, which would remove a stack kept up.
checks_quit() { # <status>
  checks_finished=true
  checks_exit_commands=()
  exit "$1"
}

# Each failure, a line: its time, its section, what failed; a section's later failures marked as after its first,
# since they often follow from it (an empty ID after a failed create).
checks_list() {
  awk -F '\t' '{ after = ($2 == last) ? "  (after the failure above, in the same section)" : ""; last = $2; print "  " $1 "  " $2 ": " $3 after }' "$checks_failures"
}

checks_report() {
  local failed suite="${checks_suite:-$(basename "$0" .sh)}" stopped=''
  failed="$(wc -l <"$checks_failures")"
  if [ "$checks_status" -ne 0 ] && ! $checks_finished; then
    stopped="the run stopped early, in \"${checks_section:-before the first section}\", at ${checks_stopped:-${checks_command:+line $checks_line: $checks_command}}"
    [ -n "${checks_stopped}${checks_command}" ] || stopped+="exit status $checks_status"
    stopped+="; the checks after it did not run"
  fi
  [ "$failed" -gt 0 ] || [ -n "$stopped" ] || return 0
  {
    echo
    [ "$failed" -eq 0 ] || { echo "$suite: $failed failed check(s), in order:"; checks_list; }
    [ -z "$stopped" ] || echo "$suite: $stopped"
  } >&2
  if [ -n "${FF_CHECKS_REPORT:-}" ]; then
    {
      echo "### $suite: $failed failed check(s)${stopped:+, stopped early}"
      echo
      echo '```text'
      checks_list
      [ -z "$stopped" ] || echo "  $stopped"
      echo '```'
      echo
    } >>"$FF_CHECKS_REPORT"
  fi
}

checks_exit() {
  checks_status=$?
  local command failed
  for command in "${checks_exit_commands[@]}"; do eval "$command" || true; done
  checks_report
  failed="$(wc -l <"$checks_failures")"
  rm -f "$checks_failures"
  # A failure recorded fails the run, even one that ended without checks_done.
  if [ "$failed" -gt 0 ] && [ "$checks_status" -eq 0 ]; then exit 1; fi
}

# Where a command stopped the run under set -e: inherited by functions (errtrace), so the innermost failing command is
# named, not only the line that called it. In a subshell it changes nothing outside.
set -o errtrace
trap 'checks_line=$LINENO; checks_command=$BASH_COMMAND' ERR
trap checks_exit EXIT
