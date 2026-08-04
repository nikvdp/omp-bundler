# ── base ─────────────────────────────────────────────────────────────
# OMP (@oh-my-pi/pi-coding-agent) requires bun >= 1.3.14; the
# published dist/cli.js is a bun-built bundle. Using the official
# Debian-based image for glibc compatibility with native deps
# (mupdf, puppeteer-core's browsers, etc.).
FROM oven/bun:1.3.14-debian AS base

# Explicit HOME so ${HOME} expands in COPY below and the entrypoint
# installs the agent folder at the default OMP location, /root/.omp/agent.
ENV HOME=/root

# ── OMP install ──────────────────────────────────────────────────────
# OMP is installed into the image, not copied from the host. Pin to
# 17.1.3; npm's --global install places the `omp` bin on PATH.
RUN bun add --global @oh-my-pi/pi-coding-agent@17.1.3

# ── runtime layout ───────────────────────────────────────────────────
WORKDIR /app

# Copy all four staged package trees: contracts (shared types and
# schemas), core (inbound HTTP server on port 8787), http-adapter
# (default agent-like agent HTTP API on port 8765), and pumble-adapter
# (optional Pumble webhook/callback service on port 8765).
# node_modules and secrets are excluded by .dockerignore; Bun executes
# the TypeScript source directly.
COPY packages/contracts/       ./packages/contracts/
COPY packages/core/            ./packages/core/
COPY packages/http-adapter/     ./packages/http-adapter/
COPY packages/pumble-adapter/   ./packages/pumble-adapter/

# Copy the build renderer and the entrypoint supervisor.
COPY build/            ./build/
COPY entrypoint/       ./entrypoint/

# Install the agent folder at $HOME/.omp/agent, OMP's default agent
# directory. NOT OMP_AGENT_DIR: OMP 17.1.3 does not apply that
# var consistently to task-agent discovery, so we use the default
# location to keep every discovery surface on one root.
COPY template/         "${HOME}/.omp/agent/"

# Bake the single staged agent definition. The image-side source is
# immutable; the entrypoint refreshes only its .omp tree onto the durable
# volume and leaves the persistent workspace untouched.
COPY agent/id       /agent/id
COPY agent/.omp/    /agent/.omp/

# ── production dependency install ─────────────────────────────────────
# Install production dependencies for each package from its lock file.
# file:../contracts resolves locally within the staged tree; no
# network fetch of the contracts package is needed. Only production
# deps are installed (devDependencies for types/build tooling are
# skipped). No build-time secrets, ARGs, or ENV literals are passed:
# all provider credentials resolve at container start from runtime env.
RUN cd packages/contracts && bun install --frozen-lockfile --production \
 && cd /app/packages/core && bun install --frozen-lockfile --production \
 && cd /app/packages/http-adapter && bun install --frozen-lockfile --production \
 && cd /app/packages/pumble-adapter && bun install --frozen-lockfile --production

# ── /data mount ──────────────────────────────────────────────────────
# A single shared volume covers sessions, the legacy unbound workspace,
# the bound agent workspace, artifacts, and adapter-specific persistent state.
# OMP's default agent dir is $HOME/.omp/agent; session data lives at
# $HOME/.omp/agent/sessions and artifacts at .../artifacts. To keep
# these on the durable volume instead of the ephemeral layer:
#   - PI_ARTIFACTS_DIR relocates artifacts to /data/artifacts (real
#     OMP env var).
#   - The entrypoint symlinks sessions -> /data/sessions (no dedicated
#     OMP env var relocates session data).
#   - /data/workspace remains the cwd for explicitly unbound adapters.
#   - /data/agent/workspace is the sole bound agent cwd.
ENV OMP_DATA_DIR=/data
ENV OMP_SESSIONS_DIR=/data/sessions
ENV OMP_WORKSPACE_DIR=/data/workspace
ENV OMP_ARTIFACTS_DIR=/data/artifacts
ENV PI_ARTIFACTS_DIR=/data/artifacts
ENV OMP_AGENT_ROOT=/data/agent

# Core runtime invariants. Paths and internal service addresses belong to
# this image; credentials and adapter registrations remain runtime inputs.
ENV OMP_HOST=0.0.0.0
ENV OMP_PORT=8787
ENV OMP_SESSION_DB_PATH=/data/core/session-registry.sqlite
ENV OMP_IDEMPOTENCY_DB_PATH=/data/core/idempotency.sqlite
ENV OMP_OUTBOX_DB_PATH=/data/core/outbound.sqlite
ENV OMP_MAX_CHILDREN=8
ENV OMP_IDLE_TIMEOUT_MS=900000
ENV OMP_ENGAGEMENT_WINDOW_MS=300000
ENV OMP_CALLBACK_TIMEOUT_MS=15000
ENV OMP_PROGRESS_THRESHOLD_MS=500
ENV OMP_RETRY_DELAYS_MS=250,1000,5000

# The two supervised services communicate over loopback by default.
ENV PUMBLE_BRIDGE_HOST=0.0.0.0
ENV PUMBLE_BRIDGE_PORT=8765
ENV PUMBLE_CORE_URL=http://127.0.0.1:8787

# Bundled adapter mode. HTTP is the credential-free default; switch to
# pumble to run the Pumble bridge instead. Both use external port 8765.
ENV OMP_BUNDLER_ADAPTER=http
ENV OMP_HTTP_HOST=0.0.0.0
ENV OMP_HTTP_PORT=8765
ENV OMP_HTTP_CORE_URL=http://127.0.0.1:8787
VOLUME ["/data"]

# ── exposed ports ─────────────────────────────────────────────────────
# Core's internal adapter protocol listens on 8787. The selected public
# adapter listens on 8765 (HTTP agent API by default, Pumble when selected).
EXPOSE 8787
EXPOSE 8765

# ── model provider runtime config ─────────────────────────────────────
# Provider definitions with runtime placeholders are optional. Without the
# broker, set every placeholder for the provider(s) used by the deployment;
# providers with none configured are omitted and partially configured
# providers fail at startup. With the broker pair, apiKey fields are removed
# first, so fixed-base providers remain available without provider keys.
# Custom providers still need their base URL at runtime.
#   CLIPROXY_BASE_URL    optional cliproxyapi provider base URL
#   custom-provider_BASE_URL     optional custom-provider provider base URL
#   CLIPROXY_API_KEY     cliproxyapi key without a broker
#   custom-provider_API_KEY      custom-provider key without a broker
#   OLLAMA_CLOUD_API_KEY ollama-cloud key without a broker
#   OPENCODE_GO_API_KEY  opencode-go key without a broker
#   SYNTHETIC_API_KEY    synthetic key without a broker

# ── bundled adapter runtime config ───────────────────────────────────
# OMP_BUNDLER_ADAPTER   selected bundled adapter: http (default) or pumble
# OMP_HTTP_API_TOKEN    optional Bearer token for the public HTTP API
# OMP_HTTP_TURN_TIMEOUT_MS optional synchronous turn timeout
#
# PUMBLE_CORE_URL        core base URL for posting inbound messages
# PUMBLE_ADAPTER_ID  adapter id (schema default: pumble)
# OMP_AGENT_ID       is read from the baked /agent/id file
# PUMBLE_CORE_SHARED_SECRET  shared secret for inbound auth + outbound HMAC
# PUMBLE_PUBLIC_BASE_URL public base URL for attachment links
# PUMBLE_CORE_CALLBACK_URL optional core-to-adapter callback override
#
# OMP_ADAPTERS is caller-owned and may override the registration synthesized
# for the selected bundled adapter.

# ── child registry ──────────────────────────────────────────────────
# The orphan sweep and core server share a JSON registry of live RPC
# child process groups on the durable volume. The entrypoint exports
# this before running the sweep.
ENV OMP_CHILD_REGISTRY_PATH=/data/child-registry.json

# ── entrypoint ───────────────────────────────────────────────────────
# Boot order: render models, configure the selected bundled adapter,
# orphan sweep, then supervise core + adapter.
RUN chmod +x /app/entrypoint/entrypoint.sh
ENTRYPOINT ["/app/entrypoint/entrypoint.sh"]
CMD []
