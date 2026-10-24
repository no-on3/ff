#!/usr/bin/env bash
# FF on its development server, from this checkout (README.md): the checkout's files copied to the server's
# /data/ff/src, those git tracks and those it doesn't ignore, so never a .env, a key or node_modules; then
# server.sh run there as root, which installs or updates everything; then smoke.sh, a customer's path through the
# server's own proxy. The same command installs and updates. The server's address and login stay in your SSH
# config: this script knows only the name it gives the server.
#   deploy/dev-server/install.sh <ssh host> [--no-smoke]
#   FF_ADMIN_ALLOW='<address>/32 …' deploy/dev-server/install.sh <ssh host>   # other addresses for the admin app
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

echo "== the checkout, to $host:/data/ff/src ($version)"
ssh "$host" 'sudo install -d -o deploy -g deploy -m 0750 /data/ff /data/ff/src'
rsync -a --delete --filter=':- .gitignore' --exclude=.git --rsync-path='sudo -u deploy rsync' ./ "$host:/data/ff/src/"

ssh "$host" "sudo FF_VERSION='$version' FF_ADMIN_ALLOW='$admin_allow' bash /data/ff/src/deploy/dev-server/server.sh"
[ "${2:-}" = --no-smoke ] || ssh "$host" 'sudo bash /data/ff/src/deploy/dev-server/smoke.sh'
