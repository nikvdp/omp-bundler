# Agent folder discovery

The container installs one agent definition at `$HOME/.omp/agent`, OMP's
default agent directory, and does not set `OMP_AGENT_DIR`.

## Why one directory

OMP 17.1.3 applies `OMP_AGENT_DIR` to some loaders and not others:

| Follows `OMP_AGENT_DIR` | Ignores it, uses `$HOME/.omp/agent` |
| --- | --- |
| `AGENTS.md` | custom tools |
| `config.yml` | extensions |
| skills | model catalog (`models.yml`) |
| | task agents (`agents/`) |

Pointing `OMP_AGENT_DIR` at a second directory therefore splits the definition
in half. The dangerous part is how it fails: instructions and skills still
resolve, so the agent answers normally while silently missing every custom
tool, its extensions, and its models. Nothing errors.

Installing the whole definition at the default location removes the question.
Every loader resolves the same tree whether or not it honors the variable.

## Layout

The entrypoint copies the refreshed definition from `/data/agent/.omp` to
`$HOME/.omp/agent` on every start:

```text
$HOME/.omp/agent/
  AGENTS.md          session instructions
  config.yml         model roles and settings
  models.yml         rendered from the baked template at boot
  agents/            task agents (staged from the bundle's subagents/)
  commands/          slash commands
  extensions/        TypeScript extensions
  skills/            skills, resolvable as skill://<name>
  tools/             custom tools
  sessions -> /data/sessions
```

This directory is on the ephemeral container layer, never `/data`, so the
rendered catalog and its credentials do not persist. Sessions are symlinked
onto the durable volume.

## Regression guard

`packages/cli/test/cli.test.mjs`, in the entrypoint test, asserts that a staged
tool and extension arrive in `$HOME/.omp/agent` and that no second agent
directory exists. Those assertions fail if the definition is ever split again.
