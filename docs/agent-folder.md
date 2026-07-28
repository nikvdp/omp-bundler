# Agent folder discovery mapping

This document maps each directory and file inside the `template/` agent
folder to the OMP loader that finds it. The container installs this folder as
`$HOME/.omp/agent`, OMP's default agent directory.
 
OMP 17.1.3 does not apply `OMP_AGENT_DIR` consistently to task-agent
discovery: config, extensions, and tools follow it, but task agents still load
from `$HOME/.omp/agent/agents`. Installing the folder at the default location
keeps every discovery surface on one root without explicit extension paths.

## Directory layout

```
template/
  AGENTS.md                      instructions every session loads
  config.yml                     model roles, providers, settings
  models.yml.tmpl                rendered to models.yml at container start
  agents/
    reviewer-lite.md             spawnable subagent definition
  commands/
    status.md                   slash command (expands to /status)
  extensions/
    session-banner.ts           TypeScript extension (hooks + commands)
  skills/
    hello-agent-folder/
      SKILL.md                   skill discovered via skill://hello-agent-folder
  tools/
    workspace_info.ts            custom tool factory
```

## Discovery mapping

| Path                              | Loader                                         | Effect                                                   |
| --------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `AGENTS.md`                       | `discoverContextFiles`                         | Loaded as session instructions.                          |
| `config.yml`                      | `loadSettings`                                 | Parsed for `modelRoles`, `enabledModels`, `disabledProviders`, provider order, and tags. |
| `models.yml.tmpl`                 | Container entrypoint renderer                  | `${VAR}` placeholders resolve against container env before `ModelRegistry.create` loads the resulting `models.yml`. |
| `agents/*.md`                     | `discoverAgents`                               | Each markdown file's frontmatter (`name`, `description`, `tools`, `spawns`) registers a spawnable subagent. |
| `commands/*.md`                   | `discoverSlashCommands`                        | Frontmatter `description` plus body becomes a slash command. `status.md` becomes `/status`. |
| `extensions/*.ts`                 | `discoverExtensions`                           | Default export is a factory `(pi: ExtensionAPI) => void` called at startup; hooks and commands register here. |
| `skills/*/SKILL.md`               | `discoverSkills`                               | Frontmatter `name` plus body; resolvable as `skill://<name>`. |
| `tools/*.ts`                      | `discoverAndLoadCustomTools`                   | Default export is a `CustomToolFactory` returning a tool definition and `execute` handler. |

## Smoke checklist

Install or link `template/` at `$HOME/.omp/agent`, then start OMP and confirm:

- `skill://hello-agent-folder` resolves and the skill appears in
  discovered skills.
- The `workspace_info` custom tool is callable.
- The `reviewer-lite` subagent is spawnable via the task tool.
- The `session-banner` extension registers the `/agent-folder-status`
  command and greets on `session_start`.
- `/status` (from `commands/status.md`) expands.
- `config.yml` and the rendered `models.yml` are picked up for model
  roles and provider credentials.

These mirror the confirmation list in `template/AGENTS.md`.