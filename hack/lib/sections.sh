# shellcheck shell=bash
# A suite's sections, each a function run in order: all of them, the ones named with what they need, or from one on,
# so that a part of a suite runs alone (hack/e2e.sh --only queues) without the rest before it. Each runs in a subshell
# of its own, so that one which stops, at a failed command under set -e or at fail(), stops alone: it is recorded as a
# failure at its line, the sections that need it are recorded as not run, and the others run. What a section leaves,
# its variables and its functions, passes to the suite's shell as if it had run there. Each section's time is kept in
# the suite's work directory, and --list shows the last run's. A section's budget is the seconds a whole run should
# take in it: one that takes longer is said after the last section and in hack/ci.sh's report, a flag, not a failure,
# so that a suite stays the size it was as sections come; a section run alone waits its minutes out, and is not.
#   source "$FF_REPO_ROOT/hack/lib/sections.sh"; sections_options "$@"; set -- "${sections_rest[@]}"
#   section_def <id> <function> [needs...] budget=<seconds>   each section, in order, after its function
#   sections_run                                    then checks_done
#   <suite> --list | --only <id>[,<id>...] | --from <id>
# The runner's own names all start with sections_: a section's code sees every name of the shell that runs it, and a
# suite's must not be hidden by one of the runner's.
sections_order=()
declare -A sections_fn=() sections_needs=() sections_outcome=() sections_budget=()
sections_only=''
sections_from=''
sections_list=false
sections_rest=()

sections_options() { # the suite's arguments: its own come back in sections_rest
  while [ $# -gt 0 ]; do
    case "$1" in
      --list) sections_list=true ;;
      --only) sections_only="${2:?--only needs sections named, comma-separated}"; shift ;;
      --only=*) sections_only="${1#--only=}" ;;
      --from) sections_from="${2:?--from needs a section named}"; shift ;;
      --from=*) sections_from="${1#--from=}" ;;
      *) sections_rest+=("$1") ;;
    esac
    shift
  done
}

section_def() { # <id> <function> [needs...] [budget=<seconds>]: a section, in the order it runs
  local sections_id="$1" sections_function="$2" sections_word sections_given=()
  shift 2
  for sections_word in "$@"; do
    case "$sections_word" in
      budget=*) sections_budget[$sections_id]="${sections_word#budget=}" ;;
      *) sections_given+=("$sections_word") ;;
    esac
  done
  sections_order+=("$sections_id")
  sections_fn[$sections_id]="$sections_function"
  sections_needs[$sections_id]="${sections_given[*]}"
}

# The sections a whole run took longer in than their budgets: said, and added to hack/ci.sh's report.
sections_over_budget() { # <"id: seconds against budget">...
  local sections_suite="${checks_suite:-$(basename "$0" .sh)}"
  echo "sections over their budget, a flag: $(printf '%s; ' "$@" | sed 's/; $//')"
  [ -n "${FF_CHECKS_REPORT:-}" ] || return 0
  {
    echo "### $sections_suite: sections over their budget"
    echo
    echo '```text'
    printf '  %s\n' "$@"
    echo '```'
    echo
  } >>"$FF_CHECKS_REPORT"
}

# The sections to run, in order: every one, or those asked for and, transitively, what they need.
sections_wanted() {
  local -A sections_want=()
  local sections_id sections_need sections_queue=() sections_started=false
  if [ -n "$sections_only" ]; then
    IFS=, read -r -a sections_queue <<<"$sections_only"
  elif [ -n "$sections_from" ]; then
    for sections_id in "${sections_order[@]}"; do
      [ "$sections_id" = "$sections_from" ] && sections_started=true
      ! $sections_started || sections_queue+=("$sections_id")
    done
    [ ${#sections_queue[@]} -gt 0 ] || sections_queue=("$sections_from")
  else
    printf '%s\n' "${sections_order[@]}"
    return 0
  fi
  while [ ${#sections_queue[@]} -gt 0 ]; do
    sections_id="${sections_queue[0]}"
    sections_queue=("${sections_queue[@]:1}")
    [ -n "${sections_fn[$sections_id]:-}" ] || { echo "no section $sections_id; the sections: ${sections_order[*]}" >&2; return 2; }
    [ -z "${sections_want[$sections_id]:-}" ] || continue
    sections_want[$sections_id]=1
    for sections_need in ${sections_needs[$sections_id]}; do sections_queue+=("$sections_need"); done
  done
  for sections_id in "${sections_order[@]}"; do [ -z "${sections_want[$sections_id]:-}" ] || echo "$sections_id"; done
}

# The title a section prints: the first `section "…"` line of its function, as written. Every line is read, as a reader
# that stops at the first would fail its writer under pipefail.
section_title() {
  local sections_titles
  sections_titles="$(declare -f "${sections_fn[$1]}" | sed -n 's/^ *section "\(.*\)";* *$/\1/p')"
  echo "${sections_titles%%$'\n'*}"
}

# Names a section's subshell does not pass back: the shell's own, which it sets for itself or which can't be set, and
# why the section stopped, which is its own.
sections_unpassed=' BASHOPTS BASHPID BASH_ALIASES BASH_ARGC BASH_ARGV BASH_ARGV0 BASH_CMDS BASH_COMMAND BASH_LINENO
  BASH_MONOSECONDS BASH_REMATCH BASH_SOURCE BASH_SUBSHELL BASH_TRAPSIG BASH_VERSINFO BASH_VERSION COLUMNS DIRSTACK
  EPOCHREALTIME EPOCHSECONDS EUID FUNCNAME GROUPS HISTCMD LINENO LINES OLDPWD OPTARG OPTIND PIPESTATUS PPID PWD RANDOM
  SECONDS SHELLOPTS SHLVL SRANDOM UID _
  checks_command checks_line checks_stopped '

# At a section's start, in its subshell: what the shell holds before it, so that what it adds or changes can be told,
# each plain value copied.
sections_enter() {
  local sections_name
  sections_variables_before=" $(compgen -v | tr '\n' ' ') "
  sections_functions_before=" $(compgen -A function | tr '\n' ' ') "
  declare -gA sections_was=()
  for sections_name in $sections_variables_before; do
    if [ -n "${!sections_name+set}" ] && [ -z "${!sections_name@a}" ]; then sections_was[$sections_name]="${!sections_name}"; fi
  done
  checks_stopped='' checks_line='' checks_command=''
}

# At a section's subshell's end: why it stopped, if it did, then what it leaves as commands that make it in the suite's
# shell, into <file>: its variables, but for the environment's it didn't add, and the functions it defined. A plain
# value is passed only if new or changed, as passing a large one again (an answer of 2 MB) costs a tenth of a second
# each time; an array, or a value with attributes, goes through declare -p and a file, not $(…), which would fork once a
# variable. A function is passed only if new, since one defined again from the file would name the file, not the suite,
# in its errors.
sections_leave() { # <status> <file>
  local sections_status=$1 sections_file=$2 sections_name sections_value sections_fd
  if [ "$sections_status" -ne 0 ] && [ -z "$checks_stopped" ]; then
    if [ -n "$checks_line" ]; then
      checks_record "the section stopped at line $checks_line, at \`$checks_command\` (exit $sections_status): its checks after it did not run"
    else # as an unset variable stops it under set -u, before any trap
      checks_record "the section stopped (exit $sections_status), at the shell's message above it in the log: its checks after it did not run"
    fi
  fi
  exec {sections_fd}>"$sections_file"
  for sections_name in $(compgen -v); do
    case "$sections_name" in sections_* | LC_* | LANG | LANGUAGE) continue ;; esac
    case "$sections_unpassed" in *[[:space:]]"$sections_name"[[:space:]]*) continue ;; esac
    if [ -n "${!sections_name+set}" ] && [ -z "${!sections_name@a}" ]; then
      if [ -z "${sections_was[$sections_name]+set}" ] || [ "${sections_was[$sections_name]}" != "${!sections_name}" ]; then
        printf 'declare -g -- %s=%q\n' "$sections_name" "${!sections_name}" >&"$sections_fd"
      fi
      continue
    fi
    declare -p "$sections_name" >"$sections_file.value" 2>/dev/null || continue
    IFS= read -r -d '' sections_value <"$sections_file.value" || true
    [[ "$sections_value" == declare\ * && ! "$sections_value" =~ ^declare\ -[a-zA-Z]*r ]] || continue
    [[ ! "$sections_value" =~ ^declare\ -[a-zA-Z]*x || "$sections_variables_before" != *" $sections_name "* ]] || continue
    printf '%s' "declare -g ${sections_value#declare }" >&"$sections_fd"
  done
  for sections_name in $(compgen -A function); do
    [[ "$sections_functions_before" == *" $sections_name "* ]] || declare -f "$sections_name" >&"$sections_fd"
  done
  exec {sections_fd}>&-
  rm -f "$sections_file.value"
}

sections_run() {
  local sections_times="$work/section-times" sections_wanted_ids sections_id sections_need sections_unmet sections_start
  local sections_state sections_status sections_over=()
  local -A sections_seconds=() sections_last=()
  if [ -f "$sections_times" ]; then
    while IFS=$'\t' read -r sections_id sections_start; do sections_last[$sections_id]="$sections_start"; done <"$sections_times"
  fi
  if $sections_list; then
    local sections_width=0
    for sections_id in "${sections_order[@]}"; do [ ${#sections_id} -le "$sections_width" ] || sections_width=${#sections_id}; done
    for sections_id in "${sections_order[@]}"; do
      sections_need="${sections_needs[$sections_id]:+needs: ${sections_needs[$sections_id]}}"
      [ -z "${sections_budget[$sections_id]:-}" ] || sections_need+="${sections_need:+; }budget ${sections_budget[$sections_id]} s"
      printf '%-*s %6s  %s%s\n' "$sections_width" "$sections_id" "${sections_last[$sections_id]:+${sections_last[$sections_id]} s}" \
        "$(section_title "$sections_id")" "${sections_need:+  ($sections_need)}"
    done
    checks_quit 0
  fi
  sections_wanted_ids="$(sections_wanted)" || checks_quit 2 # a usage error, said above
  [ -z "$sections_only$sections_from" ] ||
    echo "sections: $(paste -sd' ' <<<"$sections_wanted_ids"), of ${#sections_order[@]}"
  for sections_id in "${!sections_last[@]}"; do sections_seconds[$sections_id]="${sections_last[$sections_id]}"; done
  mkdir -p "$work/sections"
  for sections_id in $sections_wanted_ids; do
    sections_unmet=''
    for sections_need in ${sections_needs[$sections_id]}; do
      [ "${sections_outcome[$sections_need]:-}" = ok ] || sections_unmet+=" $sections_need"
    done
    if [ -n "$sections_unmet" ]; then
      checks_section="$(section_title "$sections_id")"
      echo "== $checks_section"
      checks_record "not run: it needs${sections_unmet}, which stopped or did not run"
      sections_outcome[$sections_id]=not-run
      continue
    fi
    sections_start=$SECONDS
    sections_state="$work/sections/$sections_id.sh"
    rm -f "$sections_state"
    # set -e inside the subshell holds only if the subshell is not itself a condition: its status is read after it.
    set +e
    (
      set -e
      sections_enter
      trap 'sections_leave $? "$sections_state"' EXIT
      "${sections_fn[$sections_id]}"
    )
    sections_status=$?
    set -e
    # shellcheck source=/dev/null
    [ ! -f "$sections_state" ] || source "$sections_state"
    if [ "$sections_status" -eq 0 ]; then sections_outcome[$sections_id]=ok; else sections_outcome[$sections_id]=stopped; fi
    sections_seconds[$sections_id]=$((SECONDS - sections_start))
    if [ -z "$sections_only$sections_from" ] && [ -n "${sections_budget[$sections_id]:-}" ] &&
      [ "${sections_seconds[$sections_id]}" -gt "${sections_budget[$sections_id]}" ]; then
      sections_over+=("$sections_id: ${sections_seconds[$sections_id]} s against ${sections_budget[$sections_id]}")
    fi
    for sections_need in "${sections_order[@]}"; do
      [ -z "${sections_seconds[$sections_need]:-}" ] || printf '%s\t%s\n' "$sections_need" "${sections_seconds[$sections_need]}"
    done >"$sections_times"
    if [ "$sections_status" -ne 0 ] && [ "${FF_FAIL_FAST:-}" = 1 ]; then
      checks_stopped="the first failed check, as FF_FAIL_FAST=1 asks"
      exit 1
    fi
  done
  [ ${#sections_over[@]} -eq 0 ] || sections_over_budget "${sections_over[@]}"
}
