# omp-bundler product invariants

## One bundle, one complete agent

- One bundle deploys one routable agent with one stable `agent.id`.
- Single-agent means removing the redundant `agents/<agent-id>/` deployment layer. It does not mean removing the OMP component hierarchy.
- The bundle root is the visible agent source: `AGENTS.md`, `config.yml`, `subagents/`, `commands/`, `extensions/`, `skills/`, and `tools/`.
- Docker staging maps root `subagents/` to OMP's internal `.omp/agents/` directory. Do not expose OMP's internal naming in the source layout.

## New bundle discoverability

`omp-bundler new` MUST create the complete root hierarchy and one inert example for every supported component:

```text
AGENTS.md
config.yml
subagents/example-subagent.md.example
commands/example-command.md.example
extensions/example-extension.ts.example
skills/example-skill/SKILL.md.example
tools/example-tool.ts.example
```

The `.example` suffix keeps starter components inactive while making every extension point obvious. `check` must still validate these templates. Never collapse `new` back to a minimal two-file scaffold.

The generated bundle README MUST explain the hierarchy, the inactive example suffix, and the matching `generate` commands. A first-time user should not need prior OMP path knowledge to discover skills, commands, tools, extensions, or subagents.

## Runtime separation

- Image-owned definition: `/agent/id` and `/agent/.omp`.
- Refreshed readable definition: `/data/agent/.omp`.
- Persistent agent cwd: `/data/agent/workspace`.
- OMP's ephemeral discovery directory may materialize the definition, but sessions must remain under `/data` and rendered credentials must not be persisted in the readable definition.
