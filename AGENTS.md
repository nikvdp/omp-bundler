# omp-bundler product invariants

## One bundle, one complete agent

- One bundle deploys one routable agent with one stable `agent.id`.
- Single-agent means removing the redundant `agents/<agent-id>/` deployment layer. It does not mean removing the OMP component hierarchy.
- The bundle root is the visible agent source: `AGENTS.md`, `config.yml`, `models.yml`, `Dockerfile`, `subagents/`, `commands/`, `extensions/`, `skills/`, and `tools/`.
- Docker staging maps root `subagents/` to OMP's internal `.omp/agents/` directory. Do not expose OMP's internal naming in the source layout.

## New bundle discoverability

`omp-bundler new` MUST create the complete root hierarchy and one inert example for every supported component:

```text
AGENTS.md
config.yml
models.yml
Dockerfile
subagents/example-subagent.md.example
commands/example-command.md.example
extensions/example-extension.ts.example
skills/example-skill/SKILL.md.example
tools/example-tool.ts.example
schedules/example-schedule.yml.example
```

The `.example` suffix keeps starter components inactive while making every extension point obvious. `check` must still validate these templates. Never collapse `new` back to a minimal two-file scaffold.

The generated bundle README MUST explain the hierarchy, the inactive example suffix, and the matching `generate` commands. A first-time user should not need prior OMP path knowledge to discover skills, commands, tools, extensions, subagents, or cron schedules. Cron schedules are runtime config, not an OMP component: `new` scaffolds `schedules/example-schedule.yml.example`, staged to `/schedules` (not `.omp/`); each active `*.yml` runs its prompt on its cron schedule and writes output under `/data/cron/jobs/`.

The generated `models.yml` MUST be an empty native OMP provider catalog.
`model add` appends providers and models without changing the default;
`model set-default` changes only `config.yml`. `check` and `build` require the
selected model to exist in the catalog. Model IDs are literal. Provider
`baseUrl` and `apiKey` fields may use runtime `${ENV_VAR}` templates.

## Runtime routing and ports

- `OMP_ADAPTERS` contains exactly one registration, and its `agentId` MUST equal the bundle's configured root `agent.id`.
- Missing, empty, multi-entry, unbound, or mismatched registrations MUST fail before a service appears healthy.
- Configured host ports are preferences. `run` MUST probe them after resolving service conflicts and choose free, distinct alternatives when necessary.
- Running containers MUST carry a stable bundle identity label. Bare `tui` MUST discover the live published adapter port and use configured `adapterPort` only as a fallback.

## Runtime separation

- Image-owned definition: `/agent/id` and `/agent/.omp`.
- Refreshed readable definition: `/data/agent/.omp`.
- Persistent agent cwd: `/data/agent/workspace`.
- OMP's ephemeral discovery directory may materialize the definition, but sessions must remain under `/data` and rendered credentials must not be persisted in the readable definition.
- `omp-bundler.yml` `files:` entries declare env-to-file materialization; `check` validates them; builds bake the manifest as `/agent/files.json`; the entrypoint materializes files before core/adapter/cron start; destinations must stay outside `/data`.
