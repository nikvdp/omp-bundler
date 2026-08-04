import type { PlannedWrite } from "../types.ts";

export const AGENT_SURFACE_DIRECTORIES = [
  "agents",
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

/** Comment heading that marks a generated per-agent model-connection block. */
export function agentModelEnvHeading(agentId: string): string {
  return `# Model connection for ${agentId}. Copy this file to runtime.env and fill these values.`;
}

/** Comment heading that marks the generated Pumble adapter block. */
export const PUMBLE_ENV_HEADING =
  "# Pumble adapter. Fill these values from the Pumble app dashboard, then run the bundle.";

export function bundleFiles(bundleName: string): readonly PlannedWrite[] {
  return [
    { path: ".gitignore", content: "runtime.env\n" },
    { path: "README.md", content: bundleReadme(bundleName) },
    { path: "omp-bundler.yml", content: bundleConfig(bundleName) },
    { path: "runtime.env.example", content: RUNTIME_ENV_EXAMPLE },
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
      content: "setupVersion: 1\n\n# Add agent-local OMP settings here. Shared model selection is inherited.\n# modelRoles:\n#   default: provider/model\n",
    },
    {
      path: "agents/example-subagent.md.example",
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
    path: `agents/${name}.md`,
    content: subagentTemplate(name),
  };
}

function bundleReadme(bundleName: string): string {
  return `# ${bundleName}\n\nThis bundle contains filesystem-configured OMP agents.\n\n## Development loop\n\n1. Generate or edit an agent and its components.\n2. Configure each agent with omp-bundler set-model <agent-id>. The default mode opens an editor; add --wizard for guided prompts.\n3. Copy runtime.env.example to the ignored runtime.env file and fill its generated placeholders.\n4. Run omp-bundler check and omp-bundler build, then use omp-bundler run for the foreground process or omp-bundler service start for a detached container. Check, run, and service start select runtime.env automatically.\n5. Chat with the only agent by running omp-bundler tui, or send a message to the HTTP adapter:\n\n   curl -X POST http://localhost:8765/v1/agents/<agent-id>/conversations/local/messages \\\\\n     -H 'content-type: application/json' \\\\\n     -d '{\"message\":\"Hello\"}'\n\nThe request waits for the completed turn and returns its text, attachments, and usage as JSON. Set OMP_HTTP_API_TOKEN in runtime.env to require a Bearer token. For Pumble, run omp-bundler generate adapter pumble --agent <agent-id> before copying the example.\n\nUse omp-bundler service status, service restart, and service stop to manage the detached bundle container. The committed runtime.env.example contains placeholders only. Keep deployment values in runtime.env.\n`;
}

function bundleConfig(bundleName: string): string {
  return `version: 1\nagentsDir: ./agents\n\nimage:\n  tag: ${bundleName}:local\n\nrun:\n  dataVolume: ${bundleName}-data\n  corePort: 8787\n  adapterPort: 8765\n`;
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

/**
 * Update one agent's generated model-connection block. Replaces the block
 * with one `NAME=` row per env name (sorted, de-duped), removes it when empty,
 * or appends a new block when absent and non-empty. Idempotent.
 */
export function updateAgentModelEnvBlock(
  source: string,
  agentId: string,
  envNames: readonly string[],
): string {
  const unique = [...new Set(envNames)];
  const assignments = unique.map((name) => `${name}=`);
  return updateManagedEnvBlock(source, agentModelEnvHeading(agentId), assignments);
}

/** The seven canonical Pumble adapter assignments, in declaration order. */
const PUMBLE_BLOCK_FIELDS = [...PUMBLE_RUNTIME_FIELDS, "PUMBLE_AGENT_ID"] as const;
const MODEL_ENV_HEADING_RE =
  /^# Model connection for [a-z0-9][a-z0-9_-]{0,63}\. Copy this file to runtime\.env and fill these values\.$/;
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


/**
 * Switch the runtime to the Pumble adapter and ensure one managed Pumble
 * block bound to `agentId`. Migrates any prior unheaded canonical PUMBLE_*
 * assignments (only the seven known names) into the block, preserving their
 * non-empty values. Rejects a conflicting PUMBLE_AGENT_ID binding. Idempotent.
 */
export function updatePumbleBlock(source: string, agentId: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) throw new Error(`invalid agent id: ${agentId}`);
  const eol = detectEol(source);
  const lines = source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const protectedModelLines = managedModelBlockLines(lines);

  // Conflict-check every PUMBLE_AGENT_ID assignment before mutating.
  for (let index = 0; index < lines.length; index += 1) {
    if (protectedModelLines.has(index)) continue;
    const line = lines[index];
    if (!/^\s*PUMBLE_AGENT_ID\s*=/.test(line)) continue;
    const value = line.slice(line.indexOf("=") + 1).trim();
    if (value !== "" && value !== agentId) {
      throw new Error(
        `runtime.env.example already binds PUMBLE_AGENT_ID to '${value}'; change or remove that binding explicitly`,
      );
    }
  }

  // Migrate the prior generator's unheaded canonical assignments, first non-empty wins.
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

  // Remove unheaded canonical PUMBLE_* assignments outside a managed block.
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
    if (protectedModelLines.has(index)) {
      filtered.push(lines[index]);
      continue;
    }
    if (index >= blockStart && index < blockEnd) {
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
  // Set every unprotected OMP_BUNDLER_ADAPTER assignment to pumble (add one if absent).
  let adapterFound = false;
  for (let index = 0; index < filtered.length; index += 1) {
    if (filteredModelLines.has(index) || !/^\s*OMP_BUNDLER_ADAPTER\s*=/.test(filtered[index])) continue;
    adapterFound = true;
    if (filtered[index].slice(filtered[index].indexOf("=") + 1).trim() !== "pumble") {
      filtered[index] = `${filtered[index].slice(0, filtered[index].indexOf("=") + 1)}pumble`;
    }
  }
  if (!adapterFound) {
    filtered.unshift("OMP_BUNDLER_ADAPTER=pumble");
  }

  // Build the managed Pumble block body.
  const block = [
    PUMBLE_ENV_HEADING,
    ...PUMBLE_RUNTIME_FIELDS.map((field) => `${field}=${knownValues.get(field) ?? ""}`),
    `PUMBLE_AGENT_ID=${agentId}`,
  ];

  // Replace the existing managed block, or append a new one.
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

/**
 * Remove the generated Pumble block only when it is bound to `agentId`.
 * Handwritten or differently bound Pumble sections remain untouched.
 */
export function removePumbleBlock(source: string, agentId: string): string {
  const lines = source.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const blockStart = lines.indexOf(PUMBLE_ENV_HEADING);
  if (blockStart < 0) return source;
  let blockEnd = blockStart + 1;
  while (blockEnd < lines.length) {
    const body = lines[blockEnd];
    if (body.trim() === "" || body.trimStart().startsWith("#")) break;
    if (!/^\s*(?:OMP_BUNDLER_ADAPTER|PUMBLE_[A-Z0-9_]*)\s*=/.test(body)) break;
    blockEnd += 1;
  }
  const binding = lines
    .slice(blockStart + 1, blockEnd)
    .find((line) => /^\s*PUMBLE_AGENT_ID\s*=/.test(line));
  const bindingValue = binding?.slice(binding.indexOf("=") + 1) ?? "";
  const commentStart = bindingValue.search(/(?:^|\s)#/);
  const boundAgent = (commentStart < 0 ? bindingValue : bindingValue.slice(0, commentStart)).trim();
  if (boundAgent !== agentId) return source;
  return updateManagedEnvBlock(source, PUMBLE_ENV_HEADING, []);
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
