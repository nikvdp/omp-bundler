export const ADAPTER_API_VERSION = "v1" as const;

export type AdapterApiVersion = typeof ADAPTER_API_VERSION;

export interface Speaker {
  id: string;
  displayName: string;
}

export interface WorkspaceAttachment {
  path: string;
  name?: string;
  mediaType?: string;
}
