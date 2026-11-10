#!/usr/bin/env bash
# FF on its development server, from this checkout (README.md): the checkout's files copied to the server's
# /data/ff/src, those git tracks and those it doesn't ignore, so never a .env, a key or node_modules; then
# server.sh run there as root, which installs or updates everything; then smoke.sh, a customer's path through the
# server's own proxy. The same command installs and updates; the server then updates itself at night, to master's
# newest commit that passed (updater/update.sh). The server's address and login stay in your SSH config: this script
# knows only the name it gives the server.
#   deploy/dev-server/install.sh <ssh host> [--no-smoke]
#   FF_ADMIN_ALLOW='<address>/32 …' deploy/dev-server/install.sh <ssh host>   # other addresses for the admin app
#   FF_UPDATER_KEY=<file> FF_UPDATER_TOKEN=<file> deploy/dev-server/install.sh <ssh host>
#       the updater's: the repository's read-only deploy key, its private half; a file holding a GitHub token that
#       reads the workflow's results. Each is carried once; the server keeps it until another is given.
set -euo pipefail
host="${1:?usage: $0 <ssh host, as your SSH config names it> [--no-smoke]}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"
# The images' tag: the commit; with changes not committed, the moment too, so that each run's images are new ones.
version="$(git rev-parse --short=12 HEAD)"
if ! git diff --quiet HEAD || [ -n "$(git ls-files --others --exclude-standard)" ]; then version="$version-dirty-$(date +%s)"; fi
# The address the server sees this machine connect from, the operator's: the admin app and Keycloak's
# administration answer it alone.
admin_allow="${FF_ADMIN_ALLOW:-$(ssh "$host" 'echo "${SSH_CLIENT%% *}"')/32}"

for file in "${FF_UPDATER_KEY:-}" "${FF_UPDATER_TOKEN:-}"; do
  [ -z "$file" ] || [ -r "$file" ] || { echo "install.sh: can't read $file, which FF_UPDATER_KEY or FF_UPDATER_TOKEN names" >&2; exit 2; }
done

echo "== the checkout, to $host:/data/ff/src ($version)"
ssh "$host" 'sudo install -d -o deploy -g deploy -m 0750 /data/ff /data/ff/src && sudo install -d -m 0700 /data/ff/updater'
rsync -a --delete --filter=':- .gitignore' --exclude=.git --rsync-path='sudo -u deploy rsync' ./ "$host:/data/ff/src/"
# <name> <file>: the file, given on stdin, as root's alone in the updater's folder; never on a command line.
carry() {
  [ -n "$2" ] || return 0
  echo "== $1, to $host:/data/ff/updater/$1"
  ssh "$host" "sudo sh -c 'umask 077 && cat >/data/ff/updater/$1.new && mv /data/ff/updater/$1.new /data/ff/updater/$1'" <"$2"
}
carry deploy-key "${FF_UPDATER_KEY:-}"
carry github-token "${FF_UPDATER_TOKEN:-}"

# The updater's lock, which an update holds: server.sh never runs twice at once.
ssh "$host" "sudo flock -n -E 75 /data/ff/updater/lock env FF_VERSION='$version' FF_ADMIN_ALLOW='$admin_allow' bash /data/ff/src/deploy/dev-server/server.sh" || {
  status=$?
  [ "$status" != 75 ] || echo "install.sh: the server is updating itself (journalctl -u ff-updater there): run this again once it ends" >&2
  exit "$status"
}
[ "${2:-}" = --no-smoke ] || ssh "$host" 'sudo bash /data/ff/src/deploy/dev-server/smoke.sh'
