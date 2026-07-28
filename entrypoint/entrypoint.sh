#!/usr/bin/env bash
#
# Container bootstrap and PID 1 supervisor for the omp-bundler runtime.
#
# Boot order:
#   1. Render models.yml from the env-var template.
#   2. Run the orphan sweep once (a core module); fail if it is missing
#      or exits non-zero. Its failures are never hidden. The sweep
#      reclaims orphaned RPC child process groups recorded in
#      OMP_CHILD_REGISTRY_PATH.
#   3. Start the core server (port 8787) and the Pumble adapter (port
#      8765) as supervised child processes. This shell remains PID 1,
#      traps TERM/INT, forwards signals to both children, and reaps
#      the sibling if either exits (fail-fast: the first child to
#      exit tears down the other, and the container exits with that
#      child's status).
#
# The core server loads the ambient ingest extension at runtime; it
# must be present in the staged packages/core/src tree.
#
# The agent folder is installed at $HOME/.omp/agent (OMP's default
# agent directory), NOT via OMP_AGENT_DIR, so every discovery
# surface (config, extensions, tools, agents, skills) shares one
# root without an explicit extension path.
set -euo pipefail

# -- paths -------------------------------------------------------------
AGENT_DIR="${HOME}/.omp/agent"
BUILD_DIR="/app/build"
MODELS_TMPL="${AGENT_DIR}/models.yml.tmpl"
MODELS_OUT="${AGENT_DIR}/models.yml"

# Explicit /data mount paths. The volume is shared with the pumble
# adapter, which writes attachments under /data/workspace.
DATA_DIR="/data"
SESSIONS_DIR="${DATA_DIR}/sessions"
WORKSPACE_DIR="${DATA_DIR}/workspace"
ARTIFACTS_DIR="${DATA_DIR}/artifacts"

# Child registry: the orphan sweep and the core server both read and
# write this JSON file to track live RPC child process groups. It
# lives on the durable /data volume so it survives restarts.
CHILD_REGISTRY="${OMP_CHILD_REGISTRY_PATH:-${DATA_DIR}/child-registry.json}"
export OMP_CHILD_REGISTRY_PATH="$CHILD_REGISTRY"

# Core and Pumble entrypoints, overridable for development. The
# orphan sweep, core server, and pumble server land in their package
# src trees. Bun executes the TypeScript source directly.
ORPHAN_SWEEP="${OMP_ORPHAN_SWEEP:-/app/packages/core/src/orphan-sweep.ts}"
CORE_SERVER="${OMP_CORE_SERVER:-/app/packages/core/src/server.ts}"
PUMBLE_SERVER="${OMP_PUMBLE_SERVER:-/app/packages/pumble-adapter/src/server.ts}"

# Ambient ingest extension loaded by the core server at runtime.
AMBIENT_EXTENSION="${OMP_AMBIENT_EXTENSION:-/app/packages/core/src/ambient-ingest-extension.ts}"

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() { printf '[entrypoint] error: %s\n' "$*" >&2; exit 1; }

# -- 0. /data mount paths ----------------------------------------------
# Ensure the shared volume subdirectories exist. Artifacts are
# relocated by PI_ARTIFACTS_DIR=/data/artifacts (set in the Dockerfile),
# so no symlink is needed. Sessions have no dedicated OMP env var, so
# symlink $HOME/.omp/agent/sessions -> /data/sessions to keep session
# data on the durable volume instead of the ephemeral image layer.
mkdir -p "$SESSIONS_DIR" "$WORKSPACE_DIR" "$ARTIFACTS_DIR"

link_into_data() {
  local target="$1" expected="$2"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    die "refusing to clobber existing $target (expected a symlink or nothing)"
  fi
  if [ -L "$target" ]; then
    # Already a symlink: verify it points at the expected data dir.
    # A stale link to a different path is a failure, not silently
    # accepted.
    local resolved
    resolved="$(readlink "$target")"
    if [ "$resolved" != "$expected" ]; then
      die "$target is a symlink to '$resolved', expected '$expected'"
    fi
    return 0
  fi
  ln -s "$expected" "$target"
}
link_into_data "${AGENT_DIR}/sessions" "$SESSIONS_DIR"

# -- 1. render models --------------------------------------------------
# bun build/render-models.ts expands ${VAR} placeholders against the
# container environment and fails loudly if any are missing, empty,
# or leave unresolved survivors. The seven required render env vars
# are documented in the Dockerfile; the renderer validates them.
log "rendering models.yml from ${MODELS_TMPL}"
bun "$BUILD_DIR/render-models.ts" \
  --input "$MODELS_TMPL" \
  --output "$MODELS_OUT"
log "models rendered to ${MODELS_OUT}"

# -- 2. orphan sweep ---------------------------------------------------
# The orphan sweep is a core module. It MUST run once; we do not
# silently skip it. If the executable is absent or fails, the
# container refuses to start; sweep failures are never hidden. The
# core server will also sweep before it listens, but running it here
# guarantees no orphaned RPC children survive into the new container.
[ -f "$ORPHAN_SWEEP" ] || die "orphan sweep not found at ${ORPHAN_SWEEP}"
log "running orphan sweep: ${ORPHAN_SWEEP}"
bun "$ORPHAN_SWEEP"
log "orphan sweep complete"

# -- 3. start core + pumble under supervision ---------------------------
# This shell is PID 1. It starts both services as child processes
# and stays resident to forward signals and tear down siblings.

[ -f "$CORE_SERVER" ] || die "core server not found at ${CORE_SERVER}"
[ -f "$PUMBLE_SERVER" ] || die "pumble server not found at ${PUMBLE_SERVER}"
[ -f "$AMBIENT_EXTENSION" ] || die "ambient ingest extension not found at ${AMBIENT_EXTENSION}"

CORE_PID=""
PUMBLE_PID=""
EXIT_CODE=0
TEARING_DOWN=0

# Forward a signal to both children. Uses the negative-pid kill to
# hit the whole process group when the child spawned its own group.
forward_signal() {
  local sig="$1"
  if [ -n "$PUMBLE_PID" ] && kill -0 "$PUMBLE_PID" 2>/dev/null; then
    kill -"$sig" "$PUMBLE_PID" 2>/dev/null || true
  fi
  if [ -n "$CORE_PID" ] && kill -0 "$CORE_PID" 2>/dev/null; then
    kill -"$sig" "$CORE_PID" 2>/dev/null || true
  fi
}

trap 'TEARING_DOWN=1; forward_signal TERM' TERM
trap 'TEARING_DOWN=1; forward_signal INT' INT

log "starting core server: ${CORE_SERVER}"
bun "$CORE_SERVER" &
CORE_PID=$!

log "starting pumble adapter: ${PUMBLE_SERVER}"
bun "$PUMBLE_SERVER" &
PUMBLE_PID=$!

log "core pid=${CORE_PID}, pumble pid=${PUMBLE_PID}"

# Wait for the first child to exit. When either service dies, the
# other is torn down (fail-fast sibling termination) and the
# container exits with the first child's status. No background
# process is left unmonitored.
wait -n
FIRST_EXIT=$?

if [ "$TEARING_DOWN" -eq 1 ]; then
  # Signal-driven shutdown: forward already sent. Wait for both to
  # finish, then exit with the first child's status (0 if it exited
  # cleanly after the signal, non-zero if it had already crashed).
  EXIT_CODE="$FIRST_EXIT"
else
  # A child died on its own. Fail fast: tear down the sibling.
  log "child exited (status ${FIRST_EXIT}); tearing down sibling"
  EXIT_CODE="$FIRST_EXIT"
  forward_signal TERM
fi

# Reap both children. Give them a moment, then SIGKILL stragglers.
if [ -n "$CORE_PID" ] && kill -0 "$CORE_PID" 2>/dev/null; then
  wait "$CORE_PID" 2>/dev/null || true
fi
if [ -n "$PUMBLE_PID" ] && kill -0 "$PUMBLE_PID" 2>/dev/null; then
  wait "$PUMBLE_PID" 2>/dev/null || true
fi

# Hard-kill any survivors after a short grace period.
sleep 1
if [ -n "$CORE_PID" ] && kill -0 "$CORE_PID" 2>/dev/null; then
  log "core did not exit; sending SIGKILL"
  kill -9 "$CORE_PID" 2>/dev/null || true
  wait "$CORE_PID" 2>/dev/null || true
fi
if [ -n "$PUMBLE_PID" ] && kill -0 "$PUMBLE_PID" 2>/dev/null; then
  log "pumble did not exit; sending SIGKILL"
  kill -9 "$PUMBLE_PID" 2>/dev/null || true
  wait "$PUMBLE_PID" 2>/dev/null || true
fi

log "supervisor exiting (status ${EXIT_CODE})"
exit "$EXIT_CODE"
