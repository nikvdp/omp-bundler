#!/usr/bin/env bash
#
# Container bootstrap for the omp-bundler agent runtime.
#
# Boot order:
#   1. Render models.yml from the env-var template.
#   2. Run the orphan sweep (a later core module); fail if it is
#      missing or exits non-zero, its failures are never hidden.
#   3. exec the core supervisor, which owns the omp --mode rpc child
#      and becomes PID 1.
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

# Later core modules, overridable for development. The orphan sweep
# and supervisor land in packages/core alongside rpc-child.ts.
ORPHAN_SWEEP="${OMP_ORPHAN_SWEEP:-/app/packages/core/src/orphan-sweep.ts}"
SUPERVISOR="${OMP_SUPERVISOR:-/app/packages/core/src/supervisor.ts}"

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
# The orphan sweep is a later core module. It MUST run; we do not
# silently skip it. If the executable is absent or fails, the
# container refuses to start; sweep failures are never hidden.
[ -f "$ORPHAN_SWEEP" ] || die "orphan sweep not found at ${ORPHAN_SWEEP}"
log "running orphan sweep: ${ORPHAN_SWEEP}"
bun "$ORPHAN_SWEEP"
log "orphan sweep complete"

# -- 3. exec core supervisor -------------------------------------------
# The supervisor owns the omp --mode rpc child process and becomes
# PID 1. exec replaces this shell so signals propagate cleanly.
log "executing core supervisor: ${SUPERVISOR}"
exec bun "$SUPERVISOR" "$@"