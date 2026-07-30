import type { BridgeConfig } from "./config.js";
import { resolvePumbleFileDownloadUrl } from "./pumble-files.js";

export class PumbleApi {
  constructor(private readonly config: BridgeConfig) {}

  authorizationUrl(
    redirectUrl: string,
    state: string,
    scopes: readonly string[],
  ) {
    const url = new URL("https://app.pumble.com/access-request");
    url.searchParams.set("redirectUrl", redirectUrl);
    url.searchParams.set("clientId", this.config.appId);
    url.searchParams.set("scopes", scopes.join(","));
    url.searchParams.set("state", state);
    if (this.config.workspaceId) {
      url.searchParams.set("defaultWorkspaceId", this.config.workspaceId);
    }
    return url.toString();
  }

  async exchangeCode(code: string) {
    const form = new FormData();
    form.set("client-id", this.config.appId);
    form.set("client-secret", this.config.clientSecret);
    form.set("code", code);

    const response = await fetch(
      `${this.config.pumbleApiBaseUrl}/oauth2/access`,
      {
        method: "POST",
        body: form,
        signal: this.signal(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Pumble OAuth exchange failed with HTTP ${response.status}`,
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async getChannel(appKey: string, botToken: string, channelId: string) {
    const response = await fetch(
      `${this.config.pumbleApiBaseUrl}/v1/channels/${channelId}`,
      {
        headers: this.authHeaders(appKey, botToken),
        signal: this.signal(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Pumble channel lookup failed with HTTP ${response.status}`,
      );
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
      signal: this.signal(),
    });
    if (!response.ok) {
      throw new Error(
        `Pumble send failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const responseText = await response.text();
    return responseText
      ? (JSON.parse(responseText) as Record<string, unknown>)
      : {};
  }

  async editMessage(
    appKey: string,
    botToken: string,
    channelId: string,
    messageId: string,
    text: string,
  ) {
    const response = await fetch(
      `${this.config.pumbleApiBaseUrl}/v1/channels/${channelId}/messages/${messageId}`,
      {
        method: "PUT",
        headers: {
          ...this.authHeaders(appKey, botToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ text }),
        signal: this.signal(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Pumble edit failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const responseText = await response.text();
    return responseText
      ? (JSON.parse(responseText) as Record<string, unknown>)
      : {};
  }

  async addReaction(
    appKey: string,
    botToken: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ) {
    const response = await fetch(
      `${this.config.pumbleApiBaseUrl}/v1/channels/${channelId}/messages/${messageId}/reactions`,
      {
        method: "POST",
        headers: {
          ...this.authHeaders(appKey, botToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: emoji }),
        signal: this.signal(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Pumble add reaction failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const responseText = await response.text();
    return responseText
      ? (JSON.parse(responseText) as Record<string, unknown>)
      : {};
  }

  async removeReaction(
    appKey: string,
    botToken: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ) {
    const response = await fetch(
      `${this.config.pumbleApiBaseUrl}/v1/channels/${channelId}/messages/${messageId}/reactions`,
      {
        method: "DELETE",
        headers: {
          ...this.authHeaders(appKey, botToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: emoji }),
        signal: this.signal(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Pumble remove reaction failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
    const responseText = await response.text();
    return responseText
      ? (JSON.parse(responseText) as Record<string, unknown>)
      : {};
  }

  async getUser(appKey: string, botToken: string, userId: string) {
    const response = await fetch(
      `${this.config.pumbleApiBaseUrl}/v1/users/${userId}`,
      {
        headers: this.authHeaders(appKey, botToken),
        signal: this.signal(),
      },
    );
    if (!response.ok) {
      throw new Error(`Pumble user lookup failed with HTTP ${response.status}`);
    }
    const responseText = await response.text();
    return responseText
      ? (JSON.parse(responseText) as Record<string, unknown>)
      : {};
  }
  async fetchFile(appKey: string, accessToken: string, fileUrl: string) {
    const response = await fetch(
      resolvePumbleFileDownloadUrl(this.config, fileUrl),
      {
        headers: this.authHeaders(appKey, accessToken),
        redirect: "error",
        signal: this.signal(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Pumble file download failed with HTTP ${response.status}`,
      );
    }
    if (!response.body) {
      throw new Error("Pumble file download returned an empty body.");
    }
    return response;
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.config.httpTimeoutMs);
  }

  private authHeaders(appKey: string, botToken: string) {
    return {
      token: botToken,
      "x-app-token": appKey,
    };
  }
}
