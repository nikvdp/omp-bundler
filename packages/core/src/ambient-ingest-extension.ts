import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

interface StringSchema {
  min(length: number): StringSchema;
  describe(description: string): StringSchema;
  optional(): StringSchema;
}

interface ExtensionAPI {
  zod: {
    z: {
      string(): StringSchema;
      object(shape: Record<string, unknown>): unknown;
    };
  };
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string) => Promise<void>;
    },
  ): void;
  registerTool<TParams, TDetails>(options: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute(
      toolCallId: string,
      params: TParams,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: TDetails;
    }>;
  }): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      attribution: "agent";
    },
    options: {
      triggerTurn: boolean;
      deliverAs?: "followUp";
    },
  ): void;
}

export const AMBIENT_INGEST_COMMAND = "omp-bundler-ambient";
export const DELIVERY_ATTACHMENT_TOOL = "deliver_attachment";
export const STAY_SILENT_TOOL = "stay_silent";

interface AmbientCommandPayload {
  content: string;
  triggerTurn: boolean;
}

interface StaySilentParams {
  reason?: string;
}

interface DeliveryAttachmentParams {
  path: string;
  name?: string;
  mediaType?: string;
}

export interface DeliveryAttachment {
  path: string;
  name: string;
  mediaType?: string;
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

  const { z } = pi.zod;
  pi.registerTool<DeliveryAttachmentParams, { ompBundlerAttachment: DeliveryAttachment }>({
    name: DELIVERY_ATTACHMENT_TOOL,
    label: "Deliver attachment",
    description: "Attach a workspace output file to the adapter reply",
    parameters: z.object({
      path: z.string().min(1).describe("Workspace-relative output file path"),
      name: z.string().min(1).optional().describe("Displayed file name"),
      mediaType: z.string().min(1).optional().describe("Optional MIME type"),
    }),
    async execute(_toolCallId, params) {
      const attachment = await resolveAttachment(params);
      return {
        content: [{ type: "text", text: `Attached ${attachment.path}` }],
        details: { ompBundlerAttachment: attachment },
      };
    },
  });

  pi.registerTool<StaySilentParams, { ompBundlerStaySilent: { reason: string } }>({
    name: STAY_SILENT_TOOL,
    label: "Stay silent",
    description:
      "End this turn without sending a message. Use when nothing you could " +
      "say would be useful to the people in the conversation: you were not " +
      "addressed, the discussion does not concern you, or someone has " +
      "already answered. Preferred over replying with filler.",
    parameters: z.object({
      reason: z
        .string()
        .min(1)
        .optional()
        .describe("Why staying silent, for operator logs. Never shown in chat."),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [
          { type: "text", text: "Staying silent; nothing will be sent." },
        ],
        details: { ompBundlerStaySilent: { reason: params.reason ?? "" } },
      };
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
    value === null ||
    typeof value !== "object" ||
    !("content" in value) ||
    typeof value.content !== "string" ||
    !("triggerTurn" in value) ||
    typeof value.triggerTurn !== "boolean"
  ) {
    throw new Error("ambient ingest payload requires content and triggerTurn");
  }
  if (value.content.length === 0) {
    throw new Error("ambient ingest content must be non-empty");
  }
  return { content: value.content, triggerTurn: value.triggerTurn };
}

async function resolveAttachment(
  params: DeliveryAttachmentParams,
): Promise<DeliveryAttachment> {
  if (isAbsolute(params.path)) {
    throw new Error("attachment path must be workspace-relative");
  }
  const workspace = await realpath(process.cwd());
  const absolutePath = resolve(workspace, params.path);
  const workspacePath = relative(workspace, absolutePath);
  if (
    !workspacePath ||
    workspacePath === ".." ||
    workspacePath.startsWith(`..${sep}`)
  ) {
    throw new Error("attachment path must stay inside the workspace");
  }
  const realPath = await realpath(absolutePath);
  const realWorkspacePath = relative(workspace, realPath);
  if (
    !realWorkspacePath ||
    realWorkspacePath === ".." ||
    realWorkspacePath.startsWith(`..${sep}`)
  ) {
    throw new Error("attachment path must stay inside the workspace");
  }
  const info = await stat(realPath);
  if (!info.isFile()) {
    throw new Error("attachment path must name a regular file");
  }
  const path = workspacePath.split(sep).join("/");
  return {
    path,
    name: params.name?.trim() || basename(path),
    ...(params.mediaType?.trim() ? { mediaType: params.mediaType.trim() } : {}),
  };
}
