import type { BridgeConfig } from "./config.js";

export class PumbleApi {
  constructor(private readonly config: BridgeConfig) {}

  async exchangeCode(code: string) {
    const form = new FormData();
    form.set("client-id", this.config.appId);
    form.set("client-secret", this.config.clientSecret);
    form.set("code", code);

    const response = await fetch(`${this.config.pumbleApiBaseUrl}/oauth2/access`, {
      method: "POST",
      body: form,
    });
    if (!response.ok) {
      throw new Error(`Pumble OAuth exchange failed with HTTP ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async getChannel(appKey: string, botToken: string, channelId: string) {
    const response = await fetch(`${this.config.pumbleApiBaseUrl}/v1/channels/${channelId}`, {
      headers: this.authHeaders(appKey, botToken),
    });
    if (!response.ok) {
      throw new Error(`Pumble channel lookup failed with HTTP ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async sendMessage(
    appKey: string,
    botToken: string,
    channelId: string,
    text: string,
    threadRootId?: string,
  ) {
    let path = `${this.config.pumbleApiBaseUrl}/v1/channels/${channelId}/messages`;
    if (threadRootId) {
      path += `/${threadRootId}`;
    }
    const response = await fetch(path, {
      method: "POST",
      headers: {
        ...this.authHeaders(appKey, botToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      throw new Error(`Pumble send failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const responseText = await response.text();
    return responseText ? (JSON.parse(responseText) as Record<string, unknown>) : {};
  }

  async fetchFile(appKey: string, accessToken: string, fileUrl: string) {
    const response = await fetch(fileUrl, {
      headers: this.authHeaders(appKey, accessToken),
    });
    if (!response.ok) {
      throw new Error(`Pumble file download failed with HTTP ${response.status}`);
    }
    if (!response.body) {
      throw new Error("Pumble file download returned an empty body.");
    }
    return response;
  }

  private authHeaders(appKey: string, botToken: string) {
    return {
      token: botToken,
      "x-app-token": appKey,
    };
  }
}
