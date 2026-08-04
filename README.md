# omp-bundler

Build and run one filesystem-configured OMP agent as a durable service.

Each bundle is one deployment and one routable agent. The bundle root is the
agent source: `AGENTS.md`, `config.yml`, optional component directories, and
`model.yml`. There is no agent collection, registry, or repeated agent ID on
component commands.

`omp-bundler` creates the bundle, generates components, configures its model,
validates the source and runtime environment, builds a Docker image, and runs
that image in the foreground or as a managed service.

## Install

```bash
npm install --global @omp-bundler/cli
omp-bundler --version
```

Docker is required for `build`, `run`, and `service` commands. Model and adapter
credentials are needed only when checking or starting a runtime environment.

## Quick start

Create a bundle. The directory basename becomes the stable agent ID unless
`--id` is supplied:

```bash
omp-bundler new meetings-agent
cd meetings-agent
```

Edit the agent and configure its model:

```bash
$EDITOR AGENTS.md
omp-bundler set-model deepseek/deepseek-v4-flash
```

`set-model <provider/model>` imports an exact model from the local OMP
installation. Run `omp-bundler set-model` without a selector to edit
`model.yml` directly, or add `--wizard` for guided prompts.

Create the ignored runtime file and fill its generated placeholders:

```bash
cp runtime.env.example runtime.env
$EDITOR runtime.env
```

Validate, build, and start a detached service:

```bash
omp-bundler check
omp-bundler build
omp-bundler service start
```

Chat through the installed CLI:

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
new -> edit or generate -> set-model -> check -> build -> run
```

## Source layout

`omp-bundler new meetings-agent` creates the minimal bundle:

```text
meetings-agent/
├── .gitignore
├── AGENTS.md
├── README.md
├── config.yml
├── omp-bundler.yml
└── runtime.env.example
```

After configuring a model and generating some components, the same bundle may
look like:

```text
meetings-agent/
├── .gitignore
├── AGENTS.md
├── README.md
├── commands/
│   └── summarize.md
├── config.yml
├── extensions/
│   └── lifecycle-log.ts
├── model.yml
├── omp-bundler.yml
├── runtime.env.example
├── skills/
│   └── meeting-notes/
│       └── SKILL.md
├── subagents/
│   └── transcript-researcher.md
└── tools/
    └── read-transcript.ts
```

Component directories are optional and are created by their generators. The
source uses `subagents/`; Docker staging maps it to OMP's internal
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

The ID is stable when the bundle directory is renamed. It determines the HTTP
route and runtime registration. Change it by editing `agent.id`, then rebuild;
there is no rename command or compatibility alias.

Relative bundle paths and command-line file arguments resolve from the shell's
current directory. Bundle configuration is rooted at the directory containing
`omp-bundler.yml`.

## Agent instructions and config

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

Do not hand-write `modelRoles.default`. `omp-bundler` generates the runtime
binding from `model.yml` while staging the image.

## Generate components

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

## Configure the model

Each bundle requires one root `model.yml`. The shortest path is importing an
exact provider/model selector from the local OMP installation:

```bash
omp-bundler set-model deepseek/deepseek-v4-flash
```

The command copies the model's protocol fields and credential reference; it
does not copy a resolved secret value.

Other modes use the same schema:

```bash
# Edit model.yml in VISUAL, EDITOR, or vi
omp-bundler set-model

# Guided prompts
omp-bundler set-model --wizard

# Direct fields
omp-bundler set-model \
  --base-url https://api.openai.com/v1 \
  --dialect openai-responses \
  --model gpt-5.4 \
  --api-key '${OPENAI_API_KEY}'

# Print the handwritten YAML template
omp-bundler set-model --print-template
```

`model.yml` has this schema:

```yaml
version: 1
baseUrl: https://api.openai.com/v1
dialect: openai-responses
model: gpt-5.4
apiKey: "${OPENAI_API_KEY}"
```

- `baseUrl` is an HTTP(S) URL or `${ENV_VAR}`.
- `dialect` is `openai-responses`, `openai-completions`, or
  `anthropic-messages`.
- `model` is a non-empty provider model ID or environment template.
- `apiKey` is a literal, `${ENV_VAR}`, `null`, or an empty string for no auth.

Referenced environment names are maintained in `runtime.env.example`.
Re-running `set-model` adds new names, removes stale names, and preserves
unrelated adapter sections. It never reads or changes ignored `runtime.env`.

A literal API key is supported but becomes part of the committed source and
built image. Use an environment template for production credentials.
Diagnostic output never prints API key values.

## Runtime adapters

New bundles default to the built-in HTTP adapter:

```env
# Bundled adapter. HTTP serves the agent API and built-in terminal chat.
OMP_BUNDLER_ADAPTER=http

# Optional Bearer token for the public HTTP endpoint. Leave empty only on trusted localhost.
OMP_HTTP_API_TOKEN=
```

Set `OMP_HTTP_API_TOKEN`, or place the adapter behind an authenticated local
reverse proxy, before exposing port 8765 outside trusted localhost.

Generate the Pumble fields only for a Pumble deployment:

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

Advanced deployments may provide `OMP_ADAPTERS` directly as an unquoted JSON
array on one `runtime.env` line. A singular registration looks like:

```env
OMP_ADAPTERS=[{"adapterId":"http-meetings-agent","callbackUrl":"http://127.0.0.1:8765/core/events/meetings-agent","sharedSecret":"replace-me","agentId":"meetings-agent"}]
```

The registration's `agentId` must equal `agent.id`.

## Validate

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
- required root `AGENTS.md` and `config.yml`
- active component files and OMP frontmatter
- TypeScript extension and tool entrypoints
- root `model.yml` ownership and schema
- required runtime placeholders without exposing their values
- accidental credentials, runtime state, and symlinks in agent source
- Pumble or explicit adapter bindings against the bundle agent ID

A failed check names the path, field, and correction.

## Build

```bash
omp-bundler build
omp-bundler build ../meetings-agent
omp-bundler build --tag registry.example.com/meetings-agent:2026-08-04
```

`build`:

1. Runs source, model, and credential-leak validation.
2. Stages the shared runtime.
3. Writes the stable ID to the image as `/agent/id`.
4. Maps root agent source to `/agent/.omp/`, including
   `subagents/` as `.omp/agents/`.
5. Generates the internal provider catalog and default model binding.
6. Builds the configured Docker image.

Building does not contact a model provider or adapter and does not read
`runtime.env`. Environment templates remain unresolved until container start.

## Run

Copy and fill the local runtime file before running:

```bash
cp runtime.env.example runtime.env
$EDITOR runtime.env
```

Run in the foreground:

```bash
omp-bundler run
```

`run` validates `runtime.env`, owns an unnamed temporary container, streams
logs, and forwards termination signals. If the managed service is already
running, it asks whether to follow that service's logs, stop it and run a
foreground container, or cancel.

Useful overrides:

```bash
omp-bundler run ../meetings-agent \
  --env-file ../meetings-agent/runtime.env
omp-bundler run --image registry.example.com/meetings-agent:2026-08-04
omp-bundler run --dry-run
```

The direct Docker shape is:

```bash
docker run --rm \
  -p 8787:8787 \
  -p 8765:8765 \
  -v meetings-agent-data:/data \
  --env-file runtime.env \
  meetings-agent:local
```

### Managed service

```bash
omp-bundler service start
omp-bundler service status
omp-bundler service restart
omp-bundler service stop
```

The deterministic container name is `<dataVolume>-service`. `service start` is
idempotent while it is running. `stop` is idempotent. `restart` requires an
existing running container.

`service start` accepts the same bundle path, `--env-file`, `--image`, and
`--dry-run` options as `run`.

## Terminal chat

Terminal chat is implemented directly in the main TypeScript CLI:

```bash
omp-bundler tui
omp-bundler tui --dir ../meetings-agent
omp-bundler tui --endpoint http://localhost:8765/v1/agents/meetings-agent
```

With no flags, `tui` finds the current bundle and its root agent. `--dir`
selects another bundle. `--endpoint` bypasses bundle discovery with an exact
agent URL.

Bundle mode reads `adapterPort` from `omp-bundler.yml` and the optional Bearer
token from `runtime.env`. Endpoint mode reads `OMP_HTTP_API_TOKEN` from the
process environment.

Each launch starts a fresh server-side conversation. Enter sends one line;
`/quit`, `/exit`, or Ctrl+C exits. Requests are synchronous and show a spinner
until the turn completes. Streaming and local resume are not currently
supported.

## HTTP API

The default adapter listens on `adapterPort`, 8765 by default:

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

The data volume also holds core registries, outbound state, artifacts, and
sessions. Container replacement with the same `dataVolume` preserves them.
The image definition remains authoritative; live changes to the refreshed
`.omp` copy are discarded at the next start.

This layout is a configuration boundary, not a filesystem security sandbox.
An unrestricted agent can still use absolute paths available inside its
container.

## CLI reference

```text
omp-bundler new <path> [--id <agent-id>]

omp-bundler generate skill <name> [--dry-run]
omp-bundler generate command <name> [--dry-run]
omp-bundler generate tool <name> [--dry-run]
omp-bundler generate extension <name> [--dry-run]
omp-bundler generate subagent <name> [--dry-run]
omp-bundler generate adapter pumble [--dry-run]

omp-bundler destroy skill <name> [--dry-run] [--yes]
omp-bundler destroy command <name> [--dry-run] [--yes]
omp-bundler destroy tool <name> [--dry-run] [--yes]
omp-bundler destroy extension <name> [--dry-run] [--yes]
omp-bundler destroy subagent <name> [--dry-run] [--yes]

omp-bundler set-model [provider/model]
omp-bundler set-model [provider/model] --wizard
omp-bundler set-model [provider/model] [--from omp]
omp-bundler set-model [--base-url <value>] [--dialect <value>] [--model <value>] [--api-key <value>]
omp-bundler set-model --print-template

omp-bundler check [bundle-path] [--env-file <path>]
omp-bundler build [bundle-path] [--tag <image-tag>]
omp-bundler run [bundle-path] [--env-file <path>] [--image <tag>] [--dry-run]
omp-bundler service start [bundle-path] [--env-file <path>] [--image <tag>] [--dry-run]
omp-bundler service stop [bundle-path]
omp-bundler service status [bundle-path]
omp-bundler service restart [bundle-path]
omp-bundler tui [--dir <bundle-path>] [--endpoint <agent-url>]
```

Every command supports `--help`.