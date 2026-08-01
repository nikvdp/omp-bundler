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

export const RUNTIME_ENV_EXAMPLE = "OMP_AUTH_BROKER_URL=\nOMP_AUTH_BROKER_TOKEN=\n";

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
      path: ".omp/AGENTS.md",
      content: `# ${agentId}\n\nYou are the ${agentId} agent.\n\n## Instructions\n\n- Read the available context before acting.\n- Use tools when they improve correctness.\n- State uncertainty directly.\n`,
    },
    {
      path: ".omp/config.yml",
      content: "setupVersion: 1\n\n# Add agent-local OMP settings here. Shared model selection is inherited.\n# modelRoles:\n#   default: provider/model\n",
    },
    {
      path: ".omp/agents/example-subagent.md.example",
      content: exampleSubagentTemplate(),
    },
    {
      path: ".omp/commands/example-command.md.example",
      content: exampleCommandTemplate(),
    },
    {
      path: ".omp/extensions/example-extension.ts.example",
      content: exampleExtensionTemplate(),
    },
    {
      path: ".omp/skills/example-skill/SKILL.md.example",
      content: exampleSkillTemplate(),
    },
    {
      path: ".omp/tools/example-tool.ts.example",
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
  return `# ${bundleName}\n\nThis bundle contains filesystem-configured OMP agents.\n\n## Development loop\n\n1. Generate or edit an agent and its .omp components.\n2. Run omp-bundler check.\n3. Build and run the bundle.\n\nThe committed runtime.env.example contains placeholders only. Copy it to runtime.env and fill deployment values locally.\n`;
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
