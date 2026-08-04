# omp-bundler

Build and run filesystem-configured OMP agents as a durable service.

> **Implementation status:** This README is the product contract for the new
> `omp-bundler` CLI. The CLI described below is the target interface and is
> being implemented through README-driven development.

An agent is a directory holding its OMP project files directly at the root:
`AGENTS.md`, `config.yml`, and the `agents`, `commands`, `extensions`,
`skills`, and `tools` component directories. Direct child directories define
agent IDs. After `new` or `generate agent`, run `set-model <agent-id>` to
create the required model connection and any required runtime placeholders. Use
`agent rename` and `destroy agent` to keep existing bundle-owned model and
managed runtime-example state synchronized. There is no separate agent
registry or agent-list environment variable.

`omp-bundler` provides a Rails-style CLI for creating a bundle, generating
agents and their components, validating the result, building a container
image, and running it.

## Install

Install the CLI:

```bash
npm install --global @omp-bundler/cli
```

Confirm that it is available:

```bash
omp-bundler --version
```

Docker is required to build and run images. Configure each agent's model
connection in the bundle; supply referenced environment values only at runtime.

## Quick start

Create a bundle with its first agent:

```bash
omp-bundler new my-bundle --agent my-agent
cd my-bundle
```

Edit the generated instructions, then configure the agent's model:

```bash
$EDITOR agents/my-agent/AGENTS.md
omp-bundler set-model my-agent
```

`set-model` opens temporary model YAML in `VISUAL`, `EDITOR`, or `vi`. After
you save and exit with valid YAML, it atomically commits
`models/my-agent.yml`. Use `omp-bundler set-model my-agent --wizard` for
guided prompts instead.

Create the local runtime file, fill any generated model placeholders, check,
build, and run in the foreground:

```bash
cp runtime.env.example runtime.env
$EDITOR runtime.env
omp-bundler check
omp-bundler build
omp-bundler run
```

Use `omp-bundler service start` instead of `run` when the validated bundle
should stay running in a detached container.

Send a turn through the default HTTP adapter:

```bash
curl -X POST \
  http://localhost:8765/v1/agents/my-agent/conversations/local/messages \
  -H 'content-type: application/json' \
  -d '{"message":"What can you help me with?"}'
```

The request waits for the completed turn and returns JSON containing `text`,
`attachments`, and `usage`. Pumble is optional; generate its template only
when this bundle will receive Pumble events.

The complete development loop is:

```text
new or generate -> edit -> set-model -> check -> build -> run
```

## What `new` creates

```bash
omp-bundler new my-bundle --agent my-agent
```

creates:

```text
my-bundle/
├── .gitignore
├── README.md
├── omp-bundler.yml
├── runtime.env.example
└── agents/
    └── my-agent/
        ├── AGENTS.md
        ├── config.yml
        ├── agents/
        │   └── example-subagent.md.example
        ├── commands/
        │   └── example-command.md.example
        ├── extensions/
        │   └── example-extension.ts.example
        ├── skills/
        │   └── example-skill/
        │       └── SKILL.md.example
        └── tools/
            └── example-tool.ts.example
```

The agent scaffold creates every supported OMP project surface. A first-time
user can inspect the complete shape without knowing OMP's discovery paths in
advance.

`new` does not guess a provider or model. `set-model` creates the bundle-owned
`models/<agent-id>.yml` file when the connection is configured.

The `.example` files are complete, valid templates. OMP ignores the `.example`
suffix, so they have no runtime effect. The `check` command still validates
them. The preferred activation path is the corresponding generator. To
activate a customized example directly, copy it without the final `.example`
suffix. For example:

```bash
cp agents/my-agent/tools/example-tool.ts.example \
  agents/my-agent/tools/example-tool.ts
```

If the bundle should start empty, omit `--agent`:

```bash
omp-bundler new my-bundle
```

An empty bundle creates the same root files and an empty, tracked agent
collection:

```text
my-bundle/
├── .gitignore
├── README.md
├── omp-bundler.yml
├── runtime.env.example
└── agents/
    └── .gitkeep
```

The placeholder is never treated as an agent. `generate agent` removes it when
the first real agent directory is created.

Then generate the first agent later:

```bash
cd my-bundle
omp-bundler generate agent my-agent
```

## Bundle configuration

`omp-bundler.yml` configures build and local-run defaults. It does not list
agents.

```yaml
version: 1
agentsDir: ./agents

image:
  tag: my-bundle:local

run:
  dataVolume: my-bundle-data
  corePort: 8787
  adapterPort: 8765
```

`new` derives these defaults from the bundle directory name. For a bundle
created as `demo`, the image tag is `demo:local`, the volume is `demo-data`,
and the ports are `8787` and `8765`. `build --tag` overrides the image tag for
one build; `run --image` overrides it for one run. Neither flag rewrites
`omp-bundler.yml`.

Every direct child directory of `agentsDir` is an agent. Its directory name is
its agent ID.

Relative bundle-path and command-line file arguments resolve from the shell's
current directory. Paths stored in `omp-bundler.yml`, including `agentsDir`,
resolve from the bundle directory.

## Agent scaffold

Generate another complete agent:

```bash
omp-bundler generate agent second-agent
```

This creates the same full source tree produced by `new --agent`: every file
and directory directly at the agent root, with no nested `.omp/` directory.
Generation fails rather than overwriting an existing agent.

The generated `AGENTS.md` is immediately valid:

```markdown
# my-agent

You are the my-agent agent.

## Instructions

- Read the available context before acting.
- Use tools when they improve correctness.
- State uncertainty directly.
```

Treat this as a starting point. Replace the generic role and instructions with
the agent's actual job, constraints, and behavior.

The generated `config.yml` is immediately valid and contains only OMP
agent-local settings:

```yaml
setupVersion: 1
```

Model connections belong at `models/<agent-id>.yml`, not in
`modelRoles.default`. During build, omp-bundler generates the internal OMP
provider binding in the staged image without changing this source file.

## Generate agent components

All component generators use the same argument order:

```text
omp-bundler generate <component> <agent-id> <component-name>
```

The exception is `adapter`, which is bundle-level runtime wiring and accepts
`--agent <agent-id>`.

### Skill

```bash
omp-bundler generate skill my-agent knowledge-base
```

Creates:

```text
agents/my-agent/skills/knowledge-base/SKILL.md
```

### Command

```bash
omp-bundler generate command my-agent summarize
```

Creates:

```text
agents/my-agent/commands/summarize.md
```

### Tool

```bash
omp-bundler generate tool my-agent lookup-record
```

Creates:

```text
agents/my-agent/tools/lookup-record.ts
```

The generated tool contains a valid typed registration and a harmless example
implementation. It loads successfully before being customized.

### Extension

```bash
omp-bundler generate extension my-agent lifecycle-log
```

Creates:

```text
agents/my-agent/extensions/lifecycle-log.ts
```

The generated extension loads successfully but performs no external work until
its example hook is customized.

### OMP subagent

```bash
omp-bundler generate subagent my-agent researcher
```

Creates:

```text
agents/my-agent/agents/researcher.md
```

A subagent is an OMP task-agent definition owned by a deployed agent. It is not
a top-level deployed agent. Use `generate agent`, not `generate subagent`, to
create another independently routable agent.

### Adapter runtime template

```bash
omp-bundler generate adapter pumble --agent my-agent
```

This adds the Pumble runtime fields to `runtime.env.example`, including:

```env
PUMBLE_APP_ID=
PUMBLE_APP_CLIENT_SECRET=
PUMBLE_APP_KEY=
PUMBLE_APP_SIGNING_SECRET=
PUMBLE_PUBLIC_BASE_URL=
PUMBLE_CORE_SHARED_SECRET=
PUMBLE_AGENT_ID=my-agent
```

It does not create credentials and does not modify the agent directory. The
adapter binding is runtime deployment wiring: it tells one external Pumble
application which filesystem-defined agent receives its messages.

The adapter generator is the one generator that updates a shared existing
file. It merges missing Pumble fields into the committed
`runtime.env.example` without replacing unrelated lines. Repeating the same
command with the same agent is an idempotent no-op. If the template already
binds Pumble to a different agent, generation fails and tells the user to
change or remove that binding explicitly.

The generator never reads or edits an existing ignored `runtime.env`; copy the
updated example or merge its newly generated fields into your local runtime
file yourself.

List the available generators:

```bash
omp-bundler generate --help
```

Preview any generator without writing files:

```bash
omp-bundler generate tool my-agent lookup-record --dry-run
```

Agent and agent-component generators refuse to overwrite existing component
files. The adapter generator follows the documented merge rule above.

## Configure an agent model

Each effective agent must have one bundle-owned model connection:

```text
models/<agent-id>.yml
```

Configure it with the default editor flow:

```bash
omp-bundler set-model my-agent
```

When a bundle has exactly one agent, the ID is optional. A new connection
starts from the same commented template printed by:

```bash
omp-bundler set-model my-agent --print-template
```

The stored YAML has one small schema:

```yaml
version: 1
baseUrl: https://api.openai.com/v1
dialect: openai-responses
model: gpt-5.4
apiKey: "${OPENAI_API_KEY}"
```

- `baseUrl` is an HTTP(S) URL or `${ENV_VAR}` template.
- `dialect` is exactly `openai-responses`, `openai-completions`, or
  `anthropic-messages`.
- `model` is a non-empty provider model ID or environment template.
- `apiKey` accepts a literal, `${ENV_VAR}`, `null`, or an empty string for a
  no-auth endpoint.

Use the wizard when guided prompts are preferable:

```bash
omp-bundler set-model my-agent --wizard
```

Automation can supply the same fields directly:

```bash
omp-bundler set-model my-agent \
  --base-url https://api.openai.com/v1 \
  --dialect openai-responses \
  --model gpt-5.4 \
  --api-key '${OPENAI_API_KEY}'
```

Direct flags may also update only selected fields of an existing connection.
Editor, wizard, direct flags, printed templates, and handwritten YAML all use
the same parser and field definitions. Invalid input, a failed editor, or
editor cancellation changes nothing. Diagnostic output names fields and paths
but never prints an API key value.

Every `${ENV_VAR}` referenced by the model connection is added to the
agent's generated block in `runtime.env.example`. Re-running `set-model`
updates that block exactly: new names appear, stale names disappear, and
unrelated or Pumble sections remain. Literal and no-auth values need no runtime
placeholder. A literal API key is supported but is stored in the committed
model file and built image. Never put production credentials there; use an
environment template.

`set-model` never edits an existing ignored `runtime.env`. If that file already
exists, copy or merge changed model variables from `runtime.env.example` before
the next `check` or `run`.

At build time, omp-bundler renders an internal provider catalog and per-agent
default binding into the Docker context. Internal provider IDs are generated
implementation details, not values users configure or copy.

## Rename an agent

```bash
omp-bundler agent rename my-agent renamed-agent
```

This moves:

```text
agents/my-agent/
```

to:

```text
agents/renamed-agent/
```

The command performs these source-tree changes atomically:

1. Moves `agents/my-agent/` to `agents/renamed-agent/`.
2. Moves `models/my-agent.yml` to `models/renamed-agent.yml` when present.
   The default generated API-key placeholder and managed
   `runtime.env.example` model block follow the new ID; custom placeholders,
   comments, and unrelated fields remain unchanged.
3. Updates `PUMBLE_AGENT_ID` in the committed `runtime.env.example` when that
   generated field names the old agent.
4. Reports any other project-owned text reference it cannot update safely.

It does not edit ignored `runtime.env` files, rewrite JSON inside
`OMP_ADAPTERS`, rebuild an existing image, rename durable
`/data/agents/my-agent` state, or change a running container.

After the rebuilt image starts, the old durable agent directory remains but
its stale `/data/agents/my-agent/.omp/` subtree is removed. Sibling workspace
files remain. Copy anything needed from the old `.omp` subtree before starting
the rebuilt image.

Before the next run, update any local runtime variable or explicit adapter
binding that still uses the old ID, then rebuild:

```bash
$EDITOR runtime.env
omp-bundler check
omp-bundler build
omp-bundler run
```

Rebuilding is required because existing images retain the old baked directory.

## Remove generated components

Generators have symmetric removal commands:

```text
omp-bundler destroy <component> <agent-id> <component-name>
```

Examples:

```bash
omp-bundler destroy skill my-agent knowledge-base
omp-bundler destroy command my-agent summarize
omp-bundler destroy tool my-agent lookup-record
omp-bundler destroy extension my-agent lifecycle-log
omp-bundler destroy subagent my-agent researcher
```

Remove a deployed agent with:

```bash
omp-bundler destroy agent second-agent
```

Destructive commands print the paths they will delete and ask for confirmation.
Use `--dry-run` to preview them. Automation may use `--yes` to skip the prompt.
Destroying an agent also removes its matching `models/<agent-id>.yml` and
generated model block from `runtime.env.example`. If the agent owns the
generated Pumble block, that block is removed and the committed example
returns to HTTP mode. Unrelated lines remain unchanged.

Removing source files does not delete Docker volumes, sessions, remote
resources, or ignored `runtime.env` bindings. Update local runtime bindings
before the next run. An already-built image is immutable, so rebuild to remove
the source from future containers.

The old durable agent directory and its sibling workspace files remain. After
a rebuilt image starts, the stale `/data/agents/<agent-id>/.omp/` subtree is
removed because it is no longer baked into the image. Copy anything needed
from that subtree before starting the rebuilt image; deleting the remaining
durable workspace is a separate operator action.

## Migrate a legacy agent layout

Earlier versions stored each agent's source in a nested
`agents/<agent-id>/.omp/` directory. Agent source now lives directly at the
agent root, and every source command rejects a nested `.omp/` directory.
Convert a legacy bundle in place with:

```bash
omp-bundler migrate visible-layout [bundle-path] [--dry-run] [--yes]
```

For each agent directory under `agentsDir`, the command checks for a nested
`.omp/` directory. When one exists, it moves every entry of that directory up
to the agent root and then removes the now-empty `.omp/` directory. Agents
without a legacy `.omp/` directory are left alone, and `.gitkeep` entries are
skipped.

Migration is one-way: the source ends up at the agent root, and no command
writes a nested `.omp/` layout again. It is still safe to run:

- With `--dry-run`, it prints the complete move-and-remove plan and changes
  nothing.
- Without `--dry-run`, it prints the same plan and asks for confirmation
  before applying it. Automation may pass `--yes` to skip the prompt.
- It refuses to overwrite: if an entry would land on an existing file or
  directory at the agent root, the command fails before changing anything and
  names the conflicting path.
- It rejects symlinked agent and legacy `.omp/` paths.
- When no agent has a legacy `.omp/` directory, it reports that there is
  nothing to migrate and exits without prompting.

Rebuild after migrating: existing images still contain the old baked layout.

## Validate

From a bundle directory:

```bash
omp-bundler check
```

Validate a bundle elsewhere:

```bash
omp-bundler check ../another-bundle
```

`check` validates:

- `omp-bundler.yml`
- Agent directory names
- Required agent-root files and component directories
- Rejection of a legacy nested `.omp/` directory
- Active components and ignored `.example` templates
- OMP YAML and Markdown frontmatter
- TypeScript extension and tool entrypoints
- Duplicate component names
- Exactly one valid `models/<agent-id>.yml` for every effective agent, with no
  unknown model files, legacy `modelRoles.default`, or symlinked ownership
- Model field syntax and required runtime placeholder names without exposing
  credential values
- Accidental credentials or generated runtime state in agent source
- Adapter-to-agent bindings when runtime configuration is selected

If `runtime.env` exists, `check` selects it automatically. An explicit file
takes precedence:

```bash
omp-bundler check --env-file another-runtime.env
```

Without either file, `check` performs structural and source validation only.
With runtime configuration, it also validates model placeholders,
`PUMBLE_AGENT_ID`, and every `OMP_ADAPTERS[].agentId` against the effective
agent collection.

A failed check names the exact file, field, and expected correction.

## Build

Build the current bundle using the tag in `omp-bundler.yml`:

```bash
omp-bundler build
```

Build a bundle from another directory:

```bash
omp-bundler build ../another-bundle
```

Override the image tag:

```bash
omp-bundler build --tag registry.example.com/my-bundle:2026-08-01
```

Override the agent collection without changing project configuration:

```bash
omp-bundler build --agents ./alternate-agents --tag alternate-agents:local
```

`--agents` takes precedence over `agentsDir` for that build only. Its argument
must be an agent collection: every direct child directory is an agent and must
contain a valid scaffold directly at its root. The override receives the same
validation as the configured collection. A missing path, a file instead of a
directory, or an invalid child fails before Docker runs.

The build command:

1. Runs the structural, source, model-ownership, and credential-leak checks
   performed by `check` without runtime configuration.
2. Resolves the effective collection from `--agents`, when supplied, or
   `agentsDir` otherwise.
3. Discovers every direct child of that effective collection.
4. Stages the shared omp-bundler runtime.
5. Bakes each agent's visible source root into the internal
   `/agents/<agent-id>/.omp/` path of the staged context.
6. Generates the internal model catalog and per-agent OMP default binding from
   the matching bundle-root model files.
7. Builds the Docker image and reports its tag and included agent IDs.

Building requires Docker. It does not contact model providers or adapters and
does not read `runtime.env` or `runtime.env.example`. Environment templates
remain unresolved until the container starts.

A model connection may contain a literal base URL or API key, in which case
that value is intentionally part of the committed bundle and built image.
Use `${ENV_VAR}` templates to keep deployment-specific URLs and credentials in
the runtime environment instead.

## Runtime configuration

`new` creates a compact HTTP-first `runtime.env.example`:

```env
# Bundled adapter. HTTP serves the agent API and omp-tui.
OMP_BUNDLER_ADAPTER=http

# Optional Bearer token for the public HTTP endpoint. Leave empty only on trusted localhost.
OMP_HTTP_API_TOKEN=
```

HTTP is the default bundled adapter. `OMP_HTTP_API_TOKEN` is optional; when
set, message requests must send `Authorization: Bearer <token>`. Set it, or
place the adapter behind an authenticated local reverse proxy, before exposing
port 8765 outside a trusted development machine.

`set-model` adds only the environment names referenced by each model:

```env
# Model connection for my-agent. Copy this file to runtime.env and fill these values.
OPENAI_API_KEY=
```

For a Pumble deployment, generate its committed section before creating the
local file:

```bash
omp-bundler generate adapter pumble --agent my-agent
cp runtime.env.example runtime.env
```

The generator switches `OMP_BUNDLER_ADAPTER` to `pumble`, adds the required
Pumble fields, and binds them to the selected agent. Fill `runtime.env` with
deployment values; it is ignored by Git. Generators and lifecycle commands
never edit that ignored local file.

## Run

Run the current bundle using its default `runtime.env`:

```bash
omp-bundler run
```

If the default file is absent, `run` stops with an actionable error. Select a
different file explicitly when needed:

```bash
omp-bundler run --env-file another-runtime.env
```

The command uses the image tag, ports, and data volume from
`omp-bundler.yml`. It validates runtime model values and adapter bindings
against the effective agent collection before starting the container, streams
logs, forwards termination signals, and prints copyable per-agent HTTP and
`omp-tui` URLs.

`run` owns the foreground process. It gives the container the deterministic
name `<dataVolume>-service`, so the service lifecycle commands can address the
same deployment without a PID file.

Run a bundle from another directory:

```bash
omp-bundler run ../another-bundle \
  --env-file ../another-bundle/runtime.env
```

Override the image:

```bash
omp-bundler run --image registry.example.com/my-bundle:2026-08-01
```

Override the agent collection used for binding validation without changing
the image or project configuration:

```bash
omp-bundler run --agents ./alternate-agents
```

`--agents` takes precedence over `agentsDir` for validation only. It follows
the same collection rules as `build --agents` and must match the collection
the image was built with, because only those agents exist inside the
container. A missing path, a file instead of a directory, or an invalid child
fails before Docker runs.

Preview the Docker invocation:

```bash
omp-bundler run --dry-run
```

The equivalent direct Docker shape is:

```bash
docker run --rm \
  --name my-bundle-data-service \
  -p 8787:8787 \
  -p 8765:8765 \
  -v my-bundle-data:/data \
  --env-file runtime.env \
  my-bundle:local
```

### Service lifecycle

Start the validated bundle in a detached container:

```bash
omp-bundler service start
```

`service start` accepts the same bundle path, `--env-file`, `--image`,
`--agents`, and `--dry-run` arguments as `run`. Manage that one bundle
container with:

```bash
omp-bundler service status
omp-bundler service restart
omp-bundler service stop
```

`status` prints the Docker state and exits nonzero when the named container
does not exist. `stop` is idempotent. `restart` requires an existing running
container; if a `--rm` container has exited, use `service start` again.

### Default HTTP API

The public adapter listens on `adapterPort` (8765 by default):

```text
GET  /health
POST /v1/agents/<agent-id>/conversations/<conversation-key>/messages
```

Percent-encode the agent ID and conversation key when constructing the URL.
The conversation key is stable client-owned session identity. The request
body is deliberately smaller than an OpenAI chat-completions request:

```json
{ "message": "Summarize today's meeting" }
```

A successful request waits for the terminal core event and returns:

```json
{
  "agentId": "my-agent",
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

Only one turn may be in flight per agent/conversation pair. Concurrent turns
return HTTP 409. Agent errors return HTTP 502; turn timeouts return HTTP 504.
This is a session-oriented agent API like agent's, not an OpenAI-compatible API.

No `OMP_ARGS` value is required for normal operation. Flags such as
`--no-tools` and short `--max-time` values belong to deliberate diagnostics,
not the default runtime instructions.

## Filesystem behavior at startup

Inside the container, each agent's source is packaged as an internal `.omp/`
directory at:

```text
/agents/<agent-id>/.omp/
```

At startup, omp-bundler seeds it to the durable volume:

```text
/data/agents/<agent-id>/.omp/
```

An adapter bound to that agent uses an OMP child with:

```text
cwd=/data/agents/<agent-id>
```

OMP discovers the agent's project-level instructions, configuration,
subagents, commands, extensions, skills, and tools from that cwd. These
internal paths are the packaged form of the visible agent root; the source
tree itself never contains a `.omp/` directory.

The image is authoritative for the internal `.omp/` subtree. On every start,
the seeded `/data/agents/<agent-id>/.omp/` subtree is replaced with the baked
copy. Files next to `.omp/` in the durable agent workspace are not removed.
Restarting with a rebuilt image therefore updates agent configuration while
preserving working files and sessions elsewhere under `/data`.

If an adapter names an agent directory that was not baked into the image, the
container fails before accepting traffic and reports the adapter ID, agent ID,
and expected path.

## Bundled adapters and explicit registrations

`OMP_BUNDLER_ADAPTER` selects the one adapter process supervised beside core:

- `http` (default) registers every agent baked into the image and exposes the
  session-oriented HTTP API.
- `pumble` starts the Pumble bridge and uses `PUMBLE_AGENT_ID` to bind one
  Pumble application to one baked agent.

When `OMP_ADAPTERS` is unset, the entrypoint synthesizes registrations for the
selected mode. In HTTP mode each agent receives its own internal adapter ID,
callback path, and an ephemeral core shared secret. In Pumble mode the
registration uses the generated Pumble fields.

Advanced deployments may provide `OMP_ADAPTERS` directly. In a Docker
`--env-file`, write the complete JSON array on one line without shell quotes.
An HTTP registration callback includes its agent ID:

```env
OMP_ADAPTERS=[{"adapterId":"http-my-agent","callbackUrl":"http://127.0.0.1:8765/core/events/my-agent","sharedSecret":"first-secret","agentId":"my-agent"},{"adapterId":"http-second-agent","callbackUrl":"http://127.0.0.1:8765/core/events/second-agent","sharedSecret":"second-secret","agentId":"second-agent"}]
```

Then validate and run:

```bash
omp-bundler check --env-file runtime.env
omp-bundler run --env-file runtime.env
```

Each registration binds an adapter callback to an existing filesystem agent.
`OMP_ADAPTERS` never declares agents; direct children of `agentsDir` do that.
`check --env-file` rejects registrations naming any other ID. There is no
`OMP_AGENTS` variable.

The selected bundled process is the only adapter process started by the image.
Additional external adapters have their own deployment and credentials.

## CLI reference

```text
omp-bundler new <path> [--agent <agent-id>] [--dry-run]

omp-bundler generate agent <agent-id> [--dry-run]
omp-bundler generate skill <agent-id> <name> [--dry-run]
omp-bundler generate command <agent-id> <name> [--dry-run]
omp-bundler generate tool <agent-id> <name> [--dry-run]
omp-bundler generate extension <agent-id> <name> [--dry-run]
omp-bundler generate subagent <agent-id> <name> [--dry-run]
omp-bundler generate adapter <adapter-type> --agent <agent-id> [--dry-run]

omp-bundler destroy agent <agent-id> [--dry-run] [--yes]
omp-bundler destroy skill <agent-id> <name> [--dry-run] [--yes]
omp-bundler destroy command <agent-id> <name> [--dry-run] [--yes]
omp-bundler destroy tool <agent-id> <name> [--dry-run] [--yes]
omp-bundler destroy extension <agent-id> <name> [--dry-run] [--yes]
omp-bundler destroy subagent <agent-id> <name> [--dry-run] [--yes]

omp-bundler migrate visible-layout [bundle-path] [--dry-run] [--yes]
omp-bundler set-model [agent-id] [--wizard]
omp-bundler set-model [agent-id] [--base-url <value>] [--dialect <value>] [--model <value>] [--api-key <value>]
omp-bundler set-model [agent-id] --print-template
omp-bundler agent rename <old-agent-id> <new-agent-id> [--dry-run]

omp-bundler check [bundle-path] [--env-file <path>]
omp-bundler build [bundle-path] [--tag <image-tag>] [--agents <path>]
omp-bundler run [bundle-path] [--env-file <path>] [--image <tag>] [--agents <path>] [--dry-run]
omp-bundler service start [bundle-path] [--env-file <path>] [--image <tag>] [--agents <path>] [--dry-run]
omp-bundler service stop [bundle-path]
omp-bundler service status [bundle-path]
omp-bundler service restart [bundle-path]
```

Every command supports `--help`. Generators support `--dry-run` and refuse to
overwrite existing files. Destructive commands require confirmation unless
`--yes` is supplied.

## Terminal chat client (`omp-tui`)

A small terminal chat client is available under `tools/omp-tui`. It talks to
one already-running omp-bundler HTTP agent using only that agent's URL.

```bash
cd tools/omp-tui
go build -o omp-tui .
./omp-tui http://localhost:8765/v1/agents/my-agent
```

The URL identifies exactly one agent. Each program launch starts a fresh
server-side conversation; there is no resume or local history. Requests are
synchronous with a spinner until the agent turn completes, and streaming is
not currently supported.

Optional Bearer authentication can be supplied through the environment without
putting the token in the command arguments:

```bash
OMP_HTTP_API_TOKEN=... ./omp-tui http://localhost:8765/v1/agents/my-agent
```

Keys: Enter sends a message, Ctrl+J inserts a newline, PgUp/PgDn scroll the
transcript, and Ctrl+C quits. See `tools/omp-tui/DESIGN.md` for the full
design contract.