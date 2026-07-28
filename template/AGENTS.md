# Agent folder sample

This is a working OMP agent-directory sample, not just a folder layout
described in prose. The container installs this directory as
`$HOME/.omp/agent` so every OMP discovery surface uses the same root.
No extension flag or `-e` path is required; discovery is the entire mechanism.

Start OMP with this folder installed at `$HOME/.omp/agent` and confirm:

- `skill://hello-agent-folder` resolves and the skill shows up in
  discovered skills.
- The `workspace_info` custom tool is callable.
- The `reviewer-lite` subagent is spawnable via the task tool.
- The `session-banner` extension registers the `/agent-folder-status`
  command and greets on `session_start`.
- `/status` (from `commands/status.md`) expands.
- `config.yml` and the rendered `models.yml` are picked up for model
  roles and provider credentials.

See `docs/agent-folder.md` in the repo root for the full mapping from
each directory to the OMP discovery function that finds it.
