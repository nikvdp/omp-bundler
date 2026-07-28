import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

// Sample custom tool proving tools/ discovery works from a
// OMP_AGENT_DIR-rooted agent folder.
const factory: CustomToolFactory = (pi) => ({
  name: "workspace_info",
  label: "Workspace Info",
  description: "Report the current working directory and git HEAD, if any",
  parameters: pi.zod.object({}),

  async execute(_toolCallId, _params, onUpdate, ctx, signal) {
    onUpdate?.({
      content: [{ type: "text", text: "Inspecting workspace..." }],
    });

    const result = await pi.exec("git", ["rev-parse", "HEAD"], {
      signal,
      cwd: pi.cwd,
    });
    const head = result.code === 0 ? result.stdout.trim() : null;

    return {
      content: [
        {
          type: "text",
          text: head
            ? `cwd=${pi.cwd} head=${head}`
            : `cwd=${pi.cwd} (not a git repo)`,
        },
      ],
      details: { cwd: pi.cwd, head },
    };
  },
});

export default factory;
