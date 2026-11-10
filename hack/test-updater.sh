#!/usr/bin/env bash
# The development server's updater (deploy/dev-server/updater/update.sh) against a stand-in for GitHub: a repository
# of its own for git, whose commits hold stand-ins for server.sh and smoke.sh that say how they were run; a stand-in
# for GitHub's API that answers each commit's runs from a file and says what it was asked; a stand-in for the
# server's mail; and docker and systemctl stand-ins that say what they were told. A commit installed already, one
# with no run yet, one whose run is still going, one that failed, one that passed outside the night's hours, then
# at night, installed; one whose smoke test fails, which stops the updater and e-mails the operator; an update that
# never ended; a commit installed by hand that master doesn't hold; and a round while another holds the lock. Needs
# git, curl and Python, no cluster; in a few seconds.
#   hack/test-updater.sh
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
updater="$repo/deploy/dev-server/updater/update.sh"
work="$(mktemp -d)"
source "$repo/hack/lib/checks.sh"
on_exit 'rm -rf "$work"'
home="$work/home" record="$work/record"
mkdir -p "$work/bin" "$work/runs" "$home/updater" "$home/src/cli/target"

# docker: a database's dump, saying which; systemctl: what it was told.
cat >"$work/bin/docker" <<'SH'
#!/usr/bin/env bash
echo "docker $*" >>"$FF_TEST_RECORD"
echo "-- the dump of ${*: -4:1}"
SH
cat >"$work/bin/systemctl" <<'SH'
#!/usr/bin/env bash
echo "systemctl $*" >>"$FF_TEST_RECORD"
SH
chmod +x "$work/bin/docker" "$work/bin/systemctl"

# GitHub's API, each commit's runs from runs/<commit>.json, each question in api.log; the server's mail, each
# message in mail.log. Their ports in ports, once both listen.
cat >"$work/github.py" <<'PY'
import http.server, os, socketserver, sys, threading, urllib.parse
work = sys.argv[1]

class Api(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        query = dict(urllib.parse.parse_qsl(url.query))
        with open(os.path.join(work, "api.log"), "a") as log:
            log.write(f"{url.path} {query.get('head_sha')} {query.get('event')} {query.get('branch')} "
                      f"{self.headers.get('authorization', 'anyone')}\n")
        runs = os.path.join(work, "runs", f"{query.get('head_sha')}.json")
        if url.path != "/repos/no-on3/ff/actions/runs":
            self.answer(404, b'{"message": "Not Found"}')
        else:
            self.answer(200, open(runs, "rb").read() if os.path.exists(runs) else b'{"total_count": 0, "workflow_runs": []}')

    def answer(self, status, body):
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *arguments):
        pass

class Smtp(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b"220 the stand-in\r\n")
        message = None
        for line in self.rfile:
            if message is not None:
                if line == b".\r\n":
                    with open(os.path.join(work, "mail.log"), "ab") as log:
                        log.write(b"".join(message).replace(b"\r\n", b"\n"))
                    message = None
                    self.wfile.write(b"250 kept\r\n")
                else:
                    message.append(line)
                continue
            verb = line[:4].upper()
            if verb in (b"MAIL", b"RCPT"):
                with open(os.path.join(work, "mail.log"), "ab") as log:
                    log.write(line.replace(b"\r\n", b"\n"))
            if verb == b"DATA":
                message = []
                self.wfile.write(b"354 go on\r\n")
            elif verb == b"QUIT":
                self.wfile.write(b"221 bye\r\n")
                return
            else:
                self.wfile.write(b"250 the stand-in\r\n")

socketserver.ThreadingTCPServer.allow_reuse_address = True
api = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Api)
smtp = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Smtp)
for server in (api, smtp):
    threading.Thread(target=server.serve_forever, daemon=True).start()
with open(os.path.join(work, "ports.new"), "w") as ports:
    ports.write(f"{api.server_address[1]} {smtp.server_address[1]}\n")
os.rename(os.path.join(work, "ports.new"), os.path.join(work, "ports"))
threading.Event().wait()
PY
python3 -I "$work/github.py" "$work" &
github=$!
on_exit "kill $github"
for _ in $(seq 50); do [ -s "$work/ports" ] && break; sleep 0.1; done
read -r api_port smtp_port <"$work/ports"

# GitHub's repository: each commit a server.sh and a smoke.sh that say how they were run, server.sh writing the
# version installed as the real one's last step does; smoke.sh fails in a commit that has smoke-fails.
git init -q -b master "$work/dev"
mkdir -p "$work/dev/deploy/dev-server" "$work/dev/cli"
cat >"$work/dev/deploy/dev-server/server.sh" <<'SH'
#!/usr/bin/env bash
echo "server.sh $FF_VERSION $FF_ADMIN_ALLOW $(cd "$(dirname "$0")/../.." && pwd)" >>"$FF_TEST_RECORD"
echo "$FF_VERSION" >"$FF_UPDATER_HOME/updater/installed"
SH
cat >"$work/dev/deploy/dev-server/smoke.sh" <<'SH'
#!/usr/bin/env bash
echo "smoke.sh $(cd "$(dirname "$0")/../.." && pwd)" >>"$FF_TEST_RECORD"
if [ -e "$(dirname "$0")/smoke-fails" ]; then echo "smoke.sh: 1 check failed"; exit 1; fi
SH
echo "the first" >"$work/dev/cli/Cargo.toml"
commit() { # <message>: the commit made, its full hash printed
  git -C "$work/dev" add -A && git -C "$work/dev" -c user.name=test -c user.email=test@example.com commit -q -m "$1"
  git -C "$work/dev" rev-parse HEAD
}
published() { git -C "$work/dev" push -q --force "$work/github.git" HEAD:refs/heads/master; }
runs() { # <commit> <status> <conclusion>: that commit's run, as GitHub's API lists it
  printf '{"total_count": 1, "workflow_runs": [{"head_sha": "%s", "status": "%s", "conclusion": %s, "html_url": "https://github.com/no-on3/ff/actions/runs/1"}]}' \
    "$1" "$2" "$3" >"$work/runs/$1.json"
}
git init -q --bare "$work/github.git"
first="$(commit 'the first')"
published
cp -r "$work/dev/deploy" "$work/dev/cli" "$home/src/"
echo "built" >"$home/src/cli/target/ff"
echo "${first:0:12}" >"$home/updater/installed"
printf 'admin_allow=192.0.2.1/32 192.0.2.2/32\nmail=smtp://127.0.0.1:%s\noperator=operator@dev.example\n' "$smtp_port" >"$home/updater/settings"
echo "a-token" >"$home/updater/github-token"

night=2026-11-11T02:30:00+01:00 day=2026-11-11T14:00:00+01:00
run() { # <time in Tunis>: the updater run then; its status printed, its output in out
  rm -f "$record" "$work/api.log"
  local status=0
  PATH="$work/bin:$PATH" FF_TEST_RECORD="$record" FF_UPDATER_HOME="$home" FF_UPDATER_GIT="$work/github.git" \
    FF_UPDATER_API="http://127.0.0.1:$api_port" FF_UPDATER_OWNER="$(id -un)" FF_UPDATER_NOW="$1" \
    bash "$updater" >"$work/out" 2>&1 || status=$?
  echo "$status"
}
said() { tr '\n' ' ' <"$work/out" | sed 's/ $//'; }
recorded() { if [ -f "$record" ]; then tr '\n' ';' <"$record"; else echo nothing; fi; }
asked() { [ -f "$work/api.log" ] && echo asked || echo 'not asked'; }

check "the commit installed, master's newest: nothing, GitHub's API not asked" \
  "0 update.sh: ${first:0:12}, master's newest, is installed nothing not asked" "$(run "$night") $(said) $(recorded) $(asked)"

echo "the second" >"$work/dev/cli/Cargo.toml"
second="$(commit 'the second')"
published
check "a newer commit with no run yet: nothing; its push's runs on master asked, with the token" \
  "0 update.sh: ${second:0:12}, master's newest, has no run yet nothing /repos/no-on3/ff/actions/runs $second push master Bearer a-token" \
  "$(run "$night") $(said) $(recorded) $(cat "$work/api.log")"

runs "$second" in_progress null
check "its run still going: nothing" \
  "0 update.sh: ${second:0:12}'s run is still going: https://github.com/no-on3/ff/actions/runs/1 nothing" \
  "$(run "$night") $(said) $(recorded)"

runs "$second" completed '"failure"'
check "its run failed: nothing, until a commit passes" \
  "0 update.sh: ${second:0:12}'s run didn't pass, failure https://github.com/no-on3/ff/actions/runs/1: it waits for a commit that does nothing" \
  "$(run "$night") $(said) $(recorded)"

runs "$second" completed '"success"'
check "its run passed, at 14:00 in Tunis: nothing until the night" \
  "0 update.sh: ${second:0:12} passed; it is installed between 01:00 and 05:00 in Tunis, where it is 14:00 nothing" \
  "$(run "$day") $(said) $(recorded)"

status="$(run "$night")"
new="$home/src-${second:0:12}"
backups="$(cd "$home/backups" && ls | sed 's/^update-[0-9T]*-//' | tr '\n' ' ')"
check "at 02:30: both databases dumped, the new directory's server.sh then its smoke.sh, and it made /data/ff/src" \
  "0 docker compose --project-directory $home exec -T postgres sh -c pg_dumpall -U \"\${POSTGRES_USER:-postgres}\";docker compose --project-directory $home exec -T data-db sh -c pg_dumpall -U \"\${POSTGRES_USER:-postgres}\";server.sh ${second:0:12} 192.0.2.1/32 192.0.2.2/32 $new;smoke.sh $new;" \
  "$status $(recorded)"
check "  ... each dump in /data/ff/backups, root's alone; the new files in src, the ones before in src.previous" \
  "${second:0:12}-data-db.sql.gz ${second:0:12}-postgres.sql.gz  600 the second the first false" \
  "$backups $(stat -c %a "$home/backups/"*postgres.sql.gz) $(cat "$home/src/cli/Cargo.toml") $(cat "$home/src.previous/cli/Cargo.toml") $([ -e "$new" ] && echo true || echo false)"
check "  ... ff's build carried over, the version installed the commit, the timer left running, no e-mail" \
  "built ${second:0:12} false false" \
  "$(cat "$home/src/cli/target/ff") $(cat "$home/updater/installed") $(grep systemctl "$record" >/dev/null && echo true || echo false) $([ -f "$work/mail.log" ] && echo true || echo false)"
check "  ... its log: the update's start and its end, its output beside it" \
  "updating from ${first:0:12}, its output in $home/updater/runs/ installed in 1 min, server.sh's and smoke.sh's checks passed 2 lines" \
  "$(sed -n '1s/.* updating/updating/p' "$home/updater/updates.log" | sed 's|runs/.*|runs/|') $(sed -n '2s/^[^ ]* [^ ]* //p' "$home/updater/updates.log") $(wc -l <"$home/updater/updates.log") lines"
check "  ... the next round: installed" "0 update.sh: ${second:0:12}, master's newest, is installed" "$(run "$night") $(said)"

touch "$work/dev/deploy/dev-server/smoke-fails"
third="$(commit 'the third, whose smoke test fails')"
published
runs "$third" completed '"success"'
status="$(run "$night")"
check "a commit whose smoke test fails: the updater stopped, its timer disabled; /data/ff/src left as it was, its build back" \
  "1 server.sh ${third:0:12} 192.0.2.1/32 192.0.2.2/32 $home/src-${third:0:12};smoke.sh $home/src-${third:0:12};systemctl disable --now ff-updater.timer; the second built false" \
  "$status $(grep -v '^docker' "$record" | tr '\n' ';') $(cat "$home/src/cli/Cargo.toml") $(cat "$home/src/cli/target/ff") $([ -e "$home/updater/running" ] && echo true || echo false)"
check "  ... its log saying where it failed" \
  "${third:0:12}: smoke.sh failed after 1 min; the updater is stopped" "$(sed -n '$s/^[^ ]* //p' "$home/updater/updates.log")"
check "  ... the operator e-mailed through the server's mail, the end of smoke.sh's output in it" \
  "MAIL FROM:<updates@dev.example> RCPT TO:<operator@dev.example> Subject: FF's development server: ${third:0:12}: smoke.sh failed after 1 min smoke.sh: 1 check failed" \
  "$(sed -n 's/^MAIL FROM:\([^ ]*\).*/MAIL FROM:\1/p; /^RCPT TO:/p; /^Subject:/p; /^smoke.sh: /p' "$work/mail.log" | tr '\n' ' ' | sed 's/ $//')"

rm -f "$work/mail.log"
echo "${third:0:12} 2026-11-11T01:00:00+01:00 $home/updater/runs/gone.log" >"$home/updater/running"
check "an update that never ended: the next round stops the updater and e-mails the operator" \
  "1 systemctl disable --now ff-updater.timer; Subject: FF's development server: ${third:0:12}: the update started at 2026-11-11T01:00:00+01:00 never ended false" \
  "$(run "$night") $(recorded) $(grep '^Subject:' "$work/mail.log") $([ -e "$home/updater/running" ] && echo true || echo false)"

git -C "$work/dev" checkout -q -b by-hand
echo "a branch's" >"$work/dev/cli/Cargo.toml"
branch="$(commit "a branch's commit, installed by hand")"
echo "${branch:0:12}" >"$home/updater/installed"
git -C "$work/dev" checkout -q master
rm "$work/dev/deploy/dev-server/smoke-fails"
echo "the fourth" >"$work/dev/cli/Cargo.toml"
fourth="$(commit 'the fourth')"
published
runs "$fourth" completed '"success"'
check "a branch's commit installed by hand, which master doesn't hold: it stays, nothing run" \
  "0 update.sh: ${branch:0:12}, installed by hand, isn't one of master's commits before ${fourth:0:12}: it stays until master holds it, or install.sh installs one of master's nothing" \
  "$(run "$night") $(said) $(recorded)"

echo "${fourth:0:12}-dirty-1762822800" >"$home/updater/installed"
check "master's newest, installed by hand with changes: it stays" \
  "0 update.sh: ${fourth:0:12}-dirty-1762822800, master's newest with changes, installed by hand, stays until master moves" \
  "$(run "$night") $(said)"

flock "$home/updater/lock" sleep 3 &
locker=$!
sleep 0.5
check "a round while install.sh's server.sh holds the lock: nothing" \
  "0 update.sh: an update, or install.sh's server.sh, holds $home/updater/lock: nothing this round nothing" \
  "$(run "$night") $(said) $(recorded)"
wait "$locker"

echo "${second:0:12}" >"$home/updater/installed"
check "once someone has looked, the next commit that passes installed, the directory the failed update left removed" \
  "0 the fourth false" \
  "$(run "$night") $(cat "$home/src/cli/Cargo.toml") $([ -e "$home/src-${third:0:12}" ] && echo true || echo false)"

checks_done updater
