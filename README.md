# omp-bundler

Build and run one filesystem-configured OMP agent as a durable service.

Each bundle is one deployment and one routable agent. The bundle root is the
agent source: `AGENTS.md`, `config.yml`, `models.yml`, `Dockerfile`, and optional
component directories. There is no agent collection or repeated agent ID on
component commands.

`omp-bundler` creates the bundle, generates components, manages its native OMP
model catalog, validates source and runtime configuration, builds the owned
Dockerfile, and runs the image as a background service or foreground process.

## Install

```bash
npm install --global @omp-bundler/cli
omp-bundler --version
```

Docker is required for `build`, `run`, and lifecycle commands. Model and adapter
credentials are needed only when checking or starting a runtime environment.

## Quick start

Create a bundle. The directory basename becomes the stable agent ID unless
`--id` is supplied:

```bash
omp-bundler new meetings-agent
cd meetings-agent
```

Edit the generated instructions, add an explicit model connection, and select
it as the agent default:

```bash
$EDITOR AGENTS.md
omp-bundler model add openai/gpt-4o-mini \
  --base-url https://api.openai.com/v1 \
  --api openai-completions \
  --api-key-env OPENAI_API_KEY
omp-bundler model set-default openai/gpt-4o-mini
```

`model add` writes the bundle-root `models.yml` catalog and adds
`OPENAI_API_KEY=` to `runtime.env.example`. Copy that example to the ignored
`runtime.env` and fill the key:

```bash
cp runtime.env.example runtime.env
$EDITOR runtime.env
```

Validate, build, and start the background service:

```bash
omp-bundler check
omp-bundler build
omp-bundler run
```

From the bundle root, `run` prints the selected HTTP endpoint and the matching
TUI command:

```text
Agent endpoint (available once listening; not a readiness check): http://localhost:8765/v1/agents/meetings-agent
TUI: omp-bundler tui
```

Use the printed URL when the preferred port is busy. Chat through the
installed CLI:

```bash
omp-bundler tui
```

Or send a synchronous HTTP turn:

```bash
curl -X POST \
  http://localhost:8765/v1/agents/meetings-agent/conversations/local/messages \
  -H 'content-type: application/json' \
  -d '{"message":"What can you help me with?"}'
```

The development loop is:

```text
new -> edit -> model add -> model set-default -> runtime.env -> check -> build -> run
```

## Model setup

Each bundle has one native OMP model catalog at the bundle root:
`models.yml`. A new bundle starts with `providers: {}`, so add at least one
model and select it before deployment.

The direct-flag path makes the connection explicit. The selector is always
`provider/model`; the provider ID is only the key used by OMP's native catalog,
not a separate service:

```bash
omp-bundler model add openai/gpt-4o-mini \
  --base-url https://api.openai.com/v1 \
  --api openai-completions \
  --api-key-env OPENAI_API_KEY
omp-bundler model set-default openai/gpt-4o-mini
omp-bundler model list
```

`--api` accepts `openai-responses`, `openai-completions`, or
`anthropic-messages`. Use `--no-auth` instead of `--api-key-env` only for a
local endpoint that truly requires no credential. `model add` is additive and
does not change the default; `model set-default` changes only
`config.yml`'s `modelRoles.default`, which must name a model in `models.yml`.

The command-generated catalog is ordinary YAML and remains hand-editable:

```yaml
providers:
  openai:
    baseUrl: https://api.openai.com/v1
    api: openai-completions
    apiKey: "${OPENAI_API_KEY}"
    models:
      - id: gpt-4o-mini
        name: gpt-4o-mini
```

Literal URLs, dialects, model IDs, and display names are valid. Keep API keys
as `${ENV_VAR}` templates; this lets the same image run in different
environments without putting a secret in the catalog. Add every referenced
variable to `runtime.env.example` (the `model add --api-key-env` path does this
automatically), then set its literal value only in the ignored `runtime.env`.
For example:

```env
# Model provider credentials. Copy this file to runtime.env and fill these values.
OPENAI_API_KEY=
```

You may template a non-secret field too, for example
`baseUrl: "${OPENAI_BASE_URL}"`; put `OPENAI_BASE_URL=` in
`runtime.env.example` as well. Environment templating is preferred for
containers, while literal non-secret catalog values remain supported.

`model list` marks the selected model with `*`. The optional
`--from omp` form imports a selector from the installed OMP configuration; use
the explicit flags above when setting up a connection from scratch.

## Runtime configuration

`new` creates the compact, committed `runtime.env.example`. Copy it to the
ignored `runtime.env` before `run` or `start`; `.gitignore` already excludes
that file. `check`, `run`, `start`, and `restart` discover the bundle-root
`runtime.env` by default. Pass `--env-file <path>` to use another file.
`check` can validate source without a runtime file, but `run` and `start` need
one unless `--env-file` supplies it. `build` does not read runtime secrets.

### Environment-to-file secrets

Bundles can materialize a runtime environment variable into a file before the
agent starts. Declare each file in `omp-bundler.yml`:

```yaml
files:
  - env: GITHUB_SSH_KEY
    path: /root/.ssh/id_ed25519
    mode: "0600"
```

Set `GITHUB_SSH_KEY` in `runtime.env` to the base64-encoded file content (for
example, `base64 < id_ed25519`). The default mode is `0600`. Destinations must
not be under `/data`: materialized files live in the ephemeral container layer
and are re-created from `runtime.env` on every boot. `omp-bundler check` lists
each declared environment variable alongside the other required credential
names.

### Runtime adapters

New bundles default to the built-in HTTP adapter:

```env
# Bundled adapter. HTTP serves the agent API and built-in terminal chat.
OMP_BUNDLER_ADAPTER=http

# Optional Bearer token for the public HTTP endpoint. Leave empty only on trusted localhost.
OMP_HTTP_API_TOKEN=
```

Set `OMP_HTTP_API_TOKEN`, or place the adapter behind an authenticated local
reverse proxy, before exposing port 8765 outside trusted localhost.
Pumble is opt-in: keep the default HTTP adapter unless this bundle will receive
Pumble events. Generate its fields only for that deployment:

```bash
omp-bundler generate adapter pumble
```

This updates `runtime.env.example` with:

```env
OMP_BUNDLER_ADAPTER=pumble

PUMBLE_APP_ID=
PUMBLE_APP_CLIENT_SECRET=
PUMBLE_APP_KEY=
PUMBLE_APP_SIGNING_SECRET=
PUMBLE_PUBLIC_BASE_URL=
PUMBLE_CORE_SHARED_SECRET=
```

The bundle's `agent.id` is registered automatically. There is no
`PUMBLE_AGENT_ID` field. Repeating the generator is an idempotent no-op and
unrelated model blocks remain unchanged.

Advanced deployments may provide `OMP_ADAPTERS` directly as one unquoted JSON
array on one `runtime.env` line. It must contain exactly one registration:

```env
OMP_ADAPTERS=[{"adapterId":"http-meetings-agent","callbackUrl":"http://127.0.0.1:8765/core/events/meetings-agent","sharedSecret":"replace-me","agentId":"meetings-agent"}]
```

The registration's `agentId` must equal `agent.id`; missing, extra, or unbound
registrations are rejected before startup.

## Build and run

### Validate

From the bundle:

```bash
omp-bundler check
```

Or validate another bundle and runtime file:

```bash
omp-bundler check ../meetings-agent \
  --env-file ../meetings-agent/runtime.env
```

If `runtime.env` exists, `check` selects it automatically. Without it, `check`
performs source-only validation.

Validation covers:

- `omp-bundler.yml` and its singular `agent.id`
- required root `AGENTS.md`, `config.yml`, and owned `Dockerfile`
- active component files and OMP frontmatter
- TypeScript extension and tool entrypoints
- native `models.yml` providers and the selected `modelRoles.default`
- required runtime placeholders without exposing their values
- accidental credentials, runtime state, and symlinks in agent source
- Pumble or explicit adapter bindings against the bundle agent ID

A failed check names the path, field, and correction.

### Build

```bash
omp-bundler build
omp-bundler build ../meetings-agent
omp-bundler build --tag registry.example.com/meetings-agent:2026-08-04
```

`build`:

1. Runs source, model, and credential-leak validation.
2. Stages the shared runtime plus the bundle's exact `Dockerfile`.
3. Writes the stable ID to the image as `/agent/id`.
4. Maps root agent source to `/agent/.omp/`, including
   `subagents/` as `.omp/agents/`.
5. Copies the validated native model catalog and selected default binding.
6. Builds the configured Docker image.

Building does not contact a model provider or adapter and does not read
`runtime.env`. Environment templates remain unresolved until container start.

### Run and lifecycle

Copy and fill the local runtime file before running:

```bash
cp runtime.env.example runtime.env
$EDITOR runtime.env
```

Start the named background service:

```bash
omp-bundler start
omp-bundler status
omp-bundler logs --follow
```

`start` validates `runtime.env`, resolves busy host ports, starts the
deterministic `<dataVolume>-service` container, and prints the selected endpoint.

For a successful background start, the CLI prints:

```text
Agent endpoint (available once listening; not a readiness check): http://localhost:<selected-adapter-port>/v1/agents/<agent-id>
TUI: omp-bundler tui
```

Use those printed values rather than assuming the preferred port is free.
`run` is the same background start path plus `--foreground` mode. Repeating
either command while the owned service is running reports its existing endpoint.

Use foreground mode when the process should own the terminal:

```bash
omp-bundler run --foreground
```

If the named service is already running, foreground mode offers to follow its
logs, restart it in the foreground, or cancel. Foreground mode uses an unnamed
temporary container, streams logs, and forwards termination signals.

Lifecycle commands are flat and bundle-aware:

```bash
omp-bundler start [bundle-path]
omp-bundler status [bundle-path]
omp-bundler stop [bundle-path]
omp-bundler restart [bundle-path]
omp-bundler logs [bundle-path] [--follow] [--tail 100]
```

`status` reports the service state, container name, agent ID, and live endpoint.
`stop` is idempotent. `restart` recreates the service from current bundle
configuration and starts it when absent. `logs` defaults to the last 100 lines;
`--tail all` prints all retained logs.

Useful run overrides:

```bash
omp-bundler run ../meetings-agent \
  --env-file ../meetings-agent/runtime.env
omp-bundler run --image registry.example.com/meetings-agent:2026-08-04
omp-bundler run --dry-run
```

The background Docker shape is:

```bash
docker run --rm -d \
  --name meetings-agent-data-service \
  --label io.omp-bundler.bundle-root=/absolute/path/to/meetings-agent \
  -p 8787:8787 \
  -p 8765:8765 \
  -v meetings-agent-data:/data \
  -v meetings-agent-data-agent:/root/.omp/agent \
  --env-file runtime.env \
  meetings-agent:local
```

Two named volumes persist across rebuilds. `<dataVolume>:/data` holds bundler
state: core databases, the workspace, cron schedules and run history.
`<dataVolume>-agent:/root/.omp/agent` is OMP's own agent directory, which is
where it writes sessions, image blobs, and its databases. The agent definition
is copied over that directory on every boot so bundle edits land, and nothing
in it is deleted: a skill or tool removed from the bundle stays until the
volume is removed with `docker volume rm`.

### Terminal chat

Terminal chat is implemented directly in the main TypeScript CLI:

```bash
omp-bundler tui
omp-bundler tui --dir ../meetings-agent
omp-bundler tui --endpoint http://localhost:8765/v1/agents/meetings-agent
```

With no flags, `tui` finds the current bundle and its root agent. It asks
Docker for the running service or labeled foreground container's published
adapter port, then falls back to `adapterPort` from `omp-bundler.yml` when no
live container is discoverable. `--dir` selects another bundle. `--endpoint`
bypasses bundle discovery with an exact agent URL.

Bundle mode reads the optional Bearer token from `runtime.env`. Endpoint mode
reads `OMP_HTTP_API_TOKEN` from the process environment.

Each launch starts a fresh server-side conversation. Enter sends one line;
`/quit`, `/exit`, or Ctrl+C exits. Requests are synchronous and show a spinner
until the turn completes. Streaming and local resume are not currently
supported.

### HTTP API

The default adapter listens on container port 8765. The preferred host port is
8765, but startup selects another free host port when needed:

```text
GET  /health
POST /v1/agents/<agent-id>/conversations/<conversation-key>/messages
```

The conversation key is stable client-owned session identity. Percent-encode
both route values. The request body is:

```json
{ "message": "Summarize today's meeting" }
```

A successful request waits for the terminal core event and returns:

```json
{
  "agentId": "meetings-agent",
  "conversationKey": "local",
  "correlationId": "opaque-core-id",
  "text": "The meeting covered...",
  "attachments": [],
  "usage": {
    "input": 120,
    "output": 42,
    "cacheRead": 0,
    "cacheWrite": 0,
    "costUsd": 0
  }
}
```

Only one turn may be in flight for a conversation. Concurrent turns return
HTTP 409, agent errors return HTTP 502, and turn timeouts return HTTP 504.
This is a session-oriented agent API, not an OpenAI-compatible endpoint.

## Generated files

`omp-bundler new meetings-agent` creates the complete discoverable agent
surface at the bundle root:

```text
meetings-agent/
├── .gitignore
├── AGENTS.md
├── README.md
├── commands/
│   └── example-command.md.example
├── config.yml
├── Dockerfile
├── models.yml
├── extensions/
│   └── example-extension.ts.example
├── omp-bundler.yml
├── runtime.env.example
├── schedules/
│   └── example-schedule.yml.example
├── skills/
│   └── example-skill/
│       └── SKILL.md.example
├── subagents/
│   └── example-subagent.md.example
└── tools/
    └── example-tool.ts.example
```

The hierarchy is intentional: a new user can immediately see where every OMP
extension point belongs. `.example` keeps each complete starter inactive while
`check` still validates it. Use the matching generator to create an active
component rather than removing the suffix by hand.

After generating real components, the same root may also contain
`commands/summarize.md`, `extensions/lifecycle-log.ts`,
`skills/meeting-notes/SKILL.md`, `subagents/transcript-researcher.md`, and
`tools/read-transcript.ts`.

The source uses `subagents/`; Docker staging maps it to OMP's internal
`.omp/agents/` directory.

The agent ID lives in `omp-bundler.yml`, not in a directory name:

```yaml
version: 1
agent:
  id: meetings-agent

image:
  tag: meetings-agent:local

run:
  dataVolume: meetings-agent-data
  corePort: 8787
  adapterPort: 8765
```

The configured ports are preferred host ports, not fixed reservations. At
launch, `run` keeps each preferred port when it is free and otherwise selects
the next free, distinct host port. The container ports remain 8787 for core and
8765 for the adapter.

The ID is stable when the bundle directory is renamed. It determines the HTTP
route and runtime registration. Change it by editing `agent.id`, then rebuild;
there is no rename command or compatibility alias.

Relative bundle paths and command-line file arguments resolve from the shell's
current directory. Bundle configuration is rooted at the directory containing
`omp-bundler.yml`.

### System dependencies

Every bundle owns its `Dockerfile` (`check` requires it). Add any CLI your
agent's tools or cron commands shell out to — `git`, `openssh-client`, `gh`,
a Google Docs CLI, etc. — in the marked `extra system tools (customize)`
block near the top of `Dockerfile`, right after the base image and before
the runtime layout. It ships commented out, so a fresh bundle stays minimal
until you opt in.

### Agent instructions and config

A fresh `AGENTS.md` is immediately valid:

```markdown
# meetings-agent

You are the meetings-agent agent.

## Instructions

- Read the available context before acting.
- Use tools when they improve correctness.
- State uncertainty directly.
```

Replace that generic role with the agent's real job, constraints, and behavior.

A fresh `config.yml` contains only OMP settings:

```yaml
setupVersion: 1

# Add agent-local OMP settings here.
```

Use `omp-bundler model set-default <provider/model>` to maintain
`modelRoles.default`. The selected model must exist in `models.yml`.

### Generate components

Commands run from anywhere inside the bundle. No agent ID argument is needed:

| Component | Command | Created path |
| --- | --- | --- |
| Skill | `omp-bundler generate skill meeting-notes` | `skills/meeting-notes/SKILL.md` |
| Command | `omp-bundler generate command summarize` | `commands/summarize.md` |
| Tool | `omp-bundler generate tool read-transcript` | `tools/read-transcript.ts` |
| Extension | `omp-bundler generate extension lifecycle-log` | `extensions/lifecycle-log.ts` |
| Subagent | `omp-bundler generate subagent transcript-researcher` | `subagents/transcript-researcher.md` |

Generated tools and extensions load but perform no external work until they are
customized. Generated skills, commands, and subagents contain valid starter
frontmatter and instructions.

Preview without writing:

```bash
omp-bundler generate tool read-transcript --dry-run
```

Generators refuse to overwrite existing paths.

Remove generated components symmetrically:

```bash
omp-bundler destroy skill meeting-notes
omp-bundler destroy command summarize
omp-bundler destroy tool read-transcript
omp-bundler destroy extension lifecycle-log
omp-bundler destroy subagent transcript-researcher
```

Destructive commands print affected paths and ask for confirmation. Use
`--dry-run` to preview or `--yes` for non-interactive removal. They do not
delete Docker volumes, sessions, or `runtime.env`.

## Cron schedules

Cron job source lives at the bundle root in `schedules/*.yml`. Files with the
`.example` suffix, such as `schedules/example-schedule.yml.example`, are inert.
Use `omp-bundler generate schedule <name>` to create
`schedules/<name>.yml`, and `omp-bundler destroy schedule <name>` to remove it.

On first startup, the image's schedule tree is seeded once into
`/data/cron/schedules` on the named data volume. That directory is then the
live schedule source and belongs to the agent: `/data/cron` is an additional
workspace root, so the agent can read and edit schedules with its normal file
tools. Editing `schedules/*.yml` in the bundle and rebuilding does **not**
update an existing deployment's live copy; change `/data/cron/schedules` for
that deployment instead.

A schedule file is a YAML mapping with these fields:

- `schedule`: a required 5-field cron expression (`minute hour day-of-month
  month day-of-week`).
- `timezone`: an IANA timezone. It defaults to `UTC`.
- `missed`: required `skip` or `catchUp`. `skip` runs only the latest due fire
  after downtime; `catchUp` runs missed fires subject to the scheduler's cap.
- Exactly one of `prompt` or `command`, each a non-empty string. `prompt` is
  sent as the user message for a model turn; `command` is run as a raw shell
  command without a model turn.
- `timeout`: optional positive integer seconds, valid only with `command`.
  Command mode defaults to 600 seconds when it is omitted.
- `runAtBoot`: optional boolean (defaults to `false`). When `true`, the job
  runs once at startup in addition to its normal schedule. The boot run does
  not write last-run state, so it never shifts the next scheduled fire. This
  is useful when a repo clone is created on a fresh data volume: without it,
  the clone would not exist until the next interval elapses.

Prompt mode:

```yaml
schedule: "0 9 * * 1-5"
timezone: America/New_York
missed: skip
prompt: "Summarize today's meetings and post the summary."
runAtBoot: true
```

Command mode:

```yaml
schedule: "*/10 * * * *"
timezone: UTC
missed: catchUp
command: "date -u"
timeout: 60
```

Cron runs as an independent supervised process alongside core and the
selected adapter; it does not use an adapter. Each prompt fire starts a fresh
OMP session (v1). Each job's output and run metadata are durable and readable
by the agent:

```text
/data/cron/
├── schedules/
│   └── <job-id>.yml
└── jobs/
    └── <job-id>/
        ├── last-run.json
        └── runs/
            └── <fireEpoch>.txt
```

The job ID is the schedule filename stem. Read
`/data/cron/jobs/<job-id>/last-run.json` for the latest run metadata and
`/data/cron/jobs/<job-id>/runs/<fireEpoch>.txt` for that fire's output when
answering what happened on the last cron run.

An active `*.yml` schedule automatically enables cron; no separate enablement is
required. The scheduler stays idle when no active `*.yml` schedule exists, so
an agent can create its first schedule without a restart. Set
`OMP_CRON_ENABLED=true` to enable it explicitly or `OMP_CRON_ENABLED=false` to
disable it.

## Runtime filesystem

The image contains one immutable agent identity and definition:

```text
/agent/
├── id
└── .omp/
    ├── AGENTS.md
    ├── config.yml
    └── ... generated components
```

At every container start, the entrypoint refreshes the image-owned definition
and prepares the persistent workspace:

```text
/data/agent/
├── .omp/       # refreshed from the image on every start
└── workspace/  # persistent agent cwd; empty on first start
```

Each OMP session starts with:

```text
cwd=/data/agent/workspace
```

The agent can inspect its deployed instructions and configuration at `../.omp`
without mixing them into working files. Rebuilding and restarting replaces
`.omp` but preserves `workspace` byte-for-byte.

OMP requires config, instructions, skills, commands, extensions, tools, and
subagents to share one agent directory. The entrypoint therefore materializes
an ephemeral runtime view under `$HOME/.omp/runtime-agent`, points
`OMP_AGENT_DIR` at it, and adds the rendered model catalog there. Its
`sessions` entry links to `/data/sessions`. This keeps generated credentials
and OMP databases off the persistent definition while conversations and
workspace files survive restarts.

The data volume also holds core registries, outbound state, artifacts, sessions,
and the live cron schedules and run history under `/data/cron`. `/data/cron` is
provided as an additional OMP workspace root, so the agent's normal file tools
can edit `/data/cron/schedules/*.yml`. Container replacement with the same
`dataVolume` preserves them. The image definition remains authoritative for
`.omp`; cron schedules are separate runtime state and are not replaced on boot.

This layout is a configuration boundary, not a filesystem security sandbox.
An unrestricted agent can still use absolute paths available inside its
container.

## CLI reference

```text
omp-bundler new <path> [--id <agent-id>] [--dry-run]

omp-bundler generate skill <name> [--dry-run]
omp-bundler generate command <name> [--dry-run]
omp-bundler generate tool <name> [--dry-run]
omp-bundler generate extension <name> [--dry-run]
omp-bundler generate subagent <name> [--dry-run]
omp-bundler generate adapter pumble [--dry-run]
omp-bundler generate schedule <name> [--dry-run]

omp-bundler destroy skill <name> [--dry-run] [--yes]
omp-bundler destroy command <name> [--dry-run] [--yes]
omp-bundler destroy tool <name> [--dry-run] [--yes]
omp-bundler destroy extension <name> [--dry-run] [--yes]
omp-bundler destroy subagent <name> [--dry-run] [--yes]
omp-bundler destroy schedule <name> [--dry-run] [--yes]

omp-bundler model add <provider/model> [--from omp]
omp-bundler model add <provider/model> --base-url <url> --api <dialect> [--api-key-env <NAME> | --no-auth]
omp-bundler model set-default <provider/model>
omp-bundler model list

omp-bundler check [bundle-path] [--env-file <path>]
omp-bundler build [bundle-path] [--tag <image-tag>]
omp-bundler run [bundle-path] [--foreground] [--env-file <path>] [--image <tag>] [--dry-run]
omp-bundler start [bundle-path] [--env-file <path>] [--image <tag>] [--dry-run]
omp-bundler status [bundle-path]
omp-bundler stop [bundle-path]
omp-bundler restart [bundle-path] [--env-file <path>] [--image <tag>] [--dry-run]
omp-bundler logs [bundle-path] [--follow] [--tail <lines>]
omp-bundler tui [--dir <bundle-path>] [--endpoint <agent-url>]
omp-bundler completion <bash|zsh|fish>
```

Every command supports `--help`.
