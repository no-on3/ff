#!/usr/bin/env bash
# Resource guard. Run it before any heavy step (npm install, docker pull/build,
# cluster create, image import, e2e). It exits non-zero when the machine is too
# low on disk, memory, or CPU headroom to safely start more processes.
#
# Thresholds can be overridden with environment variables:
#   MIN_DOCKER_DISK_GB   free space on the filesystem holding Docker's data root
#   MIN_REPO_DISK_GB     free space on the filesystem holding this repository
#   MIN_MEM_AVAILABLE_MB MemAvailable from /proc/meminfo
#   MAX_LOAD_FACTOR      1-minute load average must stay below nproc * factor; "off" reports the load without
#                        refusing on it, for a machine that runs one job alone, as a CI runner does, where the
#                        load is that job's own steps and waiting frees nothing
set -euo pipefail

MIN_DOCKER_DISK_GB="${MIN_DOCKER_DISK_GB:-6}"
MIN_REPO_DISK_GB="${MIN_REPO_DISK_GB:-5}"
MIN_MEM_AVAILABLE_MB="${MIN_MEM_AVAILABLE_MB:-2500}"
MAX_LOAD_FACTOR="${MAX_LOAD_FACTOR:-2}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker_root="/"
if command -v docker >/dev/null 2>&1; then
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /)"
fi
# The data root may not be readable by this user; df on its parent works.
[ -e "$docker_root" ] || docker_root="$(dirname "$docker_root")"

free_gb() { df -P -BG "$1" | awk 'NR==2 { gsub("G", "", $4); print $4 }'; }

docker_free="$(free_gb "$docker_root")"
repo_free="$(free_gb "$repo_root")"
mem_available_mb="$(awk '/^MemAvailable:/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
load1="$(cut -d' ' -f1 /proc/loadavg)"
cpus="$(nproc)"

failures=()
[ "$docker_free" -ge "$MIN_DOCKER_DISK_GB" ] ||
  failures+=("docker filesystem ($docker_root) has ${docker_free}G free, need ${MIN_DOCKER_DISK_GB}G")
[ "$repo_free" -ge "$MIN_REPO_DISK_GB" ] ||
  failures+=("repository filesystem has ${repo_free}G free, need ${MIN_REPO_DISK_GB}G")
[ "$mem_available_mb" -ge "$MIN_MEM_AVAILABLE_MB" ] ||
  failures+=("only ${mem_available_mb}MB memory available, need ${MIN_MEM_AVAILABLE_MB}MB")
load="load ${load1}/${cpus} cpus"
if [ "$MAX_LOAD_FACTOR" = off ]; then
  load+=", not checked"
else
  max_load="$(awk -v c="$cpus" -v f="$MAX_LOAD_FACTOR" 'BEGIN { print c * f }')"
  awk -v l="$load1" -v m="$max_load" 'BEGIN { exit !(l < m) }' ||
    failures+=("load average ${load1} is above ${max_load} (${cpus} CPUs x ${MAX_LOAD_FACTOR})")
fi

summary="docker-fs ${docker_free}G free | repo-fs ${repo_free}G free | mem ${mem_available_mb}MB available | ${load}"

if [ "${#failures[@]}" -gt 0 ]; then
  echo "resources: FAIL ($summary)" >&2
  for f in "${failures[@]}"; do echo "  - $f" >&2; done
  echo "Free up resources before starting more processes." >&2
  exit 1
fi
echo "resources: OK ($summary)"
