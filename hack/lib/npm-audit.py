#!/usr/bin/env python3
"""npm audit's report on what ships (`npm audit --omit=dev --json`, on stdin), against .npmauditignore: every high
or critical advisory fails, unless the list accepts it for this directory and this package, and its date hasn't come
yet. Prints each advisory that fails, and each one let through with its date, so that the log says what was;
and an entry of this directory's that nothing matches any more, to remove.
  npm audit --omit=dev --json | hack/lib/npm-audit.py <directory> <list> [--today YYYY-MM-DD]
"""
import datetime
import json
import sys


def accepted(path):
    """(directory, package, advisory) -> the date from which the audit reports it again."""
    entries = {}
    with open(path, encoding="utf-8") as lines:
        for number, line in enumerate(lines, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            fields = line.split()
            if len(fields) != 4:
                sys.exit(f"{path}:{number}: expected <directory> <package> <advisory> <expires>, got: {line}")
            directory, package, advisory, expires = fields
            try:
                entries[(directory, package, advisory)] = datetime.date.fromisoformat(expires)
            except ValueError:
                sys.exit(f"{path}:{number}: {expires} is no date (YYYY-MM-DD)")
    return entries


def main(argv):
    today = datetime.date.today()
    if "--today" in argv:
        at = argv.index("--today")
        today = datetime.date.fromisoformat(argv[at + 1])
        del argv[at : at + 2]
    if len(argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-1].strip())
    directory, path = argv
    listed = accepted(path)
    raw = sys.stdin.read()
    try:
        report = json.loads(raw)
    except json.JSONDecodeError:
        sys.exit(f"{directory}: npm audit gave no report: {raw.strip()[:300]}")
    if "error" in report:
        sys.exit(f"{directory}: npm audit failed: {report['error'].get('summary', report['error'])}")
    failing, let_through, matched = [], [], set()
    for package, entry in sorted(report.get("vulnerabilities", {}).items()):
        # An advisory is an object in the vulnerable package's own entry; a name there is a package it comes through.
        for advisory in entry.get("via", []):
            if not isinstance(advisory, dict) or advisory.get("severity") not in ("high", "critical"):
                continue
            ghsa = advisory.get("url", "").rstrip("/").rsplit("/", 1)[-1]
            line = f"{package} {advisory.get('range')}: {advisory['severity']}, {advisory.get('title')} ({advisory.get('url')})"
            key = (directory, package, ghsa)
            expires = listed.get(key)
            if expires is None:
                failing.append(line)
            elif expires <= today:
                matched.add(key)
                failing.append(f"{line}: accepted until {expires} only")
            else:
                matched.add(key)
                let_through.append(f"{line}: accepted until {expires}")
    for line in failing:
        print(f"  FAIL {line}")
    for line in let_through:
        print(f"  accepted {line}")
    for key in sorted(k for k in listed if k[0] == directory and k not in matched):
        print(f"  note: {path} accepts {key[2]} in {key[1]}, which the audit no longer reports: remove it")
    if failing:
        sys.exit(1)
    print(f"  {directory}: no high or critical advisory but those accepted ({len(let_through)})")


if __name__ == "__main__":
    main(sys.argv[1:])
