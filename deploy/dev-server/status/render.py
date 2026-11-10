#!/usr/bin/env python3
"""FF's status page (../README.md, "The status page"), from the probe's minutes, with the standard library alone.

It reads, in /data/ff/status: minutes.log, a line of JSON for each minute probe.sh ran ({"at": "<the minute>Z",
"checks": {<check>: {"ok", "code", "ms", "days", "error"?}}}); probe.env, for FF's domain; and incidents.md, which
the operator writes by hand on the server, an incident a heading ("## 2026-11-12 03:10 UTC: the API down"), its
paragraphs and lists under it, newest first. It writes page/index.html, whole or not at all: the state now, each
check's last 90 days as a bar a day, its uptime this month, the certificates about to end, the incidents, and the
line that says where the probe runs. A minute is up for a check when its answer was the one expected, and slow when
it was, after more than 2 s; a minute is up for FF when it is for every check. A day without minutes says so and
counts for nothing.
  /usr/local/lib/ff-status/render.py      (as ff-status: ff-status-probe.service runs it after probe.sh, each minute)
Its tests (hack/test-status.sh) give FF_STATUS_HOME, in place of the server's folder, and FF_STATUS_NOW, the time to
render at.
"""
import datetime as dt
import html
import io
import json
import os
import re
from collections import defaultdict
from pathlib import Path

HOME = Path(os.environ.get("FF_STATUS_HOME", "/data/ff/status"))
DAYS = 90
SLOW_MS = 2000
# A page whose last minute is older says that the probe stopped, not that FF is up.
STALE = dt.timedelta(minutes=5)
# Let's Encrypt's certificates, for FF's fixed names, are renewed with 30 days left: under 14, renewing is failing. The
# proxy's own authority's, for function URLs and sites, last hours and are renewed as they go: no warning for those.
CERTIFICATE_DAYS = 14
LETS_ENCRYPTS = {"api": "api", "console": "console", "login": "login", "lambda": "lambda", "s3": "s3", "sqs": "sqs", "ses": "email"}

# Each check, in the page's order: its name, and what the probe does, {domain} the server's.
CHECKS = {
    "api": ("API", "FF's API answering at api.{domain}"),
    "console": ("Console", "the console's page at console.{domain}"),
    "login": ("Login", "the sign-in page at login.{domain}"),
    "lambda": ("Lambda endpoint", "a function invoked at lambda.{domain}, as AWS's tools invoke one"),
    "s3": ("S3 endpoint", "a bucket's file read at s3.{domain}"),
    "sqs": ("SQS endpoint", "a message sent and received at sqs.{domain}"),
    "ses": ("SES endpoint", "email.{domain} answering, as it answers a request that isn't signed"),
    "canary": ("Function URLs", "a function called at its URL"),
    "site": ("Sites", "a bucket's site"),
}
STATES = {
    "up": "up",
    "slow": "slow",
    "partial": "down a while",
    "down": "down",
    "none": "no minutes",
}


class Tally:
    """A check's minutes, or FF's, over a day or a month: those probed, those up, and those up but slow."""

    __slots__ = ("minutes", "up", "slow")

    def __init__(self):
        self.minutes = self.up = self.slow = 0

    def add(self, up: bool, slow: bool):
        self.minutes += 1
        self.up += up
        self.slow += up and slow

    def merge(self, other: "Tally"):
        self.minutes += other.minutes
        self.up += other.up
        self.slow += other.slow

    def state(self) -> str:
        """none, up, slow (a hundredth of its minutes or more), partial (up 99 % of the time or more), or down."""
        if self.minutes == 0:
            return "none"
        if self.up == self.minutes:
            return "slow" if self.slow * 100 >= self.minutes else "up"
        return "partial" if self.up * 100 >= self.minutes * 99 else "down"

    def uptime(self) -> str:
        if self.minutes == 0:
            return "no minutes"
        if self.up == self.minutes:
            return "100%"
        # Rounded down, so that a single minute down never reads as 100%.
        return f"{int(self.up * 10000 / self.minutes) / 100:.2f}%"


def setting(name: str) -> str:
    try:
        lines = (HOME / "probe.env").read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return ""
    values = [line.split("=", 1)[1] for line in lines if line.startswith(name + "=")]
    return values[-1] if values else ""


def read_minutes(window: list[str]):
    """Each day's tallies in the window, by check and for FF (""), and the last minute, or None. A day before today
    never changes: its tallies are kept in days.json, and its minutes skipped unread, as the probe writes each line
    with its minute first; today's are read each time."""
    days = defaultdict(lambda: defaultdict(Tally))
    today = window[-1]
    try:
        cached = json.loads((HOME / "days.json").read_text(encoding="utf-8"))
        cached = {day: names for day, names in cached.items() if window[0] <= day < today}
    except (FileNotFoundError, ValueError, AttributeError):
        cached = {}  # none yet, or a file cut short: every day read again
    for day, names in cached.items():
        for name, (minutes, up, slow) in names.items():
            days[day][name].minutes, days[day][name].up, days[day][name].slow = minutes, up, slow
    final = ""
    try:
        lines = open(HOME / "minutes.log", encoding="utf-8")
    except FileNotFoundError:
        lines = io.StringIO()
    with lines:
        for line in lines:
            if line.strip():
                final = line
            if line[7:17] in cached or line[7:17] < window[0]:
                continue  # '{"at":"' then the day
            try:
                minute = json.loads(line)
                at, checks = minute["at"], minute["checks"]
            except (ValueError, KeyError, TypeError):
                continue  # a line cut short, as a full disk leaves one
            if not checks or at[:10] < window[0]:
                continue
            day = days[at[:10]]
            every = True
            for name, check in checks.items():
                up, slow = check.get("ok") is True, (check.get("ms") or 0) > SLOW_MS
                day[name].add(up, slow)
                every = every and up
            day[""].add(every, any((check.get("ms") or 0) > SLOW_MS for check in checks.values()))
    finished = {day: {name: [tally.minutes, tally.up, tally.slow] for name, tally in days[day].items()} for day in days if day < today}
    if finished != cached:
        new = HOME / "days.json.new"
        new.write_text(json.dumps(finished, sort_keys=True), encoding="utf-8")
        os.replace(new, HOME / "days.json")
    try:
        last = json.loads(final)
        if not isinstance(last["at"], str) or not isinstance(last["checks"], dict):
            last = None
    except (ValueError, KeyError, TypeError):
        last = None
    return days, last


def inline(text: str) -> str:
    """A line of incidents.md: escaped, then `code`, **bold** and [a link](https://…)."""
    parts = text.split("`")
    out = []
    for index, part in enumerate(parts):
        part = html.escape(part)
        if index % 2 and index < len(parts) - 1:
            out.append(f"<code>{part}</code>")
            continue
        if index % 2:
            part = "`" + part  # a backtick never closed
        part = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", part)
        part = re.sub(r"\[([^\]]+)\]\((https?://[^\s)\"<>]+)\)", r'<a href="\2">\1</a>', part)
        out.append(part)
    return "".join(out)


def markdown(text: str) -> str:
    """incidents.md as the page shows it: headings, paragraphs and lists; no HTML of its own."""
    out, paragraph, items = [], [], []

    def close():
        if paragraph:
            out.append(f"<p>{' '.join(paragraph)}</p>")
            paragraph.clear()
        if items:
            out.append("<ul>" + "".join(f"<li>{item}</li>" for item in items) + "</ul>")
            items.clear()

    for line in text.splitlines():
        line = line.strip()
        if not line:
            close()
        elif line.startswith("#"):
            close()
            out.append(f"<h3>{inline(line.lstrip('#').strip())}</h3>")
        elif line.startswith(("- ", "* ")):
            if paragraph:
                close()
            items.append(inline(line[2:]))
        else:
            if items:
                close()
            paragraph.append(inline(line))
    close()
    return "\n".join(out)


def clock(at: str) -> str:
    """A minute as the page says it: 2026-11-10 14:05 UTC."""
    return at[:10] + " " + at[11:16] + " UTC"


def bars(label: str, tallies: list[tuple[str, Tally]]) -> str:
    cells = []
    for day, tally in tallies:
        said = STATES[tally.state()]
        detail = "" if tally.minutes == 0 else f", {tally.uptime()} of {tally.minutes} minutes up"
        if tally.slow:
            detail += f", {tally.slow} slow"
        cells.append(f'<li class="{tally.state()}" title="{day}: {said}{detail}"></li>')
    return f'<ol class="bars" aria-label="{html.escape(label)}, a bar a day for {DAYS} days">{"".join(cells)}</ol>'


def page(now: dt.datetime) -> str:
    domain = setting("domain") or "FF"
    today = now.date()
    window = [(today - dt.timedelta(days=back)).isoformat() for back in range(DAYS - 1, -1, -1)]
    days, last = read_minutes(window)
    month = today.isoformat()[:7]

    def this_month(tally: Tally) -> str:
        return "No minutes this month" if tally.minutes == 0 else f"{tally.uptime()} up this month"

    def month_tally(name: str) -> Tally:
        tally = Tally()
        for day in window:
            if day.startswith(month) and day in days:
                tally.merge(days[day][name])
        return tally

    # The state now, from the last minute, if it is recent.
    stale = last is None or now - dt.datetime.fromisoformat(last["at"].replace("Z", "+00:00")) > STALE
    checks = {} if stale else last["checks"]
    now_state = {}
    for name in CHECKS:
        check = checks.get(name)
        if check is None:
            now_state[name] = "none"
        elif check.get("ok") is not True:
            now_state[name] = "down"
        else:
            now_state[name] = "slow" if (check.get("ms") or 0) > SLOW_MS else "up"
    down = [CHECKS[name][0] for name, state in now_state.items() if state == "down"]
    slow = [CHECKS[name][0] for name, state in now_state.items() if state == "slow"]
    if stale:
        since = f"since {clock(last['at'])}" if last else "yet"
        banner = ("none", f"The probe hasn't written a minute {since}: what FF is doing now isn't known.")
    elif len(down) == len(CHECKS):
        banner = ("down", "FF is down.")
    elif down:
        banner = ("down", f"Part of FF is down: {', '.join(down)}.")
    elif slow:
        banner = ("slow", f"FF is up, and slow in part: {', '.join(slow)}.")
    else:
        banner = ("up", "All of FF is up.")

    warnings = []
    for name, host in LETS_ENCRYPTS.items():
        left = checks.get(name, {}).get("days")
        if isinstance(left, int) and left < CERTIFICATE_DAYS:
            warnings.append(f"{host}.{domain}'s certificate ends in {left} day{'' if left == 1 else 's'}.")

    rows = []
    for name, (title, what) in {"": ("All of FF", "every check up in the same minute"), **CHECKS}.items():
        tallies = [(day, days[day][name] if day in days else Tally()) for day in window]
        state = banner[0] if name == "" else now_state[name]
        rows.append(
            f'<section class="check{" whole" if name == "" else ""}">'
            f'<div class="head"><h2>{html.escape(title)}</h2>'
            f'<span class="now {state}">{STATES[state] if state != "none" else "not known"}</span></div>'
            f'<p class="what">{html.escape(what.format(domain=domain))}</p>'
            f"{bars(title, tallies)}"
            f'<p class="month">{this_month(month_tally(name))}</p></section>'
        )

    try:
        incidents = markdown((HOME / "incidents.md").read_text(encoding="utf-8"))
    except FileNotFoundError:
        incidents = ""
    made = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    legend = "".join(f'<li><span class="{state}"></span>{said}</li>' for state, said in STATES.items())
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<link rel="icon" href="data:,">
<title>FF status</title>
<style>
  :root {{
    --bg: #f6f6f3; --surface: #ffffff; --text: #1d201c; --muted: #5f645d; --border: #d8dbd4;
    --up: #1a7f37; --slow: #e5a50a; --partial: #d9730d; --down: #b42318; --none: #d8dbd4;
    color-scheme: light dark;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{
      --bg: #121412; --surface: #1b1e1b; --text: #e7e9e4; --muted: #a2a89f; --border: #343933;
      --up: #3fb950; --slow: #e3b341; --partial: #f0883e; --down: #f85149; --none: #343933;
    }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }}
  main {{ max-width: 860px; margin: 0 auto; padding: 32px 16px 48px; }}
  h1 {{ font-size: 22px; margin: 0 0 4px; }}
  h1 small {{ color: var(--muted); font-weight: 400; font-size: 15px; }}
  .banner {{ margin: 20px 0; padding: 14px 16px; border-radius: 8px; background: var(--surface); border: 1px solid var(--border);
    border-left: 6px solid var(--none); font-size: 17px; font-weight: 600; }}
  .banner.up {{ border-left-color: var(--up); }} .banner.slow {{ border-left-color: var(--slow); }}
  .banner.down {{ border-left-color: var(--down); }}
  .warnings {{ margin: 0 0 20px; padding: 0 0 0 20px; color: var(--down); }}
  .check {{ background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin: 0 0 12px; }}
  .check.whole {{ border-width: 2px; }}
  .head {{ display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }}
  h2 {{ font-size: 16px; margin: 0; }}
  .now {{ font-size: 13px; font-weight: 600; white-space: nowrap; }}
  .now.up {{ color: var(--up); }} .now.slow {{ color: var(--slow); }} .now.down {{ color: var(--down); }} .now.none {{ color: var(--muted); }}
  .what, .month {{ margin: 2px 0 8px; color: var(--muted); font-size: 13px; }}
  .month {{ margin: 6px 0 0; text-align: right; }}
  .bars {{ display: grid; grid-template-columns: repeat({DAYS}, 1fr); gap: 1px; list-style: none; margin: 0; padding: 0; height: 30px; }}
  .bars li, .legend span {{ border-radius: 1px; }}
  .up {{ --c: var(--up); }} .slow {{ --c: var(--slow); }} .partial {{ --c: var(--partial); }} .down {{ --c: var(--down); }} .none {{ --c: var(--none); }}
  .bars li, .legend span {{ background: var(--c); }}
  .legend {{ display: flex; flex-wrap: wrap; gap: 4px 16px; list-style: none; padding: 0; margin: 8px 0 24px; color: var(--muted); font-size: 13px; }}
  .legend span {{ display: inline-block; width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px; }}
  .incidents h3 {{ font-size: 15px; margin: 16px 0 4px; }}
  .incidents p, .incidents ul {{ margin: 4px 0; }}
  code {{ font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }}
  a {{ color: inherit; }}
  footer {{ margin-top: 28px; color: var(--muted); font-size: 13px; }}
  #late {{ color: var(--down); font-weight: 600; }}
</style>
</head>
<body>
<main>
<h1>FF status <small>{html.escape(domain)}</small></h1>
<p class="banner {banner[0]}">{html.escape(banner[1])}</p>
{"<ul class='warnings'>" + "".join(f"<li>{html.escape(w)}</li>" for w in warnings) + "</ul>" if warnings else ""}
<ul class="legend" aria-label="What a bar's color says">{legend}</ul>
{"".join(rows)}
<section class="incidents">
<h2>Incidents</h2>
{incidents or "<p>None written.</p>"}
</section>
<footer>
<p>Probed every minute from the server FF runs on, as a customer reaches FF, through the server's own proxy: when the whole server is down, so is this page, and its last minutes are the server's.</p>
<p>Made at <time datetime="{made}">{clock(made)}</time>{f", from the minute of {clock(last['at'])}" if last else ""}. <span id="late"></span></p>
</footer>
</main>
<script>
  // A page that stopped being made says so, as a browser keeps showing it.
  var made = Date.parse(document.querySelector("footer time").getAttribute("datetime"));
  var minutes = Math.floor((Date.now() - made) / 60000);
  if (minutes > 5) document.getElementById("late").textContent = "That was " + minutes + " minutes ago: the page hasn't been made since.";
</script>
</body>
</html>
"""


def main():
    now_given = os.environ.get("FF_STATUS_NOW")
    now = dt.datetime.fromisoformat(now_given.replace("Z", "+00:00")) if now_given else dt.datetime.now(dt.timezone.utc)
    folder = HOME / "page"
    folder.mkdir(mode=0o755, exist_ok=True)
    new = folder / "index.html.new"
    new.write_text(page(now.astimezone(dt.timezone.utc)), encoding="utf-8")
    new.chmod(0o644)
    os.replace(new, folder / "index.html")


if __name__ == "__main__":
    main()
