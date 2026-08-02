# CLI configuration design

These rules apply to `packages/cli` and its generated bundle files.

- Keep commands verb-first. Interaction styles are modes of an action (`set-model --wizard`), not peer commands (`model-wizard`).
- Model one configuration concept once. A single field schema must drive direct flags, wizard prompts, editor templates, examples, parsing, validation, defaults, and help so those interfaces cannot drift.
- Default configuration commands to `$EDITOR` with a minimal valid, commented file. Keep only essential fields active; omit or comment advanced values when defaults suffice.
- Keep generated YAML ordinary and user-owned. Users must be able to edit it directly without the CLI, print the same template from the CLI, or produce the same result through flags or wizard mode.
- Describe user concepts—base URL, API dialect, model name, and API key. Hide generated provider aliases and other OMP runtime plumbing.
- Accept literal values and `${ENV_VAR}` templates wherever the runtime supports them, including secrets. Recommend environment templates for containers, but never prohibit an intentional literal; always redact secret values from output and errors.
- Make `runtime.env.example` compact and self-explaining. Enable only the default HTTP path, add only placeholders the bundle actually references, and keep platform adapters such as Pumble in explicit opt-in sections generated on request.
- Generate internal runtime configuration at staging time. Do not make users maintain both the user-facing file and an equivalent OMP-native file.
- Preserve one-agent ergonomics: infer the sole agent when unambiguous, and require an explicit agent only when the bundle contains several.
- Every new configuration path must prove equivalence across editor, wizard, flags, and direct-file use, plus safe failure without leaking credentials.
