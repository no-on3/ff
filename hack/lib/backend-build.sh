# shellcheck shell=bash
# The backend's build, BE/dist, with what it was built from written beside it: the end-to-end suites build it only
# when that changed (e2e_build), and the static stage, which always builds it, writes it too, so that a suite after it
# doesn't build it again.

backend_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../BE" && pwd)"
# Kept in the build, which nest empties before it builds.
backend_build_record="$backend_dir/dist/.built-from"

# backend_built_from: what the backend's build is made from, as one line: each file's name, time and size, hashed,
# and the build's own time; so a change, a file gone, and another build since, a backend's watch mode on this machine
# among them, each tell it from the build recorded.
backend_built_from() {
  (
    cd "$backend_dir"
    # A file gone is a change too, never a stop: the build that follows says what is missing.
    { find src package.json package-lock.json tsconfig.json tsconfig.build.json nest-cli.json -type f -printf '%p %T@ %s\n' 2>/dev/null || true; } |
      sort | sha256sum | cut -d' ' -f1
    stat -c %Y dist/main.js 2>/dev/null || true
  ) | paste -sd' '
}

# backend_build: the backend built, and what it was built from written beside the build.
backend_build() { (cd "$backend_dir" && npm run build) && backend_built_from >"$backend_build_record"; }

# backend_built: whether BE/dist is the build of the backend's files as they are.
backend_built() { [ -f "$backend_build_record" ] && [ "$(cat "$backend_build_record")" = "$(backend_built_from)" ]; }
