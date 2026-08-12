#!/usr/bin/env bash
#
# Container bootstrap and PID 1 supervisor for the omp-bundler runtime.
#
# Boot order:
#   1. Render models.yml from the env-var template.
#   2. Configure the selected bundled adapter (HTTP by default).
#   3. Run the orphan sweep once; fail if it is missing or fails.
#   4. Supervise the core server (port 8787), selected adapter (port 8765),
#      and optional cron scheduler. The first child to exit tears down siblings.
#
# The core server loads the ambient ingest extension at runtime; it
# must be present in the staged packages/core/src tree.
#
# The image-owned agent definition is refreshed beside its persistent
# workspace, then copied into an ephemeral OMP agent directory. OMP uses that
# explicit directory for config and component discovery while sessions remain
# linked to /data.
set -euo pipefail

# -- paths -------------------------------------------------------------
# One agent directory, at OMP's default location.
#
# OMP 17.1.3 honors OMP_AGENT_DIR for skills, AGENTS.md, and config.yml but
# ignores it for tools, extensions, models, and task agents. Pointing that
# variable at a second directory therefore splits the definition in half and
# silently drops whichever surface the loader resolves from the default. This
# installs the whole definition where every loader already looks, and does not
# set OMP_AGENT_DIR at all.
#
# This directory lives on the ephemeral container layer, never on /data, so
# rendered credentials do not persist. `sessions` is symlinked into /data.
AGENT_DIR="${HOME}/.omp/agent"
BUILD_DIR="${OMP_BUILD_DIR:-/app/build}"
MODELS_TMPL="${AGENT_SRC:-/agent}/models.yml.tmpl"
MODELS_OUT="${AGENT_DIR}/models.yml"

# Explicit /data mount paths shared by core and the selected adapter.
DATA_DIR="${OMP_DATA_DIR:-/data}"
SESSIONS_DIR="${DATA_DIR}/sessions"
WORKSPACE_DIR="${OMP_WORKSPACE_DIR:-${DATA_DIR}/workspace}"
ARTIFACTS_DIR="${DATA_DIR}/artifacts"
AGENT_SRC="${AGENT_SRC:-/agent}"
DURABLE_AGENT_DIR="${DATA_DIR}/agent"
DURABLE_WORKSPACE_DIR="${DURABLE_AGENT_DIR}/workspace"
DURABLE_OMP_DIR="${DURABLE_AGENT_DIR}/.omp"
export OMP_AGENT_ROOT="$DURABLE_AGENT_DIR"
export OMP_WORKSPACE_DIR="$WORKSPACE_DIR"

# Cron source is seeded into this durable tree once, then the agent owns
# edits/deletions there across container restarts.
CRON_DATA_DIR="${OMP_CRON_DATA_DIR:-${DATA_DIR}/cron}"
CRON_SCHEDULES_DIR="${OMP_CRON_SCHEDULES_DIR:-${CRON_DATA_DIR}/schedules}"
SOURCE_SCHEDULES_DIR="${OMP_CRON_SOURCE_DIR:-/schedules}"
export OMP_CRON_DATA_DIR="$CRON_DATA_DIR"
export OMP_CRON_SCHEDULES_DIR="$CRON_SCHEDULES_DIR"

# Child registry: the orphan sweep and the core server both read and
# write this JSON file to track live RPC child process groups. It
# lives on the durable /data volume so it survives restarts.
CHILD_REGISTRY="${OMP_CHILD_REGISTRY_PATH:-${DATA_DIR}/child-registry.json}"
export OMP_CHILD_REGISTRY_PATH="$CHILD_REGISTRY"

# Runtime entrypoints, overridable for development. Bun executes the
# TypeScript source directly.
ORPHAN_SWEEP="${OMP_ORPHAN_SWEEP:-/app/packages/core/src/orphan-sweep.ts}"
CORE_SERVER="${OMP_CORE_SERVER:-/app/packages/core/src/server.ts}"
HTTP_SERVER="${OMP_HTTP_SERVER:-/app/packages/http-adapter/src/server.ts}"
PUMBLE_SERVER="${OMP_PUMBLE_SERVER:-/app/packages/pumble-adapter/src/server.ts}"
CRON_SERVER="${OMP_CRON_SERVER:-/app/packages/core/src/cron-scheduler.ts}"

# Ambient ingest extension loaded by the core server at runtime.
AMBIENT_EXTENSION="${OMP_AMBIENT_EXTENSION:-/app/packages/core/src/ambient-ingest-extension.ts}"

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() {
	printf '[entrypoint] error: %s\n' "$*" >&2
	exit 1
}

# -- 0. validate the staged agent --------------------------------------
# The image must contain exactly one explicit identity and definition tree.
# Validate every source path before touching the durable agent directory.
if [ -L "$AGENT_SRC" ]; then
	die "${AGENT_SRC} must not be a symlink"
fi
if [ ! -d "$AGENT_SRC" ]; then
	die "${AGENT_SRC} must be a directory"
fi

AGENT_ID_PATH="${AGENT_SRC}/id"
if [ -L "$AGENT_ID_PATH" ]; then
	die "${AGENT_ID_PATH} must not be a symlink"
fi
if [ ! -f "$AGENT_ID_PATH" ]; then
	die "${AGENT_ID_PATH} must be a regular file"
fi
OMP_AGENT_ID="$(<"$AGENT_ID_PATH")"
if [[ ! "$OMP_AGENT_ID" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
	die "${AGENT_ID_PATH} must contain an agent id matching ^[a-z0-9][a-z0-9_-]{0,63}$"
fi
export OMP_AGENT_ID

SOURCE_OMP_DIR="${AGENT_SRC}/.omp"
if [ -L "$SOURCE_OMP_DIR" ]; then
	die "${SOURCE_OMP_DIR} must not be a symlink"
fi
if [ ! -d "$SOURCE_OMP_DIR" ]; then
	die "${SOURCE_OMP_DIR} must be a directory"
fi
for _required in AGENTS.md config.yml; do
	_required_path="${SOURCE_OMP_DIR}/${_required}"
	if [ -L "$_required_path" ]; then
		die "${_required_path} must not be a symlink"
	fi
	if [ ! -f "$_required_path" ]; then
		die "${_required_path} must be a regular file"
	fi
done

# -- 0b. materialize env-to-file secrets -------------------------------
FILES_MANIFEST="${AGENT_SRC}/files.json"
if [ -f "$FILES_MANIFEST" ]; then
	# shellcheck disable=SC2016
	FILES_MANIFEST="$FILES_MANIFEST" bun -e '
    import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
    import { dirname } from "node:path";

    const manifestPath = process.env.FILES_MANIFEST;
    const fail = (message) => {
      console.error(`[entrypoint] error: ${message}`);
      process.exit(1);
    };
    let entries;
    try {
      entries = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      fail(`cannot read env-to-file manifest ${manifestPath}`);
    }
    if (!Array.isArray(entries)) fail(`${manifestPath} must contain an array`);
    for (const [index, entry] of entries.entries()) {
      const field = `files[${index}]`;
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        fail(`${field} must be an object`);
      }
      const env = entry.env;
      const path = entry.path;
      const mode = entry.mode === undefined ? "0600" : entry.mode;
      if (typeof env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) {
        fail(`${field}.env must be a valid environment variable name`);
      }
      if (
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path === "/data" ||
        path.startsWith("/data/") ||
        path === "/agent" ||
        path.startsWith("/agent/") ||
        path === "/app" ||
        path.startsWith("/app/")
      ) {
        fail(`${field}.path must be an absolute path outside /data, /agent, and /app`);
      }
      if (typeof mode !== "string" || !/^0?[0-7]{3,4}$/.test(mode)) {
        fail(`${field}.mode must be an octal mode with 3 or 4 digits`);
      }
      const value = process.env[env];
      if (value === undefined || value.length === 0) {
        fail(`${env} is required for ${field} and must be non-empty`);
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, Buffer.from(value, "base64"));
      await chmod(path, Number.parseInt(mode, 8));
    }
  '
else
	log "no env-to-file manifest found; skipping materialization"
fi



# The durable root, refreshed definition, and persistent workspace are
# operator state. Never follow symlinks while preparing them.
if [ -L "$DURABLE_AGENT_DIR" ]; then
	die "${DURABLE_AGENT_DIR} must not be a symlink"
fi
if [ -e "$DURABLE_AGENT_DIR" ] && [ ! -d "$DURABLE_AGENT_DIR" ]; then
	die "${DURABLE_AGENT_DIR} must be a directory"
fi
if [ -L "$DURABLE_OMP_DIR" ]; then
	die "${DURABLE_OMP_DIR} must not be a symlink"
fi
if [ -e "$DURABLE_OMP_DIR" ] && [ ! -d "$DURABLE_OMP_DIR" ]; then
	die "${DURABLE_OMP_DIR} must be a directory"
fi
if [ -L "$DURABLE_WORKSPACE_DIR" ]; then
	die "${DURABLE_WORKSPACE_DIR} must not be a symlink"
fi
if [ -e "$DURABLE_WORKSPACE_DIR" ] && [ ! -d "$DURABLE_WORKSPACE_DIR" ]; then
	die "${DURABLE_WORKSPACE_DIR} must be a directory"
fi

# Keep legacy unbound cwd behavior while creating the bound workspace once.
mkdir -p \
	"$SESSIONS_DIR" \
	"$WORKSPACE_DIR" \
	"$ARTIFACTS_DIR" \
	"$DURABLE_AGENT_DIR" \
	"$DURABLE_WORKSPACE_DIR"

# Cron schedules and run history share the durable /data volume. Seed the
# mutable schedule tree once; later boots preserve agent edits and deletions.
if [ -L "$CRON_DATA_DIR" ]; then
	die "${CRON_DATA_DIR} must not be a symlink"
fi
if [ -e "$CRON_DATA_DIR" ] && [ ! -d "$CRON_DATA_DIR" ]; then
	die "${CRON_DATA_DIR} must be a directory"
fi
if [ -L "$CRON_SCHEDULES_DIR" ]; then
	die "${CRON_SCHEDULES_DIR} must not be a symlink"
fi
if [ -e "$CRON_SCHEDULES_DIR" ] && [ ! -d "$CRON_SCHEDULES_DIR" ]; then
	die "${CRON_SCHEDULES_DIR} must be a directory"
fi
mkdir -p "$CRON_DATA_DIR" "$CRON_SCHEDULES_DIR"
CRON_SEED_MARKER="${CRON_SCHEDULES_DIR}/.omp-bundler-seeded"
if [ -L "$CRON_SEED_MARKER" ]; then
	die "${CRON_SEED_MARKER} must not be a symlink"
fi
if [ ! -e "$CRON_SEED_MARKER" ]; then
	if [ -L "$SOURCE_SCHEDULES_DIR" ]; then
		die "${SOURCE_SCHEDULES_DIR} must not be a symlink"
	fi
	if [ -d "$SOURCE_SCHEDULES_DIR" ] && [ "$SOURCE_SCHEDULES_DIR" != "$CRON_SCHEDULES_DIR" ]; then
		for _schedule in "$SOURCE_SCHEDULES_DIR"/*; do
			[ -e "$_schedule" ] || continue
			if [ -L "$_schedule" ]; then
				die "${_schedule} must not be a symlink"
			fi
			_schedule_name="${_schedule##*/}"
			_schedule_target="${CRON_SCHEDULES_DIR}/${_schedule_name}"
			if [ -e "$_schedule_target" ] || [ -L "$_schedule_target" ]; then
				continue
			fi
			cp -R "$_schedule" "$_schedule_target" ||
				die "failed to seed ${_schedule}"
		done
	fi
	touch "$CRON_SCHEDULES_DIR/.omp-bundler-seeded"
fi

# Make cron state available to every OMP session through its native additional
# workspace-root flag; the scheduler and adapter sessions share these args.
OMP_ARGS="${OMP_ARGS:+${OMP_ARGS} }--add-dir ${CRON_DATA_DIR}"
export OMP_ARGS

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

# -- 1. refresh the durable agent definition ---------------------------
# Stage the image-owned tree beside the destination, then swap it into place.
# Only /data/agent/.omp is refreshed; /data/agent/workspace and every other
# durable path are preserved.
_omp_stage="${DURABLE_AGENT_DIR}/.omp.stage.$$"
_omp_backup="${DURABLE_AGENT_DIR}/.omp.backup.$$"
if [ -e "$_omp_stage" ] || [ -L "$_omp_stage" ]; then
	die "${_omp_stage} already exists"
fi
if [ -e "$_omp_backup" ] || [ -L "$_omp_backup" ]; then
	die "${_omp_backup} already exists"
fi
if ! cp -R "$SOURCE_OMP_DIR" "$_omp_stage"; then
	rm -rf "$_omp_stage"
	die "failed to stage ${SOURCE_OMP_DIR}"
fi

_had_previous_omp=0
if [ -e "$DURABLE_OMP_DIR" ]; then
	mv "$DURABLE_OMP_DIR" "$_omp_backup"
	_had_previous_omp=1
fi
if ! mv "$_omp_stage" "$DURABLE_OMP_DIR"; then
	rm -rf "$_omp_stage"
	if [ "$_had_previous_omp" -eq 1 ]; then
		mv "$_omp_backup" "$DURABLE_OMP_DIR" ||
			die "failed to restore ${DURABLE_OMP_DIR} after refresh failure"
	fi
	die "failed to refresh ${DURABLE_OMP_DIR}"
fi
if [ "$_had_previous_omp" -eq 1 ]; then
	rm -rf "$_omp_backup"
fi
log "refreshed agent ${OMP_AGENT_ID}"

# Install the refreshed definition at OMP's default agent directory. This is
# the whole definition in one place: instructions, config, skills, commands,
# tools, extensions, and task agents. Every OMP loader resolves from here,
# whether or not it honors OMP_AGENT_DIR.
if [ -L "$AGENT_DIR" ]; then
	die "${AGENT_DIR} must not be a symlink"
fi
rm -rf "$AGENT_DIR"
mkdir -p "$(dirname "$AGENT_DIR")"
if ! cp -R "$DURABLE_OMP_DIR" "$AGENT_DIR"; then
	rm -rf "$AGENT_DIR"
	die "failed to install the agent definition at ${AGENT_DIR}"
fi
link_into_data "${AGENT_DIR}/sessions" "$SESSIONS_DIR"
log "installed agent definition at ${AGENT_DIR}"

# -- 2. render models --------------------------------------------------
# bun build/render-models.ts expands runtime placeholders, omits providers
# with no configured placeholders, and fails on partial or malformed values.
log "rendering models.yml from ${MODELS_TMPL}"
bun "$BUILD_DIR/render-models.ts" \
	--input "$MODELS_TMPL" \
	--output "$MODELS_OUT"
# The rendered catalog holds real credentials, so it lands on the ephemeral
# container layer and is re-created from runtime env on every boot.
chmod 0600 "$MODELS_OUT"
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

# -- 3. configure the bundled adapter ---------------------------------
# Select one bundled adapter process and synthesize one registration for the
# staged agent. Callers may still provide OMP_ADAPTERS directly.
ADAPTER_MODE="${OMP_BUNDLER_ADAPTER:-http}"
case "$ADAPTER_MODE" in
http)
	ADAPTER_SERVER="$HTTP_SERVER"
	ADAPTER_LABEL="http"
	if [ "${OMP_ADAPTERS+x}" = x ]; then
		[ -n "$OMP_ADAPTERS" ] || die "OMP_ADAPTERS must not be empty when explicitly set"
	else
		# shellcheck disable=SC2016
		OMP_ADAPTERS="$(
			bun -e '
        import { randomBytes } from "node:crypto";
        const agentId = process.env.OMP_AGENT_ID;
        const port = process.env.OMP_HTTP_PORT?.trim() || "8765";
        const secret =
          process.env.OMP_HTTP_CORE_SHARED_SECRET ||
          randomBytes(32).toString("hex");
        process.stdout.write(JSON.stringify([{
          adapterId: `http-${agentId}`,
          callbackUrl: `http://127.0.0.1:${port}/core/events/${encodeURIComponent(agentId)}`,
          sharedSecret: secret,
          agentId,
        }]));
      '
		)"
		export OMP_ADAPTERS
		log "configured bundled HTTP adapter registration for ${OMP_AGENT_ID}"
	fi
	;;
pumble)
	ADAPTER_SERVER="$PUMBLE_SERVER"
	ADAPTER_LABEL="pumble"
	if [ "${OMP_ADAPTERS+x}" = x ]; then
		[ -n "$OMP_ADAPTERS" ] || die "OMP_ADAPTERS must not be empty when explicitly set"
		if ! bun -e '
      let entries;
      try {
        entries = JSON.parse(process.env.OMP_ADAPTERS);
      } catch {
        process.exit(1);
      }
      const expected = process.env.PUMBLE_ADAPTER_ID?.trim() || "pumble";
      if (!Array.isArray(entries) || entries.length !== 1 || entries[0]?.adapterId !== expected) {
        process.exit(1);
      }
    '; then
			die "Pumble OMP_ADAPTERS must contain one registration whose adapterId matches PUMBLE_ADAPTER_ID"
		fi
	else
		[ -n "${PUMBLE_CORE_SHARED_SECRET:-}" ] || die "PUMBLE_CORE_SHARED_SECRET is required"
		# shellcheck disable=SC2016
		OMP_ADAPTERS="$(
			bun -e '
        const adapterId = process.env.PUMBLE_ADAPTER_ID?.trim() || "pumble";
        const agentId = process.env.OMP_AGENT_ID;
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
		log "configured bundled Pumble adapter registration for ${OMP_AGENT_ID}"
	fi
	;;
*)
	die "OMP_BUNDLER_ADAPTER must be http or pumble (got ${ADAPTER_MODE})"
	;;
esac

# -- 4. cron scheduler -------------------------------------------------
# Keep the scheduler alive even when the directory starts empty so an agent
# can create its first schedule without a container restart.
CRON_ENABLED=""
if [ "${OMP_CRON_ENABLED+x}" = x ]; then
	case "${OMP_CRON_ENABLED,,}" in
	true|1|yes|on)
		CRON_ENABLED=1
		;;
	*)
		CRON_ENABLED=0
		log "cron disabled (OMP_CRON_ENABLED=${OMP_CRON_ENABLED})"
		;;
	esac
else
	CRON_ENABLED=1
	log "cron enabled with durable schedules at ${CRON_SCHEDULES_DIR}"
fi

# -- 4. orphan sweep ---------------------------------------------------
# The orphan sweep is a core module. It MUST run once; we do not
# silently skip it. If the executable is absent or fails, the
# container refuses to start; sweep failures are never hidden. The
# core server will also sweep before it listens, but running it here
# guarantees no orphaned RPC children survive into the new container.
[ -f "$ORPHAN_SWEEP" ] || die "orphan sweep not found at ${ORPHAN_SWEEP}"
log "running orphan sweep: ${ORPHAN_SWEEP}"
bun "$ORPHAN_SWEEP"
log "orphan sweep complete"

# -- 5. start core + selected adapter (+ optional cron) under supervision -
# This shell remains PID 1, forwards signals, and tears down every
# supervised sibling when any service exits.

[ -f "$CORE_SERVER" ] || die "core server not found at ${CORE_SERVER}"
[ -f "$ADAPTER_SERVER" ] || die "${ADAPTER_LABEL} adapter server not found at ${ADAPTER_SERVER}"
[ -f "$AMBIENT_EXTENSION" ] || die "ambient ingest extension not found at ${AMBIENT_EXTENSION}"

CORE_PID=""
ADAPTER_PID=""
CRON_PID=""
EXIT_CODE=0
TEARING_DOWN=0

forward_signal() {
	local sig="$1"
	if [ -n "$ADAPTER_PID" ] && kill -0 "$ADAPTER_PID" 2>/dev/null; then
		kill -"$sig" "$ADAPTER_PID" 2>/dev/null || true
	fi
	if [ -n "$CORE_PID" ] && kill -0 "$CORE_PID" 2>/dev/null; then
		kill -"$sig" "$CORE_PID" 2>/dev/null || true
	fi
	if [ -n "$CRON_PID" ] && kill -0 "$CRON_PID" 2>/dev/null; then
		kill -"$sig" "$CRON_PID" 2>/dev/null || true
	fi
}

trap 'TEARING_DOWN=1; forward_signal TERM' TERM
trap 'TEARING_DOWN=1; forward_signal INT' INT

log "starting core server: ${CORE_SERVER}"
bun "$CORE_SERVER" &
CORE_PID=$!

log "starting ${ADAPTER_LABEL} adapter: ${ADAPTER_SERVER}"
bun "$ADAPTER_SERVER" &
ADAPTER_PID=$!

if [ "$CRON_ENABLED" = 1 ] && [ -f "$CRON_SERVER" ]; then
	log "starting cron scheduler: ${CRON_SERVER}"
	bun "$CRON_SERVER" &
	CRON_PID=$!
elif [ "$CRON_ENABLED" = 1 ]; then
	log "cron scheduler not found; skipping: ${CRON_SERVER}"
fi

if [ -n "$CRON_PID" ]; then
	log "core pid=${CORE_PID}, ${ADAPTER_LABEL} pid=${ADAPTER_PID}, cron pid=${CRON_PID}"
else
	log "core pid=${CORE_PID}, ${ADAPTER_LABEL} pid=${ADAPTER_PID}"
fi

set +e
wait -n
FIRST_EXIT=$?
set -e

if [ "$TEARING_DOWN" -eq 1 ]; then
	EXIT_CODE="$FIRST_EXIT"
else
	log "child exited (status ${FIRST_EXIT}); tearing down sibling"
	EXIT_CODE="$FIRST_EXIT"
	forward_signal TERM
fi

for _ in {1..50}; do
	CORE_ALIVE=0
	ADAPTER_ALIVE=0
	CRON_ALIVE=0
	if [ -n "$CORE_PID" ] && kill -0 "$CORE_PID" 2>/dev/null; then
		CORE_ALIVE=1
	fi
	if [ -n "$ADAPTER_PID" ] && kill -0 "$ADAPTER_PID" 2>/dev/null; then
		ADAPTER_ALIVE=1
	fi
	if [ -n "$CRON_PID" ] && kill -0 "$CRON_PID" 2>/dev/null; then
		CRON_ALIVE=1
	fi
	if [ "$CORE_ALIVE" -eq 0 ] &&
		[ "$ADAPTER_ALIVE" -eq 0 ] &&
		[ "$CRON_ALIVE" -eq 0 ]; then
		break
	fi
	sleep 0.1
done
if [ -n "$CORE_PID" ] && kill -0 "$CORE_PID" 2>/dev/null; then
	log "core did not exit; sending SIGKILL"
	kill -9 "$CORE_PID" 2>/dev/null || true
	wait "$CORE_PID" 2>/dev/null || true
fi
if [ -n "$ADAPTER_PID" ] && kill -0 "$ADAPTER_PID" 2>/dev/null; then
	log "${ADAPTER_LABEL} adapter did not exit; sending SIGKILL"
	kill -9 "$ADAPTER_PID" 2>/dev/null || true
	wait "$ADAPTER_PID" 2>/dev/null || true
fi
if [ -n "$CRON_PID" ] && kill -0 "$CRON_PID" 2>/dev/null; then
	log "cron scheduler did not exit; sending SIGKILL"
	kill -9 "$CRON_PID" 2>/dev/null || true
	wait "$CRON_PID" 2>/dev/null || true
fi

log "supervisor exiting (status ${EXIT_CODE})"
exit "$EXIT_CODE"
