#!/usr/bin/env bash
# FF's development server updating itself (../README.md), as root, every 10 minutes, run by ff-updater.timer. It asks
# GitHub for master's newest commit, through git, and for that commit's runs, through GitHub's API. A commit newer
# than the one installed, whose every job passed, is installed at night, between 01:00 and 05:00 in Tunis, as the
# server has customers: FF's databases dumped into /data/ff/backups; the commit's files in a directory of their own;
# that directory's server.sh, never the running copy's, as a script read while it runs must not change; then its
# smoke.sh; then the directory made /data/ff/src. A failure stops the timer, with no retry, until someone looks, and
# is e-mailed to the operator through the server's own mail, Mailpit. Each update's commit, time and result go to
# /data/ff/updater/updates.log, and its whole output beside it, in runs/.
#   /data/ff/src/deploy/dev-server/updater/update.sh        (as root: ff-updater.service runs it)
# Its files, in /data/ff/updater, root's alone: settings and installed, which server.sh's last step writes (the admin
# allow list server.sh needs, the server's mail and its operator; the version it installed); deploy-key and
# github-token, which install.sh carries from the operator's machine: the repository's read-only deploy key, without
# which git reaches GitHub over HTTPS, and a token that reads the workflow's results, without which GitHub's API is
# asked as anyone; both do while the repository is public. Its tests (hack/test-updater.sh) give FF_UPDATER_HOME,
# FF_UPDATER_GIT, FF_UPDATER_API, FF_UPDATER_OWNER and FF_UPDATER_NOW in place of the server's.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository=no-on3/ff
home="${FF_UPDATER_HOME:-/data/ff}"
state="$home/updater"
api="${FF_UPDATER_API:-https://api.github.com}"
owner="${FF_UPDATER_OWNER:-deploy}" # who owns /data/ff/src's files, as install.sh's copy makes them
timer=ff-updater.timer
night_from=1 night_to=5 # an update starts between 01:00 and 05:00 in Tunis
short='' new='' run_log='' started=$SECONDS

say() { echo "update.sh: $*"; } # to the journal: journalctl -u ff-updater
note() { echo "$(date -Is) $*" >>"$state/updates.log" && say "$*"; }
setting() { sed -n "s/^$1=//p" "$state/settings" 2>/dev/null | tail -n 1; }
minutes() { local m=$(((SECONDS - started + 30) / 60)); echo "$((m > 0 ? m : 1)) min"; } # 1 at least

[ -d "$state" ] || { say "no $state: server.sh makes it as its last step"; exit 1; }
exec 9>>"$state/lock"
flock -n 9 || { say "an update, or install.sh's server.sh, holds $state/lock: nothing this round"; exit 0; }
work="$(mktemp -d "$state/.round-XXXXXX")"
trap 'rm -rf "$work"' EXIT

# <subject>: an e-mail to the operator through the server's Mailpit, with the end of the update's output.
email_operator() {
  local smtp operator from
  smtp="$(setting mail)" operator="$(setting operator)"
  [ -n "$smtp" ] && [ -n "$operator" ] || { say "no mail or operator in $state/settings: no e-mail"; return 0; }
  from="updates@${operator#*@}"
  {
    printf 'From: FF updates <%s>\nTo: %s\nSubject: %s\nDate: %s\nContent-Type: text/plain; charset=utf-8\n\n' \
      "$from" "$operator" "FF's development server: $1" "$(date -R)"
    printf '%s.\n\nThe updater is stopped until someone looks: "sudo systemctl enable --now %s" starts it again, as install.sh does.\n' "$1" "$timer"
    if [ -s "$run_log" ]; then printf '\nThe end of %s:\n\n' "$run_log" && tail -n 40 "$run_log"; fi
  } | sed 's/$/\r/' >"$work/message"
  curl -sS --max-time 30 --url "$smtp" --mail-from "$from" --mail-rcpt "$operator" --upload-file "$work/message" ||
    say "couldn't e-mail $operator through $smtp"
}

# <what failed>: the update stopped: its line in the log, the timer stopped, the operator e-mailed. The server stays
# as the failure left it, for someone to look at; ff's build goes back to /data/ff/src, for install.sh's next run.
stopped() {
  note "$1; the updater is stopped"
  if [ -n "$new" ] && [ -d "$new/cli/target" ] && [ -d "$home/src/cli" ] && [ ! -e "$home/src/cli/target" ]; then
    mv "$new/cli/target" "$home/src/cli/target"
  fi
  systemctl disable --now "$timer" >/dev/null 2>&1 || say "couldn't stop $timer"
  email_operator "$1"
  rm -f "$state/running"
  exit 1
}

# An update that never ended: the server restarted, or systemd ended it after its hours (ff-updater.service).
if [ -s "$state/running" ]; then
  read -r short since run_log <"$state/running" || true
  new="$home/src-$short"
  stopped "$short: the update started at $since never ended"
fi

installed="$(cat "$state/installed" 2>/dev/null || true)"
[ -n "$installed" ] || { say "nothing says what is installed: server.sh writes $state/installed as its last step"; exit 1; }
base="${installed%%-dirty-*}" # a commit installed by hand with changes: install.sh's version is <commit>-dirty-<time>

# master's newest commit, from GitHub through git: with the deploy key, GitHub checked against its published host keys.
export GIT_TERMINAL_PROMPT=0 # a repository that asks for a password over HTTPS is refused, not waited on
if [ -n "${FF_UPDATER_GIT:-}" ]; then
  remote="$FF_UPDATER_GIT"
elif [ -s "$state/deploy-key" ]; then
  remote="git@github.com:$repository.git"
  export GIT_SSH_COMMAND="ssh -i $state/deploy-key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$here/github-known-hosts"
else
  remote="https://github.com/$repository.git"
fi
listing="$(git ls-remote "$remote" refs/heads/master)" || { say "git couldn't ask $remote for master: next round"; exit 1; }
newest="${listing%%[[:space:]]*}"
[ -n "$newest" ] || { say "$remote has no master"; exit 1; }
short="${newest:0:12}"
if [ "$short" = "$base" ]; then
  if [ "$installed" = "$base" ]; then
    say "$short, master's newest, is installed"
  else
    say "$installed, master's newest with changes, installed by hand, stays until master moves"
  fi
  exit 0
fi

# That commit's runs, from GitHub's API: its push's, on master, each of whose jobs must have passed.
headers=(-H 'accept: application/vnd.github+json' -H 'x-github-api-version: 2022-11-28')
if [ -s "$state/github-token" ]; then # in a file, never on a command line
  printf 'authorization: Bearer %s\n' "$(tr -d '[:space:]' <"$state/github-token")" >"$work/authorization"
  headers+=(-H "@$work/authorization")
fi
curl -fsS --max-time 30 "${headers[@]}" -o "$work/runs.json" \
  "$api/repos/$repository/actions/runs?head_sha=$newest&event=push&branch=master&per_page=100" ||
  { say "GitHub's API didn't say how $short's runs went (a private repository needs the token install.sh carries): next round"; exit 1; }
# passed, going, failed <conclusion> <run>, or none: GitHub concludes success for a run whose jobs each passed or
# were skipped, as a push of documents skips the tests.
read -r verdict detail < <(python3 -I - "$work/runs.json" <<'PY'
import json, sys
runs = json.load(open(sys.argv[1])).get("workflow_runs", [])
going = [run for run in runs if run["status"] != "completed"]
failed = [run for run in runs if run["conclusion"] != "success"]
if not runs:
    print("none")
elif going:
    print("going", going[0]["html_url"])
elif failed:
    print("failed", failed[0]["conclusion"], failed[0]["html_url"])
else:
    print("passed", runs[0]["html_url"])
PY
) || true
case "${verdict:-}" in
  passed) ;;
  none) say "$short, master's newest, has no run yet"; exit 0 ;;
  going) say "$short's run is still going: $detail"; exit 0 ;;
  failed) say "$short's run didn't pass, $detail: it waits for a commit that does"; exit 0 ;;
  *) say "GitHub's answer on $short's runs isn't one this script reads"; exit 1 ;;
esac

now="${FF_UPDATER_NOW:-now}"
hour="$(TZ=Africa/Tunis date -d "$now" +%-H)"
if [ "$hour" -lt "$night_from" ] || [ "$hour" -ge "$night_to" ]; then
  say "$short passed; it is installed between 0$night_from:00 and 0$night_to:00 in Tunis, where it is $(TZ=Africa/Tunis date -d "$now" +%H:%M)"
  exit 0
fi

# Newer: the commit installed one of master's before it. One installed by hand that master doesn't hold, a branch's,
# stays until master holds it, or install.sh installs one of master's.
cache="$state/ff.git"
[ -d "$cache" ] || git init -q --bare "$cache"
git --git-dir="$cache" fetch -q "$remote" '+refs/heads/master:refs/heads/master' && git --git-dir="$cache" cat-file -e "$newest^{commit}" ||
  { say "git couldn't fetch $short from $remote: next round"; exit 1; }
if ! git --git-dir="$cache" merge-base --is-ancestor "$base" "$newest" 2>/dev/null; then
  say "$installed, installed by hand, isn't one of master's commits before $short: it stays until master holds it, or install.sh installs one of master's"
  exit 0
fi
admin_allow="$(setting admin_allow)"
[ -n "$admin_allow" ] || { say "no admin_allow in $state/settings, which server.sh needs: install.sh's next run writes it"; exit 1; }

stamp="$(date +%Y%m%dT%H%M%S)"
new="$home/src-$short"
run_log="$state/runs/$stamp-$short.log"
install -d -m 0700 "$state/runs" "$home/backups"
echo "$short $(date -Is) $run_log" >"$state/running"
note "$short: updating from $installed, its output in $run_log"

# <what> <command...>: the command, its output in the update's log; its failure stops the updater. The functions it
# runs return at their first failure themselves, as a function called before || runs on past one.
stage() {
  local what="$1"
  shift
  echo "== $what" >>"$run_log"
  # Without the lock's descriptor, which a process it leaves running would keep, and the lock with it.
  "$@" 9>&- >>"$run_log" 2>&1 || stopped "$short: $what failed after $(minutes)"
}
fetched() {
  rm -rf "${new:?}" && mkdir -p "$new" || return 1
  git --git-dir="$cache" archive "$newest" | tar -x -C "$new" || return 1
  chown -R "$owner:" "$new" || return 1
  # ff's build, which server.sh keeps in cli/target, carried over, so that the new server.sh builds what changed.
  if [ -d "$home/src/cli/target" ]; then mv "$home/src/cli/target" "$new/cli/target" || return 1; fi
  echo "$newest's files in $new"
}
# Both PostgreSQL servers, the backend's and Keycloak's, and customers' databases, each dumped whole, root's alone.
# The updater's dumps are kept 90 days; those made by hand stay.
dumped() {
  local service file
  for service in postgres data-db; do
    file="$home/backups/update-$stamp-$short-$service.sql.gz"
    (umask 077 && docker compose --project-directory "$home" exec -T "$service" sh -c 'pg_dumpall -U "${POSTGRES_USER:-postgres}"' |
      gzip >"$file") || return 1
    echo "$file, $(wc -c <"$file") bytes"
  done
  find "$home/backups" -name 'update-*.sql.gz' -mtime +90 -delete
}
# The new directory made /data/ff/src, the one before kept beside it; the directories failed updates left for
# someone to look at, looked at since, as the updater stopped until someone did, removed.
swapped() {
  rm -rf "${home:?}/src.previous" || return 1
  if [ -d "$home/src" ]; then mv "$home/src" "$home/src.previous" || return 1; fi
  mv "$new" "$home/src" || return 1
  rm -rf "${home:?}"/src-*
  echo "$home/src is $short's; $home/src.previous the one before"
}

stage "$short's files, fetched" fetched
stage "FF's databases, dumped into $home/backups" dumped
stage "server.sh" env FF_VERSION="$short" FF_ADMIN_ALLOW="$admin_allow" bash "$new/deploy/dev-server/server.sh"
stage "smoke.sh" bash "$new/deploy/dev-server/smoke.sh"
stage "$new, made $home/src" swapped
rm -f "$state/running"
note "$short: installed in $(minutes), server.sh's and smoke.sh's checks passed"
