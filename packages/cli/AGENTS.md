# CLI configuration design

These rules apply to `packages/cli` and its generated bundle files.

- Keep command concepts grouped: model catalog operations live under `model`, while service lifecycle commands stay flat.
- `models.yml` is the native, user-owned OMP catalog. Never derive it from a second model schema.
- `model add` is additive: preserve unrelated providers and models, and never change the default selection implicitly.
- `model set-default` owns only `config.yml`'s `modelRoles.default` binding and must reject selectors absent from `models.yml`.
- Generated YAML must remain ordinary and directly editable without the CLI.
- Accept literal values and `${ENV_VAR}` templates wherever native OMP supports them. Recommend provider-scoped environment variables for secrets and always redact secret values from output and errors.
- Make `runtime.env.example` compact and self-explaining. Enable only the default HTTP path, add only placeholders referenced by `models.yml`, and keep adapters such as Pumble in explicit opt-in sections.
- Preserve the one-bundle/one-agent contract: infer the root bundle from the current directory or one explicit bundle path.
- Help, validation, and completion must come from the maintained CLI command tree rather than parallel handwritten grammars.
