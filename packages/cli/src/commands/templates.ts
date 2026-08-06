import { emptyModelCatalog } from "../model-config.ts";
import type { PlannedWrite } from "../types.ts";

export const AGENT_SURFACE_DIRECTORIES = [
  "subagents",
  "commands",
  "extensions",
  "skills",
  "tools",
] as const;

export const PUMBLE_RUNTIME_FIELDS = [
  "PUMBLE_APP_ID",
  "PUMBLE_APP_CLIENT_SECRET",
  "PUMBLE_APP_KEY",
  "PUMBLE_APP_SIGNING_SECRET",
  "PUMBLE_PUBLIC_BASE_URL",
  "PUMBLE_CORE_SHARED_SECRET",
] as const;

/**
 * Fresh runtime.env.example for a default HTTP bundle. Compact and
 * self-explaining: one comment, the adapter mode, a blank line, and the
 * optional HTTP Bearer token. No auth-broker or Pumble fields — those are
 * opt-in sections generated on request.
 */
export const RUNTIME_ENV_EXAMPLE = runtimeEnvExample();

/** Compact, commented fresh runtime.env.example for the default HTTP path. */
export function runtimeEnvExample(): string {
  const lines = [
    "# Bundled adapter. HTTP serves the agent API and built-in terminal chat.",
    "OMP_BUNDLER_ADAPTER=http",
    "",
    "# Optional Bearer token for the public HTTP endpoint. Leave empty only on trusted localhost.",
    "OMP_HTTP_API_TOKEN=",
  ];
  return `${lines.join("\n")}\n`;
}

/** Heading for the generated provider credential block. */
export const MODEL_ENV_HEADING =
  "# Model provider credentials. Copy this file to runtime.env and fill these values.";

/** Comment heading that marks the generated Pumble adapter block. */
export const PUMBLE_ENV_HEADING =
  "# Pumble adapter. Fill these values from the Pumble app dashboard, then run the bundle.";

export function bundleFiles(bundleName: string, agentId: string): readonly PlannedWrite[] {
  return [
    { path: ".gitignore", content: "runtime.env\n" },
    { path: "README.md", content: bundleReadme(bundleName, agentId) },
    { path: "omp-bundler.yml", content: bundleConfig(bundleName, agentId) },
    { path: "runtime.env.example", content: RUNTIME_ENV_EXAMPLE },
    { path: "models.yml", content: emptyModelCatalog() },
  ];
}

export function agentScaffoldFiles(agentId: string): readonly PlannedWrite[] {
  return [
    {
      path: "AGENTS.md",
      content: `# ${agentId}\n\nYou are the ${agentId} agent.\n\n## Instructions\n\n- Read the available context before acting.\n- Use tools when they improve correctness.\n- State uncertainty directly.\n`,
    },
    {
      path: "config.yml",
      content: "setupVersion: 1\n\n# Add agent-local OMP settings here.\n",
    },
    {
      path: "subagents/example-subagent.md.example",
      content: exampleSubagentTemplate(),
    },
    {
      path: "commands/example-command.md.example",
      content: exampleCommandTemplate(),
    },
    {
      path: "extensions/example-extension.ts.example",
      content: exampleExtensionTemplate(),
    },
    {
      path: "skills/example-skill/SKILL.md.example",
      content: exampleSkillTemplate(),
    },
    {
      path: "tools/example-tool.ts.example",
      content: exampleToolTemplate(),
    },
    {
      path: "schedules/example-schedule.yml.example",
      content: exampleScheduleTemplate(),
    },
  ];
}

export type ComponentKind = "skill" | "command" | "tool" | "extension" | "subagent";

export function componentFile(
  kind: ComponentKind,
  name: string,
): PlannedWrite {
  if (kind === "skill") {
    return {
      path: `skills/${name}/SKILL.md`,
      content: skillTemplate(name),
    };
  }
  if (kind === "command") {
    return {
      path: `commands/${name}.md`,
      content: commandTemplate(name),
    };
  }
  if (kind === "tool") {
    return {
      path: `tools/${name}.ts`,
      content: toolTemplate(name),
    };
  }
  if (kind === "extension") {
    return {
      path: `extensions/${name}.ts`,
      content: extensionTemplate(name),
    };
  }
  return {
    path: `subagents/${name}.md`,
    content: subagentTemplate(name),
  };
}

function bundleReadme(bundleName: string, agentId: string): string {
  return `# ${bundleName}

This bundle contains one filesystem-configured OMP agent (${agentId}).

## Agent source

Agent instructions and every supported component surface live at the bundle root:

\`\`\`text
AGENTS.md
config.yml
models.yml
subagents/example-subagent.md.example
commands/example-command.md.example
extensions/example-extension.ts.example
skills/example-skill/SKILL.md.example
tools/example-tool.ts.example
schedules/example-schedule.yml.example
\`\`\`

The \`.example\` suffix keeps each starter inactive. Use the matching generator
to create an active component:

\`\`\`bash
omp-bundler generate subagent researcher
omp-bundler generate command summarize
omp-bundler generate extension lifecycle-log
omp-bundler generate skill meeting-notes
omp-bundler generate tool read-transcript
\`\`\`

## Schedules (cron)

Run the agent on a timer with a schedule file under \`schedules/\`. Each active
\`*.yml\` file runs its \`prompt\` in a fresh OMP session on its cron schedule and
writes the reply to \`/data/cron/jobs/<job-id>/runs/\`. The \`.example\` suffix
keeps a schedule inert, so a fresh bundle starts with cron off; rename
\`schedules/example-schedule.yml.example\` or generate a new schedule to turn the
runner on automatically:

\`\`\`bash
omp-bundler generate schedule daily-summary
\`\`\`

## Development loop

1. Edit \`AGENTS.md\` and generate or edit components under the bundle root.
2. Add models with \`omp-bundler model add <provider/model>\`, then choose the default with \`omp-bundler model set-default <provider/model>\`.
3. Copy \`runtime.env.example\` to the ignored \`runtime.env\` file and fill its generated placeholders.
4. Run \`omp-bundler check\` and \`omp-bundler build\`, then start the background service with \`omp-bundler start\`. Use \`omp-bundler run --foreground\` when the process should own the terminal. Both select \`runtime.env\` and free host ports automatically.
5. Inspect the service with \`omp-bundler status\`, follow it with \`omp-bundler logs --follow\`, and chat with \`omp-bundler tui\`. TUI discovers the live adapter port automatically.

The committed \`runtime.env.example\` contains placeholders only. Keep deployment values in \`runtime.env\`.
`;
}

function bundleConfig(bundleName: string, agentId: string): string {
  return `version: 1\nagent:\n  id: ${agentId}\n\nimage:\n  tag: ${bundleName}:local\n\nrun:\n  dataVolume: ${bundleName}-data\n  corePort: 8787\n  adapterPort: 8765\n`;
}

function exampleSkillTemplate(): string {
  return `---\nname: example-skill\ndescription: A harmless starter skill. Customize before use.\n---\n\n# Example skill\n\nThis example is inactive while it has the .example suffix. Replace this text\nwith the context and procedure this skill should provide.\n`;
}

function exampleCommandTemplate(): string {
  return `---\ndescription: A harmless starter command. Customize before use.\n---\n\nReport that the example command is ready, then replace this body with the\ncommand's actual instructions.\n`;
}

function exampleSubagentTemplate(): string {
  return `---\nname: example-subagent\ndescription: A harmless starter subagent. Customize before use.\ntools: read, grep, glob\nspawns: \"\"\n---\n\nYou are example-subagent. Read the requested context and return a concise\nanswer. Do not edit files until this starter definition is customized.\n`;
}

function exampleExtensionTemplate(): string {
  return `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";\n\n// This starter extension is intentionally inert until customized.\nexport default function exampleExtension(_pi: ExtensionAPI) {\n  // Register hooks or commands here when this extension has a real purpose.\n}\n`;
}

function exampleToolTemplate(): string {
  return `import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";\n\nconst factory: CustomToolFactory = (pi) => ({\n  name: "example_tool",\n  label: "Example Tool",\n  description: "A harmless starter custom tool.",\n  parameters: pi.zod.object({}),\n\n  async execute() {\n    return {\n      content: [{ type: "text", text: "Customize this tool before using it." }],\n    };\n  },\n});\n\nexport default factory;\n`;
}

export function scheduleFile(name: string): PlannedWrite {
  return { path: `schedules/${name}.yml`, content: scheduleTemplate(name) };
}

export function exampleScheduleTemplate(): string {
  return [
    "# Cron schedule. This example is inert while it has the .example suffix.",
    "# Rename to example-schedule.yml (drop .example) to activate it.",
    "# The agent runs `prompt` in a fresh OMP session on this schedule and writes",
    "# its output to /data/cron/jobs/<job-id>/ for the agent to read.",
    "schedule: \"0 9 * * 1-5\"",
    "timezone: UTC",
    "missed: skip",
    "prompt: \"Summarize today's meetings and post the summary.\"",
    "",
  ].join("\n");
}

export function scheduleTemplate(name: string): string {
  return [
    `# Cron schedule for ${name}. Edit the fields below.`,
    "# schedule: 5-field cron expression (minute hour day month weekday).",
  "# timezone: IANA timezone (e.g. America/New_York). Defaults to UTC.",
  "# missed: skip (advance to next fire time) or catchUp (fire for missed intervals).",
  "# prompt: the user message sent to the agent each run.",
  'schedule: "0 9 * * 1-5"',
  "timezone: UTC",
  "missed: skip",
  "prompt: |",
  `  Replace this with the prompt ${name} should run on schedule.`,
  "",
  ].join("\n");
}

function skillTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: Starter skill for ${name}. Customize before use.\n---\n\n# ${name}\n\nDescribe the context and procedure that ${name} should provide.\n`;
}

function commandTemplate(name: string): string {
  return `---\ndescription: Starter command for ${name}. Customize before use.\n---\n\nExplain the steps for the /${name} command here.\n`;
}

function toolTemplate(name: string): string {
  const toolName = name.replaceAll("-", "_");
  return `import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";\n\nconst factory: CustomToolFactory = (pi) => ({\n  name: ${JSON.stringify(toolName)},\n  label: ${JSON.stringify(name)},\n  description: ${JSON.stringify(`Starter tool for ${name}. Customize before use.`)},\n  parameters: pi.zod.object({}),\n\n  async execute() {\n    return {\n      content: [{ type: "text", text: ${JSON.stringify(`The ${name} tool is not customized yet.`)} }],\n    };\n  },\n});\n\nexport default factory;\n`;
}

function extensionTemplate(name: string): string {
  return `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";\n\n// The ${name} extension performs no external work until customized.\nexport default function generatedExtension(_pi: ExtensionAPI) {\n  // Register hooks or commands for ${name} here.\n}\n`;
}

function subagentTemplate(name: string): string {
  return `---\nname: ${name}\ndescription: Starter subagent for ${name}. Customize before use.\ntools: read, grep, glob\nspawns: \"\"\n---\n\nYou are ${name}. Read the requested context and return a concise answer.\nCustomize this task-agent definition before relying on it.\n`;
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Detected line ending: CRLF if any present, else LF. */
function detectEol(source: string): string {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Replace or append one managed env block identified by an exact comment
 * `heading`. The block is the heading line plus consecutive `NAME[=value]`
 * assignment rows. When `assignments` is empty the block is removed. Lines
 * outside the block — including unrelated comments, model blocks, and the
 * adapter mode line — are preserved verbatim. Idempotent.
 */
export function updateManagedEnvBlock(
  source: string,
  heading: string,
  assignments: readonly string[],
): string {
  for (const assignment of assignments) {
    const name = assignment.slice(0, assignment.indexOf("="));
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid generated env name: ${name}`);
  }
  const eol = detectEol(source);
  const lines = source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const sorted = [...assignments].sort((left, right) => left.localeCompare(right));

  const start = lines.indexOf(heading);
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length) {
      const body = lines[end];
      if (body.trim() === "" || body.trimStart().startsWith("#")) break;
      if (!/^\s*[A-Z_][A-Z0-9_]*\s*=/.test(body)) break;
      end += 1;
    }
    if (sorted.length === 0) {
      let removeEnd = end;
      if (removeEnd < lines.length && lines[removeEnd].trim() === "") removeEnd += 1;
      lines.splice(start, removeEnd - start);
    } else {
      lines.splice(start, end - start, heading, ...sorted);
    }
    return lines.length > 0 ? `${lines.join(eol)}${eol}` : "";
  }

  if (sorted.length === 0) return source;
  if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
  lines.push(heading, ...sorted);
  return `${lines.join(eol)}${eol}`;
}

/** Synchronize the provider credential block with placeholders used by models.yml. */
export function updateModelEnvBlock(
  source: string,
  envNames: readonly string[],
): string {
  const eol = detectEol(source);
  const lines = source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!MODEL_ENV_HEADING_RE.test(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && ENV_ASSIGNMENT_RE.test(lines[end])) end += 1;
    if (end < lines.length && lines[end].trim() === "") end += 1;
    lines.splice(index, end - index);
  }
  const cleaned = lines.length > 0 ? `${lines.join(eol)}${eol}` : "";
  return updateManagedEnvBlock(
    cleaned,
    MODEL_ENV_HEADING,
    [...new Set(envNames)].sort().map((name) => `${name}=`),
  );
}

/** Canonical Pumble adapter assignments, in declaration order. */
const PUMBLE_BLOCK_FIELDS = PUMBLE_RUNTIME_FIELDS;
const MODEL_ENV_HEADING_RE =
  /^(?:# Model provider credentials\. Copy this file to runtime\.env and fill these values\.|# Model connection for [a-z0-9][a-z0-9_-]{0,63}\. Copy this file to runtime\.env and fill these values\.)$/;
const ENV_ASSIGNMENT_RE = /^\s*[A-Z_][A-Z0-9_]*\s*=/;

function managedModelBlockLines(lines: readonly string[]): ReadonlySet<number> {
  const protectedLines = new Set<number>();
  for (let start = 0; start < lines.length; start += 1) {
    if (!MODEL_ENV_HEADING_RE.test(lines[start])) continue;
    protectedLines.add(start);
    for (let index = start + 1; index < lines.length && ENV_ASSIGNMENT_RE.test(lines[index]); index += 1) {
      protectedLines.add(index);
    }
  }
  return protectedLines;
}

/** Switch to Pumble and maintain a generated block without deployed-agent ids. */
export function updatePumbleBlock(source: string): string {
  const eol = detectEol(source);
  const lines = source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const protectedModelLines = managedModelBlockLines(lines);
  const knownValues = new Map<string, string>();
  for (const field of PUMBLE_BLOCK_FIELDS) {
    for (let index = 0; index < lines.length; index += 1) {
      if (protectedModelLines.has(index)) continue;
      const line = lines[index];
      if (new RegExp(`^\\s*${field}\\s*=`).test(line)) {
        const value = line.slice(line.indexOf("=") + 1);
        if (value.trim() !== "" && !knownValues.has(field)) knownValues.set(field, value);
      }
    }
  }

  const blockStart = lines.indexOf(PUMBLE_ENV_HEADING);
  let blockEnd = blockStart;
  if (blockStart >= 0) {
    blockEnd = blockStart + 1;
    while (blockEnd < lines.length) {
      const body = lines[blockEnd];
      if (body.trim() === "" || body.trimStart().startsWith("#")) break;
      if (!/^\s*(?:OMP_BUNDLER_ADAPTER|PUMBLE_[A-Z0-9_]*)\s*=/.test(body)) break;
      blockEnd += 1;
    }
  }
  const filtered: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (protectedModelLines.has(index) || (index >= blockStart && index < blockEnd)) {
      filtered.push(lines[index]);
      continue;
    }
    const line = lines[index];
    if (/^\s*PUMBLE_AGENT_ID\s*=/.test(line)) continue;
    const match = line.match(/^\s*(PUMBLE_[A-Z0-9_]*)\s*=/);
    if (match && (PUMBLE_RUNTIME_FIELDS as readonly string[]).includes(match[1])) continue;
    filtered.push(line);
  }

  const filteredModelLines = managedModelBlockLines(filtered);
  let adapterFound = false;
  for (let index = 0; index < filtered.length; index += 1) {
    if (filteredModelLines.has(index) || !/^\s*OMP_BUNDLER_ADAPTER\s*=/.test(filtered[index])) continue;
    adapterFound = true;
    filtered[index] = `${filtered[index].slice(0, filtered[index].indexOf("=") + 1)}pumble`;
  }
  if (!adapterFound) filtered.unshift("OMP_BUNDLER_ADAPTER=pumble");

  const block = [
    PUMBLE_ENV_HEADING,
    ...PUMBLE_RUNTIME_FIELDS.map((field) => `${field}=${knownValues.get(field) ?? ""}`),
  ];
  const headingIndex = filtered.indexOf(PUMBLE_ENV_HEADING);
  if (headingIndex >= 0) {
    let existingEnd = headingIndex + 1;
    while (existingEnd < filtered.length) {
      const body = filtered[existingEnd];
      if (body.trim() === "" || body.trimStart().startsWith("#")) break;
      if (!/^\s*(?:OMP_BUNDLER_ADAPTER|PUMBLE_[A-Z0-9_]*)\s*=/.test(body)) break;
      existingEnd += 1;
    }
    filtered.splice(headingIndex, existingEnd - headingIndex, ...block);
  } else {
    if (filtered.length > 0 && filtered[filtered.length - 1].trim() !== "") filtered.push("");
    filtered.push(...block);
  }
  const result = filtered.length > 0 ? `${filtered.join(eol)}${eol}` : "";
  return result === source ? source : result;
}

/** Set the generated bundled-adapter selection without touching model blocks. */
export function setBundledAdapter(source: string, adapter: "http" | "pumble"): string {
  const eol = detectEol(source);
  const lines = source.split(/\r?\n/);
  const hadFinalEol = lines.length > 0 && lines[lines.length - 1] === "";
  if (hadFinalEol) lines.pop();
  const protectedModelLines = managedModelBlockLines(lines);
  let found = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (protectedModelLines.has(index) || !/^\s*OMP_BUNDLER_ADAPTER\s*=/.test(lines[index])) continue;
    found = true;
    lines[index] = `${lines[index].slice(0, lines[index].indexOf("=") + 1)}${adapter}`;
  }
  if (!found) lines.unshift(`OMP_BUNDLER_ADAPTER=${adapter}`);
  return `${lines.join(eol)}${hadFinalEol || lines.length > 0 ? eol : ""}`;
}
