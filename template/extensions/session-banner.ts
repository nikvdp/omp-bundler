import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// Sample extension proving extensions/ discovery works from a
// OMP_AGENT_DIR-rooted agent folder.
export default function sessionBanner(pi: ExtensionAPI) {
  pi.setLabel("Agent Folder Banner");

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("agent-folder sample loaded from extensions/", "info");
  });

  pi.registerCommand("agent-folder-status", {
    description:
      "Report that this session is running from the agent-folder sample",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`agent folder active, cwd=${ctx.cwd}`, "info");
    },
  });
}
