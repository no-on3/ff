# shellcheck shell=bash
# What a failed run leaves behind, for whoever reads it after: the cluster's pods, events and logs, the containers'
# and the compose services' logs, and the suite's own logs, in hack/.ci/failure/<suite>/, which the CI server keeps
# with the run for 7 days. A suite's cleanup calls these when it failed, before its namespaces and containers go.
# Each one goes on past what it can't reach: evidence never fails a run that failed already.
#   source "$FF_REPO_ROOT/hack/lib/evidence.sh"
#   dir="$(evidence_start <suite>)"; evidence_cluster "$dir" [namespace...]; evidence_containers "$dir" <name...>
#   evidence_compose "$dir" <compose command...>; evidence_logs "$dir" <directory>; evidence_done "$dir" <suite>

evidence_started_at="$(date -u +%FT%TZ)"

evidence_start() { # <suite>: its directory, emptied; prints its path
  local dir="$FF_REPO_ROOT/hack/.ci/failure/$1"
  rm -rf "$dir"
  mkdir -p "$dir"
  echo "$dir"
}

# The cluster as kubectl sees it: every pod and the recent events, then, for each namespace named (every one when none
# is), its pods described and each container's log, the one before a restart too.
evidence_cluster() { # <dir> [namespace...]
  local dir="$1" ns pod
  shift
  kubectl get pods -A -o wide >"$dir/pods.txt" 2>&1 || true
  kubectl get events -A --sort-by=.lastTimestamp -o wide >"$dir/events.txt" 2>&1 || true
  [ $# -gt 0 ] || set -- $(kubectl get namespaces -o jsonpath='{.items[*].metadata.name}' 2>/dev/null)
  for ns in "$@"; do
    kubectl get namespace "$ns" >/dev/null 2>&1 || continue
    mkdir -p "$dir/namespaces/$ns"
    kubectl -n "$ns" describe pods >"$dir/namespaces/$ns/describe.txt" 2>&1 || true
    for pod in $(kubectl -n "$ns" get pods -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
      kubectl -n "$ns" logs "$pod" --all-containers --prefix --timestamps >"$dir/namespaces/$ns/$pod.log" 2>&1 || true
      kubectl -n "$ns" logs "$pod" --all-containers --prefix --timestamps --previous >"$dir/namespaces/$ns/$pod.previous.log" 2>/dev/null ||
        rm -f "$dir/namespaces/$ns/$pod.previous.log"
    done
  done
}

evidence_containers() { # <dir> <container...>: each one's log since the run started, a k3d node's (kubelet, k3s) too
  local dir="$1" name
  shift
  mkdir -p "$dir/containers"
  for name in "$@"; do
    docker logs --timestamps --since "$evidence_started_at" "$name" >"$dir/containers/$name.log" 2>&1 || rm -f "$dir/containers/$name.log"
  done
}

evidence_compose() { # <dir> <compose command...>: the project's services and their logs
  local dir="$1"
  shift
  { "$@" ps -a && "$@" logs --no-color --timestamps; } >"$dir/compose.log" 2>&1 || true
}

evidence_logs() { # <dir> <directory>: the suite's own logs written during this run, the backend's among them
  local dir="$1" source="$2"
  [ -d "$source" ] || return 0
  mkdir -p "$dir/logs"
  # A suite's work directory outlives its runs: an older run's logs would mislead.
  find "$source" -maxdepth 2 -name '*.log' -size -50M -newermt "$evidence_started_at" -exec cp -t "$dir/logs" {} + 2>/dev/null || true
}

evidence_done() { # <dir> <suite>: says where, for the person reading the run's output
  echo "$2: what the run left behind is in ${1#"$FF_REPO_ROOT/"}: pods, events, logs (hack/.ci/report.md lists the failed checks)" >&2
}
