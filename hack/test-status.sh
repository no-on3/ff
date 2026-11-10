#!/usr/bin/env bash
# The status page (deploy/dev-server/status). Its probe, probe.sh, against a stand-in for FF behind the server's proxy:
# one TLS server for all of FF's names, its certificate from an authority of the test's own and five days from its
# end, which answers each as FF does when it is up, and as the test says otherwise: an answer of the wrong status, the
# wrong body, or both, one too slow, a message SQS loses or refuses. It checks the signature of each request signed
# with the probe's key, as FF would. Then nothing listening, the minutes kept 90 days, and settings without the
# probe's names. Then its renderer, render.py, against 90 days of minutes made from those the probe recorded: up,
# down, down a while, slow, a certificate about to end, a day with no minutes, the month's uptime; the state now in
# each case, and with no recent minute; the incidents; and the days it keeps. Needs curl, jq, openssl and Python, no
# cluster; in a few seconds.
#   hack/test-status.sh
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe="$repo/deploy/dev-server/status/probe.sh"
render="$repo/deploy/dev-server/status/render.py"
work="$(mktemp -d)"
source "$repo/hack/lib/checks.sh"
on_exit 'rm -rf "$work"'
status="$work/status" domain=status.test account=000000000001
mkdir -p "$status" "$work/modes" "$work/recorded"

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
minute >"$work/recorded/up.json"

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
minute >"$work/recorded/wrong.json"
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
minute >"$work/recorded/down.json"

section "the minutes kept 90 days, by whole days"
old="$(date -u -d '91 days ago' +%Y-%m-%dT%H:%M:00Z)" first="$(date -u -d '90 days ago' +%Y-%m-%d)T00:00:00Z"
printf '{"at": "%s", "checks": {}}\n{"at": "%s", "checks": {}}\n' "$old" "$first" >"$status/minutes.log"
check "the day 91 days old removed, the day after kept, the minute's added" "0 $first 2" \
  "$(probed) $(head -n 1 "$status/minutes.log" | jq -r .at) $(wc -l <"$status/minutes.log")"
inode="$(stat -c %i "$status/minutes.log")"
check "the next minute added to the file, not a copy of it, though its first minute is over 90 days old: once a day" "0 3 $inode" \
  "$(probed) $(wc -l <"$status/minutes.log") $(stat -c %i "$status/minutes.log")"

section "settings without the probe's names: the probe stops, saying which file, and writes no minute"
printf 'domain=%s\n' "$domain" >"$status/probe.env"
lines="$(wc -l <"$status/minutes.log")"
check "its status, its words, the minutes as they were" "1 true $lines" \
  "$(probed) $(grep -q "probe.env lacks the probe's names: setup.sh writes them" "$work/out" && echo true || echo false) $(wc -l <"$status/minutes.log")"
settings

# The page, from 90 days of minutes made from those the probe recorded above, each at a minute of its own; the last
# minute, at 12:00 on the day the page is made, the one named, and the page made at 12:00:30.
now=2026-11-10T12:00:30Z
cat >"$work/minutes.py" <<'PY'
import copy, datetime as dt, json, sys
recorded, out, final = sys.argv[1:4]
minutes = {name: json.load(open(f"{recorded}/{name}.json")) for name in ("up", "wrong", "down")}
minutes["slow"] = copy.deepcopy(minutes["up"])
minutes["slow"]["checks"]["api"]["ms"] = 2500
days = {day: [("up", 24)] for day in (dt.date(2026, 8, 13) + dt.timedelta(days=n) for n in range(80))}
days.update({
    dt.date(2026, 8, 12): [("down", 24)],              # before the 90 days: left out
    dt.date(2026, 10, 30): [("up", 2), ("down", 1)],   # 66.66...% up
    dt.date(2026, 11, 1): [("slow", 24)],              # the API slow all day
    dt.date(2026, 11, 2): [("up", 24)],
    # 2026-11-03: no minute at all
    dt.date(2026, 11, 4): [("up", 24)],
    dt.date(2026, 11, 5): [("up", 1000), ("wrong", 5)],  # down a while: 99.5 % up, where the wrong answers were
    dt.date(2026, 11, 6): [("up", 24)],
    dt.date(2026, 11, 7): [("up", 18), ("down", 6)],   # down: 75 % up, for every check
    dt.date(2026, 11, 8): [("up", 24)],
    dt.date(2026, 11, 9): [("up", 24)],
    dt.date(2026, 11, 10): [("up", 12), (final, 1)],   # today, to 12:00
})
with open(out, "w") as lines:
    for day, runs in sorted(days.items()):
        count = sum(n for _, n in runs)
        at = dt.datetime.combine(day, dt.time(12 if day == dt.date(2026, 11, 10) else 0)) - dt.timedelta(minutes=count - 1 if day == dt.date(2026, 11, 10) else 0)
        for name, n in runs:
            for _ in range(n):
                minute = copy.deepcopy(minutes[name])
                minute["at"] = at.strftime("%Y-%m-%dT%H:%M:00Z")
                lines.write(json.dumps(minute, separators=(",", ":")) + "\n")
                at += dt.timedelta(minutes=1)
PY
# The page as its reader sees it: the banner, the warnings, each check's state now, bars and month, the incidents;
# and as its browser does: its Content-Security-Policy, and the hashes of its inline style and script.
cat >"$work/page.py" <<'PY'
import base64, hashlib, html.parser, json, sys
class Page(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.open, self.elements, self.policy = [], [], ""
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and (attrs.get("http-equiv") or "").lower() == "content-security-policy":
            self.policy = attrs.get("content") or ""
        if tag in ("meta", "link"):  # elements without an end
            return
        element = {"tag": tag, "class": (attrs.get("class") or "").split(), "title": attrs.get("title"), "href": attrs.get("href"),
                   "parent": self.open[-1]["class"] if self.open else [], "text": ""}
        self.open.append(element)
        self.elements.append(element)
    def handle_endtag(self, tag):
        while self.open and self.open.pop()["tag"] != tag:
            pass
    def handle_data(self, data):
        for element in self.open:
            element["text"] += data
page = Page()
page.feed(open(sys.argv[1], encoding="utf-8").read())
seen = {"banner": None, "warnings": [], "checks": {}, "incidents": {"h3": [], "strong": [], "code": [], "a": [], "li": [], "p": []}, "footer": ""}
section = check = None
for element in page.elements:
    tag, classes, text = element["tag"], element["class"], " ".join(element["text"].split())
    if tag == "section":
        section = "incidents" if "incidents" in classes else "check"
    elif tag == "footer":
        seen["footer"], section = text, None
    elif tag == "p" and "banner" in classes:
        seen["banner"] = [classes[1], text]
    elif tag == "li" and "warnings" in element["parent"]:
        seen["warnings"].append(text)
    elif section == "check" and tag == "h2":
        check = seen["checks"][text] = {"now": None, "bars": [], "month": None}
    elif section == "check" and tag == "span" and "now" in classes:
        check["now"] = [classes[1], text]
    elif section == "check" and tag == "li" and "bars" in element["parent"]:
        check["bars"].append([classes[0], element["title"]])
    elif section == "check" and tag == "p" and "month" in classes:
        check["month"] = text
    elif section == "incidents" and tag in seen["incidents"]:
        seen["incidents"][tag].append([element["href"], text] if tag == "a" else text)
seen["policy"] = dict((part.split() + [""])[:2] for part in page.policy.split(";") if part.strip())
digest = lambda text: "'sha256-" + base64.b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode() + "'"
seen["inline"] = {tag: " ".join(digest(e["text"]) for e in page.elements if e["tag"] == tag) for tag in ("style", "script")}
json.dump(seen, sys.stdout)
PY
rendered() { # <the last minute's kind> [now]: the page made from the minutes, its status printed, as read in page.json
  local code=0
  python3 -I "$work/minutes.py" "$work/recorded" "$status/minutes.log" "$1"
  rm -f "$status/days.json"
  FF_STATUS_HOME="$status" FF_STATUS_NOW="${2:-$now}" python3 -I "$render" >"$work/out" 2>&1 || code=$?
  python3 -I "$work/page.py" "$status/page/index.html" >"$work/page.json"
  echo "$code"
}
seen() { jq -r "$1" "$work/page.json"; } # <jq filter>
day() { seen "[.checks[\"$1\"].bars[] | select(.[1] | startswith(\"$2\"))][0] | join(\" | \")"; } # <check> <day>

section "the page: FF up, from 90 days of the minutes the probe recorded"
check "made, saying nothing; FF up now, in the banner" "0 up All of FF is up." "$(rendered up) $(cat "$work/out")$(seen '.banner | join(" ")')"
check "every check, in order, up now" \
  "All of FF up, API up, Console up, Login up, Lambda endpoint up, S3 endpoint up, SQS endpoint up, SES endpoint up, Function URLs up, Sites up" \
  "$(seen '.checks | to_entries | map("\(.key) \(.value.now[1])") | join(", ")')"
check "a bar a day for 90 days, each check, from the first day of the 90: the day before them left out" "90 2026-08-13: up, 100% of 24 minutes up" \
  "$(seen '[.checks[].bars | length] | unique | join(" ")') $(seen '.checks.API.bars[0][1]')"
check "a day with no minutes says so" "none | 2026-11-03: no minutes" "$(day API 2026-11-03)"
check "a day down: every check down, its uptime and minutes in its title" "down | 2026-11-07: down, 75.00% of 24 minutes up | down" \
  "$(day API 2026-11-07) | $(seen '[.checks[].bars[] | select(.[1] | startswith("2026-11-07")) | .[0]] | unique | join(" ")')"
check "a day down a while: the checks answered wrong, the others up; FF down a while" \
  "partial | 2026-11-05: down a while, 99.50% of 1005 minutes up, up | 2026-11-05: up, 100% of 1005 minutes up, partial" \
  "$(day API 2026-11-05), $(day 'Function URLs' 2026-11-05), $(day 'All of FF' 2026-11-05 | cut -d' ' -f1)"
check "an uptime rounded down, so that a minute down never reads as 100%: 2 of 3 minutes, 66.66%" "down | 2026-10-30: down, 66.66% of 3 minutes up" \
  "$(day API 2026-10-30)"
check "a day slow: the API's minutes up, each after more than 2 s; the console's up" \
  "slow | 2026-11-01: slow, 100% of 24 minutes up, 24 slow, up" "$(day API 2026-11-01), $(day Console 2026-11-01 | cut -d' ' -f1)"
check "the month's uptime, rounded down, its minutes alone: FF's, the API's, the function URLs'" \
  "99.07% up this month, 99.07% up this month, 99.49% up this month" \
  "$(seen '[.checks["All of FF"], .checks.API, .checks["Function URLs"]] | map(.month) | join(", ")')"
check "the certificates about to end, Let's Encrypt's: FF's fixed names', 4 days left; not the proxy's own, for URLs and sites" \
  "api console login lambda s3 sqs email: ends in 4 days." \
  "$(seen '.warnings | map(split(".")[0]) | join(" ")'): $(seen '.warnings[0] | split("certificate ")[1]')"
check "the line that says the probe runs on the server itself, and the minute the page is made from" "true true" \
  "$(seen '.footer | contains("Probed every minute from the server FF runs on") and contains("so is this page")') $(seen '.footer | contains("Made at 2026-11-10 12:00 UTC, from the minute of 2026-11-10 12:00 UTC")')"
check "written whole, readable by all, no incident written; its script parses" "644 false None written. 0" \
  "$(stat -c %a "$status/page/index.html") $([ -e "$status/page/index.html.new" ] && echo true || echo false) $(seen '.incidents.p | join(" ")') $(python3 -I "$repo/hack/check-docs.py" "$status/page/index.html" >/dev/null 2>&1; echo $?)"
check "its own Content-Security-Policy: nothing loads or runs but its style and script, each named by its hash, and its empty icon" \
  "'none' true true data: 'none' 'none' base-uri default-src form-action img-src script-src style-src" \
  "$(seen '.policy["default-src"]') $(seen '.policy["style-src"] == .inline.style') $(seen '.policy["script-src"] == .inline.script') $(seen '.policy["img-src"], .policy["base-uri"], .policy["form-action"]' | paste -sd' ') $(seen '.policy | keys | join(" ")')"

section "the page: the state now, from the last minute"
check "checks answered wrong: part of FF down, each named; the others up" \
  "down Part of FF is down: API, Console, Login, Lambda endpoint, SES endpoint, Sites. | API down, S3 endpoint up, Function URLs up" \
  "$(rendered wrong >/dev/null; seen '.banner | join(" ")') | $(seen '[.checks | to_entries[] | select(.key | IN("API", "S3 endpoint", "Function URLs")) | "\(.key) \(.value.now[1])"] | join(", ")')"
check "a check slow: FF up, slow in part" "slow FF is up, and slow in part: API. | slow" \
  "$(rendered slow >/dev/null; seen '.banner | join(" ")') | $(seen '.checks.API.now[1]')"
check "nothing answering: FF down; no certificate to warn of" "down FF is down. | 0" \
  "$(rendered down >/dev/null; seen '.banner | join(" ")') | $(seen '.warnings | length')"
check "no minute for 10 minutes: the probe's silence said, nothing claimed of FF now" \
  "none The probe hasn't written a minute since 2026-11-10 12:00 UTC: what FF is doing now isn't known. | not known | 0" \
  "$(rendered up 2026-11-10T12:10:30Z >/dev/null; seen '.banner | join(" ")') | $(seen '[.checks[].now[1]] | unique | join(" ")') | $(seen '.warnings | length')"
mkdir "$work/empty"
check "no minutes at all: none yet, every day without, no uptime" \
  "0 none The probe hasn't written a minute yet: what FF is doing now isn't known. | none | No minutes this month" \
  "$(FF_STATUS_HOME="$work/empty" FF_STATUS_NOW="$now" python3 -I "$render"; echo $?) $(python3 -I "$work/page.py" "$work/empty/page/index.html" >"$work/page.json"; seen '.banner | join(" ")') | $(seen '[.checks[].bars[][0]] | unique | join(" ")') | $(seen '[.checks[].month] | unique | join(" ")')"

section "the page: the incidents, as the operator writes them on the server"
cat >"$status/incidents.md" <<'MD'
## 2026-11-07 09:00 UTC: FF down for **6 minutes**
The server restarted; [the log](https://example.com/log?a=1&b=2) and `journalctl -u ff-status-probe` say why.

- the API, the console, everything
- back at 09:06

<script>alert("not run")</script> [not a link](javascript:alert(1))
MD
rendered up >/dev/null
check "a heading, bold, a link, code and a list" \
  "2026-11-07 09:00 UTC: FF down for 6 minutes | 6 minutes | https://example.com/log?a=1&b=2 the log | journalctl -u ff-status-probe | 2" \
  "$(seen '.incidents | [.h3[0], .strong[0], (.a[0] | join(" ")), .code[0], (.li | length | tostring)] | join(" | ")')"
check "HTML of its own shown as text, a link to anything but a web page left a text" "true true 1" \
  "$(grep -F '&lt;script&gt;alert' "$status/page/index.html" >/dev/null && echo true || echo false) $(seen '.incidents.p | last | contains("[not a link](javascript:alert(1))")') $(grep -c '<script>' "$status/page/index.html")"
rm "$status/incidents.md"

section "the page: the days before today kept, as they never change"
rendered up >/dev/null
cp "$status/page/index.html" "$work/first.html"
check "each day before today with minutes kept, today not" "88 false" "$(jq -r 'keys | length' "$status/days.json") $(jq -r 'has("2026-11-10")' "$status/days.json")"
FF_STATUS_HOME="$status" FF_STATUS_NOW="$now" python3 -I "$render"
check "the page the same made from them" "same" "$(cmp -s "$work/first.html" "$status/page/index.html" && echo same || echo different)"
grep -v '"at":"2026-11-07' "$status/minutes.log" >"$work/minutes.log" && cp "$work/minutes.log" "$status/minutes.log"
FF_STATUS_HOME="$status" FF_STATUS_NOW="$now" python3 -I "$render"
python3 -I "$work/page.py" "$status/page/index.html" >"$work/page.json"
check "a day kept, its minutes not read again" "down" "$(day API 2026-11-07 | cut -d' ' -f1)"
printf '{"2026-11-0' >"$status/days.json"
python3 -I "$work/minutes.py" "$work/recorded" "$status/minutes.log" up
FF_STATUS_HOME="$status" FF_STATUS_NOW="$now" python3 -I "$render"
check "a file of them cut short: each day read again, the page the same" "same" "$(cmp -s "$work/first.html" "$status/page/index.html" && echo same || echo different)"

checks_done status
