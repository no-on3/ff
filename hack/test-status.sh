#!/usr/bin/env bash
# The status page's probe (deploy/dev-server/status/probe.sh) against a stand-in for FF behind the server's proxy: one
# TLS server for all of FF's names, its certificate from an authority of the test's own and five days from its end,
# which answers each as FF does when it is up, and as the test says otherwise: an answer of the wrong status, the
# wrong body, or both, one too slow, a message SQS loses. It checks the signature of each request signed with the probe's key, as FF
# would. Then nothing listening, the minutes kept 90 days, and settings without the probe's names. Needs curl, jq,
# openssl and Python, no cluster; in a few seconds.
#   hack/test-status.sh
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$repo/deploy/dev-server/status/probe.sh"
work="$(mktemp -d)"
source "$repo/hack/lib/checks.sh"
on_exit 'rm -rf "$work"'
status="$work/status" domain=status.test account=000000000001
mkdir -p "$status" "$work/modes"

# The authority, and the stand-in's certificate for FF's fixed names, function URLs and sites, five days from its end.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=the test's authority" -days 30 \
  -keyout "$work/ca.key" -out "$status/roots.pem" 2>/dev/null
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=api.$domain" -keyout "$work/server.key" 2>/dev/null |
  openssl x509 -req -CA "$status/roots.pem" -CAkey "$work/ca.key" -days 5 -out "$work/server.pem" 2>/dev/null -extfile <(
    printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' \
      "$(printf 'DNS:%s.'"$domain"',' api console login lambda s3 sqs email)DNS:*.fn.$domain,DNS:*.site.$domain")
# A certificate's days left are whole days, rounded down: 4 for this one, from the second after it was made.
made="$(date +%s)"
key_id=AKFFSTATUSPROBE00001
printf 'user = "%s:%s"\n' "$key_id" "the-probe's-secret" >"$status/probe-key.curl"
settings() {
  printf '%s\n' "domain=$domain" region=tn-tunis-1 function=status-canary "bucket=ff-status-$account" \
    "queue_url=https://sqs.$domain/$account/status-probe" "canary_url=https://c4n4ry.fn.$domain/" \
    "site_url=https://ff-status-$account.site.$domain/" >"$status/probe.env"
}
settings

# FF behind the proxy: each name as FF answers it, unless modes/<check> says down (503), failing (FF's answer with
# 500), wrong (another body), slow, lose (SQS dropping what it is sent) or unsendable (SQS refusing it). Each request
# in requests.log: its host, its path, and how it was signed, its signature checked with the probe's key.
cat >"$work/ff.py" <<'PY'
import datetime, hashlib, hmac, http.server, json, os, re, ssl, sys, threading, time, urllib.parse
work, domain, account, key_id, secret = sys.argv[1:6]
queue, lock = [], threading.Lock()
SITE = b"<!doctype html><title>FF's status probe</title><p>FF's status probe: this page is read each minute.</p>\n"
CANARY = "FF's status canary\n"

def mode(check):
    try:
        return open(os.path.join(work, "modes", check)).read().strip()
    except FileNotFoundError:
        return ""

def signature(method, path, query, headers, body):
    """How the request was signed: "unsigned", "<key>/<region>/<service>" when its signature is right, else why not."""
    found = re.fullmatch(r"AWS4-HMAC-SHA256 Credential=([^/]+)/(\d{8})/([^/]+)/([^/]+)/aws4_request, "
                         r"SignedHeaders=([^,]+), Signature=([0-9a-f]{64})", headers.get("authorization", ""))
    if not found:
        return "unsigned" if "authorization" not in headers else "a signature not SigV4's"
    key, day, region, service, signed, given = found.groups()
    if key != key_id:
        return f"signed with another key, {key}"
    names = signed.split(";")
    if "host" not in names:
        return "its host not signed"
    payload = headers.get("x-amz-content-sha256") or hashlib.sha256(body).hexdigest()
    canonical_query = "&".join(sorted(f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
                                      for k, v in urllib.parse.parse_qsl(query, keep_blank_values=True)))
    canonical = "\n".join([method, urllib.parse.quote(path, safe="/-_.~"), canonical_query,
                           "".join(f"{name}:{headers.get(name, '').strip()}\n" for name in names), signed, payload])
    stamp = headers.get("x-amz-date", "")
    scope = f"{day}/{region}/{service}/aws4_request"
    text = "\n".join(["AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    signing = ("AWS4" + secret).encode()
    for part in (day, region, service, "aws4_request"):
        signing = hmac.new(signing, part.encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(hmac.new(signing, text.encode(), hashlib.sha256).hexdigest(), given):
        return "a wrong signature"
    if service == "s3" and "x-amz-content-sha256" not in names:
        return "its payload's hash not signed, as FF's S3 requires"
    return f"{key}/{region}/{service}"

class Ff(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self.serve()

    def do_POST(self):
        self.serve()

    def serve(self):
        url = urllib.parse.urlsplit(self.path)
        host = self.headers.get("host", "")
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        headers = {name.lower(): value for name, value in self.headers.items()}
        signed = signature(self.command, url.path, url.query, headers, body)
        name = host.removesuffix("." + domain)
        check = {"c4n4ry.fn": "canary", f"ff-status-{account}.site": "site"}.get(name, name)
        if check == "email":
            check = "ses"
        with open(os.path.join(work, "requests.log"), "a") as log:
            log.write(f"{check} {self.command} {url.path} {signed}\n")
        said = mode(check)
        if said == "slow":
            time.sleep(4)
        if said == "down":
            return self.answer(503, b"down for the test\n", "text/plain")
        status, answer, kind, extra = self.route(check, url, signed, body, headers)
        if said == "wrong":
            answer, extra = b"not what FF answers\n", {}
        if said == "failing":
            status = 500
        self.answer(status, answer, kind, extra)

    def route(self, check, url, signed, body, headers):
        query = dict(urllib.parse.parse_qsl(url.query))
        mine = signed.startswith(key_id + "/")
        if check == "api" and url.path == "/healthz":
            return 200, b'{"status":"ok"}', "application/json", {}
        if check == "console" and url.path == "/":
            return 200, b'<!doctype html><div id="root"></div>', "text/html", {}
        if check == "login" and url.path == "/realms/ff/protocol/openid-connect/auth" and query.get("client_id") == "ff-console":
            return 200, b'<form action="x"><input name="username"></form>', "text/html", {}
        if check == "lambda" and url.path == "/2015-03-31/functions/status-canary/invocations" and mine:
            return 200, json.dumps({"statusCode": 200, "body": CANARY}).encode(), "application/json", {}
        if check == "s3" and url.path == f"/ff-status-{account}/index.html" and mine:
            return 200, SITE, "text/html", {}
        if check == "sqs" and mine:
            return self.sqs(headers.get("x-amz-target", ""), json.loads(body or b"{}"))
        if check == "ses" and url.path == "/v2/email/account" and signed == "unsigned":
            return 403, b'{"message":"Missing Authentication Token"}', "application/json", {"x-amzn-errortype": "MissingAuthenticationTokenException"}
        if check == "canary" and url.path == "/":
            return 200, CANARY.encode(), "text/plain", {}
        if check == "site" and url.path == "/":
            return 200, SITE, "text/html", {}
        return 403 if signed != "unsigned" or check in ("lambda", "s3", "sqs") else 404, f"refused: {signed}\n".encode(), "text/plain", {}

    def sqs(self, target, given):
        if given.get("QueueUrl") != f"https://sqs.{domain}/{account}/status-probe":
            return 400, b'{"__type":"com.amazonaws.sqs#QueueDoesNotExist"}', "application/x-amz-json-1.0", {}
        with lock:
            if target == "AmazonSQS.SendMessage":
                if mode("sqs") == "unsendable":
                    return 403, b'{"__type":"com.amazonaws.sqs#AccessDenied"}', "application/x-amz-json-1.0", {}
                if mode("sqs") != "lose":
                    queue.append({"MessageId": str(len(queue)), "ReceiptHandle": os.urandom(8).hex(), "Body": given["MessageBody"]})
                return 200, b'{"MessageId":"1"}', "application/x-amz-json-1.0", {}
            if target == "AmazonSQS.ReceiveMessage":
                return 200, json.dumps({"Messages": queue[: given.get("MaxNumberOfMessages", 1)]}).encode(), "application/x-amz-json-1.0", {}
            if target == "AmazonSQS.DeleteMessage":
                queue[:] = [message for message in queue if message["ReceiptHandle"] != given.get("ReceiptHandle")]
                return 200, b"{}", "application/x-amz-json-1.0", {}
        return 400, b'{"__type":"com.amazonaws.sqs#InvalidAction"}', "application/x-amz-json-1.0", {}

    def answer(self, status, body, kind, extra=None):
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.send_header("connection", "close")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def log_message(self, *arguments):
        pass

class Queue(http.server.BaseHTTPRequestHandler):
    """The test's view of the queue, on a port of its own: GET lists its messages' bodies, POST adds one."""

    def do_GET(self):
        with lock:
            body = "".join(message["Body"] + "\n" for message in queue).encode()
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        text = self.rfile.read(int(self.headers.get("content-length") or 0)).decode()
        with lock:
            queue.append({"MessageId": "left", "ReceiptHandle": os.urandom(8).hex(), "Body": text})
        self.send_response(204)
        self.end_headers()

    def log_message(self, *arguments):
        pass

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(os.path.join(work, "server.pem"), os.path.join(work, "server.key"))
ff = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Ff)
ff.socket = context.wrap_socket(ff.socket, server_side=True)
view = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Queue)
for server in (ff, view):
    threading.Thread(target=server.serve_forever, daemon=True).start()
with open(os.path.join(work, "ports.new"), "w") as ports:
    ports.write(f"{ff.server_address[1]} {view.server_address[1]}\n")
os.rename(os.path.join(work, "ports.new"), os.path.join(work, "ports"))
threading.Event().wait()
PY
python3 -I "$work/ff.py" "$work" "$domain" "$account" "$key_id" "the-probe's-secret" &
ff=$!
on_exit "kill $ff"
for _ in $(seq 50); do [ -s "$work/ports" ] && break; sleep 0.1; done
read -r port queue_port <"$work/ports"

probed() { # [port]: the probe run, against the stand-in or that port; its status printed, its output in out
  rm -f "$work/requests.log"
  local code=0
  FF_STATUS_HOME="$status" FF_STATUS_PORT="${1:-$port}" FF_STATUS_TIMEOUT=2 bash "$probe" >"$work/out" 2>&1 || code=$?
  echo "$code"
}
minute() { tail -n 1 "$status/minutes.log"; } # the last minute's line
# <jq filter>: over each of the last minute's checks, "<name> <the filter's value>", a line each, joined by commas.
each() { minute | jq -r ".checks | to_entries | sort_by(.key) | map(.key + \" \" + (.value | $1 | tostring)) | join(\", \")"; }
mode() { echo "$2" >"$work/modes/$1"; } # <check> <down, failing, wrong, slow, lose or unsendable>
modes_cleared() { rm -f "$work/modes"/*; }
in_queue() { curl -s "http://127.0.0.1:$queue_port/" | paste -sd'|'; }
requests() { cut -d' ' -f1,4- "$work/requests.log" | sort -u | paste -sd,; } # each check, how it was signed

section "FF up: each check's answer the one expected, in a line for the minute"
until [ "$(date +%s)" -gt "$made" ]; do sleep 0.1; done
check "the probe ends well, saying nothing" "0 " "$(probed) $(cat "$work/out")"
check "one line in the minutes, for this minute, in UTC" "1 true" \
  "$(wc -l <"$status/minutes.log") $(minute | jq --arg now "$(date -u +%Y-%m-%dT%H:%M)" '.at | startswith($now) and endswith(":00Z")')"
check "each check, ok" "api true, canary true, console true, lambda true, login true, s3 true, ses true, site true, sqs true" "$(each .ok)"
check "each one's status: SES's refusal of an unsigned request is FF's answer" \
  "api 200, canary 200, console 200, lambda 200, login 200, s3 200, ses 403, site 200, sqs 200" "$(each .code)"
check "each one's time in milliseconds, and no error" "true" \
  "$(minute | jq '[.checks[] | (.ms | type == "number" and . >= 0) and (has("error") | not)] | all')"
check "each one's certificate: 4 days left, a certificate about to expire" \
  "api 4, canary 4, console 4, lambda 4, login 4, s3 4, ses 4, site 4, sqs 4" "$(each .days)"
check "Lambda, S3 and SQS signed with the probe's key, for their service in FF's region, each signature right; the rest not signed" \
  "api unsigned,canary unsigned,console unsigned,lambda $key_id/tn-tunis-1/lambda,login unsigned,s3 $key_id/tn-tunis-1/s3,ses unsigned,site unsigned,sqs $key_id/tn-tunis-1/sqs" \
  "$(requests)"
check "SQS: the message sent, received, then deleted: the queue empty" "" "$(in_queue)"

section "a message an earlier minute left in the queue: deleted with the minute's own"
curl -s -X POST --data-binary "probe 2026-11-10T09:59:00Z" "http://127.0.0.1:$queue_port/" >/dev/null
check "SQS ok, the queue empty" "0 true " "$(probed) $(minute | jq .checks.sqs.ok) $(in_queue)"

section "FF answering wrong: each check that isn't the one expected, not ok, the others still"
mode api down
mode login failing
mode console wrong
mode site down
mode lambda down
mode ses wrong
check "the probe ends well: it says what it found in the minutes, not in its status" "0 3" "$(probed) $(wc -l <"$status/minutes.log")"
check "the checks answered wrong, not ok, with their status; the others ok" \
  "api false 503, canary true 200, console false 200, lambda false 503, login false 500, s3 true 200, ses false 403, site false 503, sqs true 200" \
  "$(each '"\(.ok) \(.code)"')"
modes_cleared

section "FF too slow: checks that take longer than their time, ended"
mode canary slow
mode site slow
mode api slow
started="$(date +%s%N)"
check "each not ok, without a status, the error curl's" "0 api false 0 true, canary false 0 true, site false 0 true" \
  "$(probed) $(minute | jq -r '.checks | to_entries | map(select(.key | IN("api", "canary", "site")) | "\(.key) \(.value.ok) \(.value.code) \(.value.error | test("timed out"))") | sort | join(", ")')"
check "the checks at once: the minute's run takes one slow check's 2 s, not the three's 6" true \
  "$([ $((($(date +%s%N) - started) / 1000000)) -lt 4000 ] && echo true || echo false)"
check "the others ok" "true" "$(minute | jq '[.checks | del(.canary, .site, .api)[] | .ok] | all')"
modes_cleared

section "SQS losing the message, or refusing it: the queue's check not ok"
mode sqs lose
check "sent, not received: SQS not ok, with the receive's status" "0 false 200" "$(probed) $(minute | jq -r '.checks.sqs | "\(.ok) \(.code)"')"
mode sqs unsendable
check "not sent: SQS not ok, with the send's status" "0 false 403" "$(probed) $(minute | jq -r '.checks.sqs | "\(.ok) \(.code)"')"
modes_cleared

section "nothing listening: each check not ok, the minute written all the same"
closed="$(python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
check "the probe ends well, a line more" "0 7" "$(probed "$closed") $(wc -l <"$status/minutes.log")"
check "each check not ok, without a status or a certificate, with curl's error" "true" \
  "$(minute | jq '[.checks[] | .ok == false and .code == 0 and .days == null and (.error | test("connect|Connection refused"; "i"))] | all and (length == 9)')"

section "the minutes kept 90 days"
old="$(date -u -d '91 days ago' +%Y-%m-%dT%H:%M:00Z)" kept="$(date -u -d '89 days ago' +%Y-%m-%dT%H:%M:00Z)"
printf '{"at": "%s", "checks": {}}\n{"at": "%s", "checks": {}}\n' "$old" "$kept" >"$status/minutes.log"
check "a line over 90 days old removed, one under kept, the minute's added" "0 $kept true" \
  "$(probed) $(head -n 1 "$status/minutes.log" | jq -r .at) $([ "$(wc -l <"$status/minutes.log")" -eq 2 ] && echo true || echo false)"
check "a file whose first line is under 90 days old kept as it was, the minute's added" "0 3 $kept" \
  "$(probed) $(wc -l <"$status/minutes.log") $(head -n 1 "$status/minutes.log" | jq -r .at)"

section "settings without the probe's names: the probe stops, saying which file, and writes no minute"
printf 'domain=%s\n' "$domain" >"$status/probe.env"
lines="$(wc -l <"$status/minutes.log")"
check "its status, its words, the minutes as they were" "1 true $lines" \
  "$(probed) $(grep -q "probe.env lacks the probe's names: setup.sh writes them" "$work/out" && echo true || echo false) $(wc -l <"$status/minutes.log")"
settings

checks_done status
