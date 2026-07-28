import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export const AMBIENT_INGEST_COMMAND = "omp-bundler-ambient";

interface AmbientCommandPayload {
  content: string;
  triggerTurn: boolean;
}

export default function ambientIngestExtension(pi: ExtensionAPI): void {
  pi.registerCommand(AMBIENT_INGEST_COMMAND, {
    description: "Append an adapter message with agent attribution",
    handler: async (args) => {
      const payload = decodePayload(args);
      pi.sendMessage(
        {
          customType: AMBIENT_INGEST_COMMAND,
          content: payload.content,
          display: true,
          attribution: "agent",
        },
        {
          triggerTurn: payload.triggerTurn,
          ...(payload.triggerTurn ? { deliverAs: "followUp" as const } : {}),
        },
      );
    },
  });
}

function decodePayload(args: string): AmbientCommandPayload {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(args.trim(), "base64url").toString("utf8"));
  } catch {
    throw new Error("ambient ingest payload is not valid base64url JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Record<string, unknown>).content !== "string" ||
    typeof (value as Record<string, unknown>).triggerTurn !== "boolean"
  ) {
    throw new Error("ambient ingest payload requires content and triggerTurn");
  }
  const payload = value as AmbientCommandPayload;
  if (payload.content.length === 0) {
    throw new Error("ambient ingest content must be non-empty");
  }
  return payload;
}
