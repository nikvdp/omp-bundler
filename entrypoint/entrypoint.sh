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
BUILD_DIR="${OMP_BUILD_DIR:-/app/build}"
MODELS_TMPL="${AGENT_DIR}/models.yml.tmpl"
MODELS_OUT="${AGENT_DIR}/models.yml"

# Explicit /data mount paths. The volume is shared with the pumble
# adapter, which writes attachments under /data/workspace.
DATA_DIR="${OMP_DATA_DIR:-/data}"
SESSIONS_DIR="${DATA_DIR}/sessions"
WORKSPACE_DIR="${DATA_DIR}/workspace"
ARTIFACTS_DIR="${DATA_DIR}/artifacts"
DURABLE_AGENTS_DIR="${DATA_DIR}/agents"

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
die() {
	printf '[entrypoint] error: %s\n' "$*" >&2
	exit 1
}

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

# Seed per-agent .omp configuration onto the durable /data volume.
# Image layout is /agents/<agentId>/.omp; the data layout becomes
# /data/agents/<agentId>/.omp. Each spawned agent runs with its cwd
# set to /data/agents/<agentId>, so OMP's project-level .omp config
# discovery picks up that agent's personality. The image is
# authoritative: the .omp tree is reseeded at every boot. Sibling
# working files under /data/agents/<agentId> are left untouched.
#
# Durable agent directories from an older image are retained for their
# sibling workspace files, but their stale .omp trees are removed before
# current baked agents are seeded.

# Source root for baked agent identities. Overridable for local
# development; defaults to the image /agents mount.
AGENTS_SRC="${AGENTS_SRC:-/agents}"

# Expand the baked agent identities first. When no agent is baked
# (the source directory is absent or empty), boot continues without
# seeding and without enforcing the leak guards below: an agentless
# image must start cleanly even if a stale /data/.omp exists, since
# no agent cwd will ever walk up into it.
if [ -L "$AGENTS_SRC" ]; then
	die "${AGENTS_SRC} must not be a symlink"
fi
if [ -d "$AGENTS_SRC" ]; then
	shopt -s nullglob dotglob
	set -- "$AGENTS_SRC"/*
	shopt -u nullglob dotglob
else
	set --
fi

# Dotglob exposes the .gitkeep placeholder shipped in agentless
# images (an /agents directory containing only .gitkeep). It is a
# regular file, not an agent entry, so drop it from the positional
# args before the entry-count decision below. An /agents holding
# only .gitkeep then counts as zero baked agents and boots without
# seeding or leak guards, matching the agentless-image contract.
_filtered=()
for _entry in "$@"; do
	if [ "$(basename "$_entry")" = ".gitkeep" ] && [ -f "$_entry" ] && [ ! -L "$_entry" ]; then
		continue
	fi
	_filtered+=("$_entry")
done
set -- "${_filtered[@]}"

_baked_ids=()
if [ "$#" -gt 0 ]; then
	# OMP's project-level config discovery walks up from the cwd, so a
	# /data/.omp or /data/agents/.omp directory would leak config into
	# every agent and corrupt isolation. Refuse to boot before any
	# seeding mutates the data volume.
	if [ -d "${DATA_DIR}/.omp" ]; then
		die "${DATA_DIR}/.omp must not exist: project-level config discovery walks up from each agent cwd and /data/.omp would leak config into every agent"
	fi
	if [ -d "${DURABLE_AGENTS_DIR}/.omp" ]; then
		die "${DURABLE_AGENTS_DIR}/.omp must not exist: project-level config discovery walks up from each agent cwd and /data/agents/.omp would leak config into every agent"
	fi

	# Validate the image-side paths before any durable state is changed.
	for _agent_src in "$@"; do
		_agent_id="$(basename "$_agent_src")"
		if [ -L "$_agent_src" ]; then
			die "${AGENTS_SRC}/${_agent_id} must not be a symlink"
		fi
		if [ ! -d "$_agent_src" ]; then
			die "${AGENTS_SRC}/${_agent_id} is not a directory (bake validation should make this unreachable; failing loudly anyway)"
		fi
		if [ -L "${_agent_src}/.omp" ]; then
			die "${AGENTS_SRC}/${_agent_id}/.omp must not be a symlink"
		fi
		if [ ! -d "${_agent_src}/.omp" ]; then
			die "${AGENTS_SRC}/${_agent_id} has no .omp directory (bake validation should make this unreachable; failing loudly anyway)"
		fi
		_baked_ids+=("$_agent_id")
	done
fi

# The durable agent root and each agent directory are operator state. Never
# follow a symlink at either level while reconciling image-owned .omp trees.
if [ -L "$DURABLE_AGENTS_DIR" ]; then
	die "${DURABLE_AGENTS_DIR} must not be a symlink"
fi
if [ -e "$DURABLE_AGENTS_DIR" ] && [ ! -d "$DURABLE_AGENTS_DIR" ]; then
	die "${DURABLE_AGENTS_DIR} must be a directory"
fi

_durable_agents=()
if [ -d "$DURABLE_AGENTS_DIR" ]; then
	shopt -s nullglob dotglob
	_durable_agents=("$DURABLE_AGENTS_DIR"/*)
	shopt -u nullglob dotglob

	# Preflight every durable path before removing any stale tree.
	for _durable_agent in "${_durable_agents[@]}"; do
		_agent_id="$(basename "$_durable_agent")"
		if [ -L "$_durable_agent" ]; then
			die "${DURABLE_AGENTS_DIR}/${_agent_id} must not be a symlink"
		fi
		if [ ! -d "$_durable_agent" ]; then
			die "${DURABLE_AGENTS_DIR}/${_agent_id} must be a directory"
		fi
		if [ -L "${_durable_agent}/.omp" ]; then
			die "${DURABLE_AGENTS_DIR}/${_agent_id}/.omp must not be a symlink"
		fi
	done

	# Remove only the image-owned subtree for IDs absent from this image.
	for _durable_agent in "${_durable_agents[@]}"; do
		_agent_id="$(basename "$_durable_agent")"
		_is_baked=0
		for _baked_id in "${_baked_ids[@]}"; do
			if [ "$_baked_id" = "$_agent_id" ]; then
				_is_baked=1
				break
			fi
		done
		if [ "$_is_baked" -eq 0 ] && [ -e "${_durable_agent}/.omp" ]; then
			rm -rf "${_durable_agent}/.omp"
			log "removed stale agent ${_agent_id}"
		fi
	done
fi

if [ "$#" -gt 0 ]; then
	for _agent_src in "$@"; do
		_agent_id="$(basename "$_agent_src")"
		_durable_agent="${DURABLE_AGENTS_DIR}/${_agent_id}"
		mkdir -p "$_durable_agent"
		rm -rf "${_durable_agent}/.omp"
		cp -R "${_agent_src}/.omp" "${_durable_agent}/.omp"
		log "seeded agent ${_agent_id}"
	done
fi

# -- 1. render models --------------------------------------------------
# bun build/render-models.ts expands runtime placeholders, omits providers
# with no configured placeholders, and fails on partial or malformed values.
log "rendering models.yml from ${MODELS_TMPL}"
bun "$BUILD_DIR/render-models.ts" \
	--input "$MODELS_TMPL" \
	--output "$MODELS_OUT"
log "models rendered to ${MODELS_OUT}"

# Optional central credential vault. Both values are required together. The
# renderer removes provider apiKey fields when the broker is configured, so
# the broker remains ahead of provider environment variables in OMP's
# credential cascade.
if [ -n "${OMP_AUTH_BROKER_URL:-}" ] || [ -n "${OMP_AUTH_BROKER_TOKEN:-}" ]; then
	[ -n "${OMP_AUTH_BROKER_URL:-}" ] || die "OMP_AUTH_BROKER_URL is required with OMP_AUTH_BROKER_TOKEN"
	[ -n "${OMP_AUTH_BROKER_TOKEN:-}" ] || die "OMP_AUTH_BROKER_TOKEN is required with OMP_AUTH_BROKER_URL"
	omp config set auth.broker.url "$OMP_AUTH_BROKER_URL" >/dev/null
	omp config set auth.broker.token "$OMP_AUTH_BROKER_TOKEN" >/dev/null
	log "configured OMP auth broker"
fi

# Default image composition: register the bundled Pumble adapter against its
# loopback callback and the selected filesystem agent. OMP_ADAPTERS remains
# caller-owned for multi-adapter deployments. Build the JSON with Bun so
# arbitrary secret bytes are escaped.
if [ -z "${OMP_ADAPTERS:-}" ]; then
	[ -n "${PUMBLE_AGENT_ID:-}" ] || die "PUMBLE_AGENT_ID is required when OMP_ADAPTERS is unset"
	[ -n "${PUMBLE_CORE_SHARED_SECRET:-}" ] || die "PUMBLE_CORE_SHARED_SECRET is required"
	# shellcheck disable=SC2016
	OMP_ADAPTERS="$(
		bun -e '
      const adapterId = process.env.PUMBLE_ADAPTER_ID?.trim() || "pumble";
      const agentId = process.env.PUMBLE_AGENT_ID;
      const port = process.env.PUMBLE_BRIDGE_PORT?.trim() || "8765";
      const callbackUrl =
        process.env.PUMBLE_CORE_CALLBACK_URL?.trim() ||
        `http://127.0.0.1:${port}/core/events`;
      process.stdout.write(JSON.stringify([{
        adapterId,
        callbackUrl,
        sharedSecret: process.env.PUMBLE_CORE_SHARED_SECRET,
        agentId,
      }]));
    '
	)"
	export OMP_ADAPTERS
	log "configured bundled Pumble adapter registration"
fi

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
set +e
wait -n
FIRST_EXIT=$?
set -e

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

# Give both children a bounded grace period, then SIGKILL stragglers.
for _ in {1..50}; do
	CORE_ALIVE=0
	PUMBLE_ALIVE=0
	if [ -n "$CORE_PID" ] && kill -0 "$CORE_PID" 2>/dev/null; then
		CORE_ALIVE=1
	fi
	if [ -n "$PUMBLE_PID" ] && kill -0 "$PUMBLE_PID" 2>/dev/null; then
		PUMBLE_ALIVE=1
	fi
	if [ "$CORE_ALIVE" -eq 0 ] && [ "$PUMBLE_ALIVE" -eq 0 ]; then
		break
	fi
	sleep 0.1
done
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
