#!/usr/bin/env python3
"""Markdown sanity checks for FF docs (standard library only).

Checks, per file:
  * code fences are balanced, a closing one has nothing after it (Markdown would keep the block open, and the
    text after it would show as code), and an opening one names one language at most;
  * every table row has the same number of cells as its header;
  * every relative link target exists (anchors are not checked).

Usage: hack/check-docs.py FILE.md [FILE.md ...]   (exit 1 on any problem)
"""
import re
import sys
from pathlib import Path

LINK = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")


def cells(line: str) -> int:
    # Inline code and escaped pipes don't separate cells.
    stripped = re.sub(r"`[^`]*`", "X", line).replace("\\|", "X")
    return stripped.count("|") - 1


def check(path: Path) -> list[str]:
    problems = []
    lines = path.read_text(encoding="utf-8").split("\n")
    in_code = False
    fences = 0
    header = None
    for number, line in enumerate(lines, start=1):
        if line.strip().startswith("```"):
            after = line.strip().lstrip("`").strip()
            if in_code and after:
                problems.append(f"{path}:{number}: text after a closing code fence: the block doesn't end there")
            elif not in_code and " " in after:
                problems.append(f"{path}:{number}: a code fence names one language; the rest belongs on a line of its own")
            in_code = not in_code
            fences += 1
            header = None
            continue
        if in_code:
            continue
        if line.startswith("|"):
            count = cells(line)
            if header is None:
                header = count
            elif count != header:
                problems.append(f"{path}:{number}: table row has {count} cells, header has {header}")
        else:
            header = None
        for target in LINK.findall(line):
            if re.match(r"^[a-z][a-z0-9+.-]*:", target) or target.startswith("#"):
                continue  # external URL or same-page anchor
            file_part = target.split("#", 1)[0]
            if file_part and not (path.parent / file_part).exists():
                problems.append(f"{path}:{number}: broken relative link -> {target}")
    if fences % 2:
        problems.append(f"{path}: unbalanced code fences ({fences})")
    return problems


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__.strip())
        return 2
    problems = [p for name in argv for p in check(Path(name))]
    for p in problems:
        print(p)
    print(f"docs: {'FAIL' if problems else 'OK'} ({len(argv)} file(s), {len(problems)} problem(s))")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
