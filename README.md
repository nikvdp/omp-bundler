# omp-bundler

Build and run filesystem-configured OMP agents as a durable service.

> **Implementation status:** This README is the product contract for the new
> `omp-bundler` CLI. The CLI described below is the target interface and is
> being implemented through README-driven development.

An agent is a directory containing an OMP project-level `.omp/` folder. The
filesystem is the source of truth: add an agent directory to add an agent,
rename the directory to rename it, and remove the directory to remove it.
There is no agent registry and no agent-list environment variable.

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

Docker is required to build and run images. Model and adapter credentials are
not required until runtime.

## Quick start

Create a bundle with its first agent:

```bash
omp-bundler new my-bundle --agent my-agent
cd my-bundle
```

Edit the generated instructions:

```bash
$EDITOR agents/my-agent/.omp/AGENTS.md
```

Check and build the bundle:

```bash
omp-bundler check
omp-bundler build
```

To connect a Pumble application to the agent, generate its runtime template:

```bash
omp-bundler generate adapter pumble --agent my-agent
cp runtime.env.example runtime.env
$EDITOR runtime.env
```

Run the bundle:

```bash
omp-bundler run --env-file runtime.env
```

The complete development loop is:

```text
new or generate -> edit -> check -> build -> run
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
        └── .omp/
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

The `.example` files are complete, valid templates. OMP ignores the `.example`
suffix, so they have no runtime effect. The `check` command still validates
them. The preferred activation path is the corresponding generator. To
activate a customized example directly, copy it without the final `.example`
suffix. For example:

```bash
cp agents/my-agent/.omp/tools/example-tool.ts.example \
  agents/my-agent/.omp/tools/example-tool.ts
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

This creates the same full `.omp/` tree produced by `new --agent`. Generation
fails rather than overwriting an existing agent.

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

The generated `config.yml` is also valid and inherits the bundle's shared OMP
model selection:

```yaml
setupVersion: 1
```

It contains comments showing where model roles and other agent-local OMP
settings belong, but it does not select a machine-specific provider.

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
agents/my-agent/.omp/skills/knowledge-base/SKILL.md
```

### Command

```bash
omp-bundler generate command my-agent summarize
```

Creates:

```text
agents/my-agent/.omp/commands/summarize.md
```

### Tool

```bash
omp-bundler generate tool my-agent lookup-record
```

Creates:

```text
agents/my-agent/.omp/tools/lookup-record.ts
```

The generated tool contains a valid typed registration and a harmless example
implementation. It loads successfully before being customized.

### Extension

```bash
omp-bundler generate extension my-agent lifecycle-log
```

Creates:

```text
agents/my-agent/.omp/extensions/lifecycle-log.ts
```

The generated extension loads successfully but performs no external work until
its example hook is customized.

### OMP subagent

```bash
omp-bundler generate subagent my-agent researcher
```

Creates:

```text
agents/my-agent/.omp/agents/researcher.md
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

## Select an agent model

Agents inherit the shared OMP model selection unless explicitly configured.
Set an agent's default model with:

```bash
omp-bundler agent model my-agent anthropic/claude-sonnet-4-5
```

This updates only:

```text
agents/my-agent/.omp/config.yml
```

Result:

```yaml
setupVersion: 1
modelRoles:
  default: anthropic/claude-sonnet-4-5
```

The model name belongs in agent configuration. Provider credentials do not.

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

The command performs only these source-tree changes:

1. Moves `agents/my-agent/` to `agents/renamed-agent/`.
2. Updates `PUMBLE_AGENT_ID` in the committed `runtime.env.example` when that
   generated field names the old agent.
3. Reports any other project-owned text reference it cannot update safely.

It does not edit ignored `runtime.env` files, rewrite JSON inside
`OMP_ADAPTERS`, rebuild an existing image, rename durable
`/data/agents/my-agent` state, or change a running container.

Before the next run:

```bash
$EDITOR runtime.env
omp-bundler check --env-file runtime.env
omp-bundler build
omp-bundler run --env-file runtime.env
```

Change every runtime `PUMBLE_AGENT_ID` or `OMP_ADAPTERS` `agentId` reference
from `my-agent` to `renamed-agent`. Rebuilding is required because existing
images retain the old baked directory.

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
Removing source files does not delete Docker volumes, sessions, or remote
resources.

An already-built image is immutable and still contains any agent or component
that was present when it was built. Rebuild after a destroy operation to
remove the source from future containers. Destroy does not edit ignored
runtime bindings; update or remove bindings to a destroyed agent before the
next run.

Durable `/data/agents/<agent-id>` files are also preserved. A destroyed agent
no longer receives traffic after its bindings are removed and the image is
rebuilt, but deleting its durable data is a separate operator action.

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
- Every required `.omp/` directory
- Active components and ignored `.example` templates
- OMP YAML and Markdown frontmatter
- TypeScript extension and tool entrypoints
- Duplicate component names
- Accidental credentials or generated runtime state in agent source
- Adapter-to-agent bindings when a runtime env file is supplied

Supply runtime configuration for binding validation:

```bash
omp-bundler check --env-file runtime.env
```

With `--env-file`, `check` parses `PUMBLE_AGENT_ID` and every
`OMP_ADAPTERS[].agentId`, then verifies that each referenced ID is a direct
child of the effective agent collection.

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
contain a valid `.omp/` scaffold. The override receives the same validation as
the configured collection. A missing path, a file instead of a directory, or
an invalid child fails before Docker runs.

The build command:

1. Runs the structural, source, and credential-leak checks performed by
   `check` without `--env-file`. Build never reads runtime configuration.
2. Resolves the effective collection from `--agents`, when supplied, or
   `agentsDir` otherwise.
3. Discovers every direct child of that effective collection.
4. Stages the shared omp-bundler runtime.
5. Bakes each agent's `.omp/` folder under `/agents/<agent-id>/.omp/`.
6. Builds the Docker image.
7. Reports the image tag and included agent IDs.

Building requires Docker. It does not contact model providers or adapters.

The build does not require or read:

- Model-provider API keys
- Private provider base URLs
- OMP auth broker credentials
- Pumble credentials
- Adapter shared secrets
- `OMP_ARGS`
- `OMP_ADAPTERS`
- `OMP_AGENTS`

Provider-specific variables such as `CLIPROXY_BASE_URL`, `custom-provider_BASE_URL`,
or their API keys are not part of the standard build interface. A deployment
that deliberately uses a private provider supplies its configuration at
runtime, not while building the image.

## Runtime configuration

`new` creates `runtime.env.example` with the standard authentication fields:

```env
OMP_AUTH_BROKER_URL=
OMP_AUTH_BROKER_TOKEN=
```

The documented standard runtime uses the OMP auth broker, so both values are
required when running the bundle. They must identify a broker reachable from
inside the container. Agent files select models but never contain
credentials.

Generate an adapter template before making a local runtime file. For Pumble:

```bash
omp-bundler generate adapter pumble --agent my-agent
cp runtime.env.example runtime.env
```

Fill `runtime.env` with deployment values. It is ignored by Git.

Direct provider credentials are an alternative advanced authentication mode,
not an addition to the standard broker mode. Their names depend on the
selected OMP provider, so there is no universal list of provider-key variables.
They remain runtime inputs and are never build inputs.

## Run

Run the current bundle with an explicit runtime env file:

```bash
omp-bundler run --env-file runtime.env
```

The command uses the image tag, ports, and data volume from
`omp-bundler.yml`. It validates runtime adapter bindings before starting the
container, streams logs, and forwards termination signals.

Run a bundle from another directory:

```bash
omp-bundler run ../another-bundle --env-file ../another-bundle/runtime.env
```

Override the image:

```bash
omp-bundler run --image registry.example.com/my-bundle:2026-08-01 \
  --env-file runtime.env
```

Preview the Docker invocation:

```bash
omp-bundler run --env-file runtime.env --dry-run
```

The equivalent direct Docker shape is:

```bash
docker run --rm \
  -p 8787:8787 \
  -p 8765:8765 \
  -v my-bundle-data:/data \
  --env-file runtime.env \
  my-bundle:local
```

No `OMP_ARGS` value is required for normal operation. Flags such as
`--no-tools` and short `--max-time` values belong to deliberate diagnostics,
not the default runtime instructions.

## Filesystem behavior at startup

The image contains each agent at:

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
subagents, commands, extensions, skills, and tools from that cwd.

The image is authoritative for `.omp/`. On every start, the seeded
`/data/agents/<agent-id>/.omp/` subtree is replaced with the baked copy. Files
next to `.omp/` in the durable agent workspace are not removed. Restarting
with a rebuilt image therefore updates agent configuration while preserving
working files and sessions elsewhere under `/data`.

If an adapter names an agent directory that was not baked into the image, the
container fails before accepting traffic and reports the adapter ID, agent ID,
and expected path.

## Multiple adapters

`PUMBLE_AGENT_ID` covers the common case of one bundled Pumble application
routed to one agent.

The two modes are mutually exclusive. When `OMP_ADAPTERS` is unset, the
entrypoint synthesizes the single bundled Pumble registration using
`PUMBLE_AGENT_ID`. When `OMP_ADAPTERS` is set, that explicit array is
authoritative and no registration is synthesized from `PUMBLE_AGENT_ID`.

Use runtime `OMP_ADAPTERS` when core must accept registrations from multiple
adapter instances or custom adapters. In a Docker `--env-file`, write the
entire JSON array on one line with no surrounding shell quotes:

```env
OMP_ADAPTERS=[{"adapterId":"first-adapter","callbackUrl":"http://127.0.0.1:8765/core/events","sharedSecret":"first-secret","agentId":"my-agent"},{"adapterId":"second-adapter","callbackUrl":"http://127.0.0.1:8765/core/events","sharedSecret":"second-secret","agentId":"second-agent"}]
```

Then validate and run it:

```bash
omp-bundler check --env-file runtime.env
omp-bundler run --env-file runtime.env
```

Each registration binds an already-running adapter instance to a
filesystem-defined agent. Platform-specific credentials configure those
adapter processes separately. The generated Pumble fields configure the one
bundled Pumble adapter; they do not create multiple Pumble applications.

The omp-bundler image starts the one bundled Pumble adapter. Deploying
additional platform adapter processes, including another Pumble application,
is outside the `omp-bundler run` command; those processes have their own
platform-specific startup and credential configuration.

`OMP_ADAPTERS` belongs in runtime deployment configuration. It does not
declare agents. The direct children of `agentsDir` declare agents, and
`check --env-file` rejects registrations that name any other ID. There is no
`OMP_AGENTS` variable.

## CLI reference

```text
omp-bundler new <path> [--agent <agent-id>]

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

omp-bundler agent model <agent-id> <provider/model>
omp-bundler agent rename <old-agent-id> <new-agent-id>

omp-bundler check [bundle-path] [--env-file <path>]
omp-bundler build [bundle-path] [--tag <image-tag>] [--agents <path>]
omp-bundler run [bundle-path] --env-file <path> [--image <tag>] [--dry-run]
```

Every command supports `--help`. Generators support `--dry-run` and refuse to
overwrite existing files. Destructive commands require confirmation unless
`--yes` is supplied.