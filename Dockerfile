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

# Copy the renderer, core runtime, and entrypoint. node_modules and
# secrets are excluded by .dockerignore; Bun executes the TypeScript
# source directly.
COPY build/            ./build/
COPY packages/core/    ./packages/core/
COPY entrypoint/       ./entrypoint/

# Install the agent folder at $HOME/.omp/agent, OMP's default agent
# directory. NOT OMP_AGENT_DIR: OMP 17.1.3 does not apply that
# var consistently to task-agent discovery, so we use the default
# location to keep every discovery surface on one root.
COPY template/         "${HOME}/.omp/agent/"

# ── /data mount ──────────────────────────────────────────────────────
# A single shared volume covers sessions, workspace, and artifacts.
# OMP's default agent dir is $HOME/.omp/agent; session data lives at
# $HOME/.omp/agent/sessions and artifacts at .../artifacts. To keep
# these on the durable volume instead of the ephemeral layer:
#   - PI_ARTIFACTS_DIR relocates artifacts to /data/artifacts (real
#     OMP env var).
#   - The entrypoint symlinks sessions -> /data/sessions (no dedicated
#     OMP env var relocates session data).
#   - /data/workspace is the shared agent cwd, also where the pumble
#     adapter writes attachments (/data/workspace/pumble-files).
ENV OMP_DATA_DIR=/data
ENV OMP_SESSIONS_DIR=/data/sessions
ENV OMP_WORKSPACE_DIR=/data/workspace
ENV OMP_ARTIFACTS_DIR=/data/artifacts
ENV PI_ARTIFACTS_DIR=/data/artifacts
VOLUME ["/data"]

# ── seven required render env vars ───────────────────────────────────
# The models.yml.tmpl renderer fails loudly if any of these are
# missing or empty at container start. They are provider credentials
# and base URLs; supply real values via runtime env/secrets.
#   CLIPROXY_BASE_URL    cliproxyapi provider base URL
#   CLIPROXY_API_KEY     cliproxyapi provider API key
#   custom-provider_BASE_URL     custom-provider provider base URL
#   custom-provider_API_KEY      custom-provider provider API key
#   OLLAMA_CLOUD_API_KEY ollama-cloud provider API key
#   OPENCODE_GO_API_KEY  opencode-go provider API key
#   SYNTHETIC_API_KEY    synthetic provider API key

# ── entrypoint ───────────────────────────────────────────────────────
# Boot order: render models, orphan sweep (fail if absent/fails),
# then exec the core supervisor as PID 1.
RUN chmod +x /app/entrypoint/entrypoint.sh
ENTRYPOINT ["/app/entrypoint/entrypoint.sh"]
CMD []