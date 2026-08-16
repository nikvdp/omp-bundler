import type { BridgeConfig } from "./config.js";
import { resolvePumbleFileDownloadUrl } from "./pumble-files.js";

const REQUEST_INTERVAL_MS = 100;
const MAX_RATE_LIMIT_RETRIES = 2;
const INITIAL_RATE_LIMIT_BACKOFF_MS = 250;
const MAX_RATE_LIMIT_BACKOFF_MS = 10_000;
const MAX_RATE_LIMIT_STREAK = 31;

/** Shared transport pacing keeps bursts and rate-limit recovery in one place. */

export class PumbleApi {
  constructor(private readonly config: BridgeConfig) {}

  private requestTail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private rateLimitStreak = 0;

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

    const response = await this.request(
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
    const response = await this.request(
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
    const response = await this.request(path, {
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
    const response = await this.request(
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

  /**
   * Delete a message.
   *
   * Used when a turn is interrupted: the session rewinds as though the turn
   * never happened, so the partially posted reply must not stay in the
   * channel contradicting it.
   */
  async deleteMessage(
    appKey: string,
    botToken: string,
    channelId: string,
    messageId: string,
  ) {
    const response = await this.request(
      `${this.config.pumbleApiBaseUrl}/v1/channels/${channelId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: this.authHeaders(appKey, botToken),
        signal: this.signal(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Pumble delete failed with HTTP ${response.status}: ${await response.text()}`,
      );
    }
  }

  async addReaction(
    appKey: string,
    botToken: string,
    channelId: string,
    messageId: string,
    emoji: string,
  ) {
    // Reactions are addressed by message id alone, not nested under the
    // channel, and the payload is a shortcode plus skin tone. The previous
    // channel-scoped path with {type: emoji} always 404'd.
    const response = await this.request(
      `${this.config.pumbleApiBaseUrl}/v1/messages/${messageId}/reactions`,
      {
        method: "POST",
        headers: {
          ...this.authHeaders(appKey, botToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ code: emoji, skinTone: 1 }),
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

  /**
   * Fetch one message, including its `quote` when it quotes another.
   *
   * The NEW_MESSAGE webhook does not carry the quoted message, so the quoted
   * text has to be read back from the API before the agent can see what was
   * quoted.
   */
  async fetchMessage(
    appKey: string,
    botToken: string,
    channelId: string,
    messageId: string,
  ) {
    const response = await this.request(
      `${this.config.pumbleApiBaseUrl}/v1/channels/${channelId}/messages/${messageId}`,
      {
        headers: this.authHeaders(appKey, botToken),
        signal: this.signal(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Pumble message fetch failed with HTTP ${response.status}`,
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
    const response = await this.request(
      `${this.config.pumbleApiBaseUrl}/v1/messages/${messageId}/reactions`,
      {
        method: "DELETE",
        headers: {
          ...this.authHeaders(appKey, botToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ code: emoji, skinTone: 1 }),
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
    const response = await this.request(
      `${this.config.pumbleApiBaseUrl}/v1/workspaceUsers/${userId}`,
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
    const response = await this.request(
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

  private request(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    // Keep calls serialized so a 429 cooldown applies before any sibling call.
    const operation = this.requestTail.then(() =>
      this.performRequest(input, init),
    );
    this.requestTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async performRequest(
    input: string,
    init: RequestInit,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForRequestSlot(init.signal);
      this.nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;

      const response = await fetch(input, init);
      if (response.status !== 429) {
        this.rateLimitStreak = 0;
        return response;
      }

      const backoffMs = this.rateLimitBackoffMs(response, this.rateLimitStreak);
      this.rateLimitStreak = Math.min(
        this.rateLimitStreak + 1,
        MAX_RATE_LIMIT_STREAK,
      );
      this.nextRequestAt = Math.max(
        this.nextRequestAt,
        Date.now() + backoffMs,
      );
      if (attempt >= MAX_RATE_LIMIT_RETRIES) {
        return response;
      }

      // Discard an intermediate body before replaying the request.
      try {
        await response.body?.cancel();
      } catch {
        // The original 429 remains the caller-visible failure if retries end.
      }
    }
  }

  private rateLimitBackoffMs(response: Response, streak: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, MAX_RATE_LIMIT_BACKOFF_MS);
      }
      const retryAt = Date.parse(retryAfter);
      if (!Number.isNaN(retryAt)) {
        return Math.min(
          Math.max(0, retryAt - Date.now()),
          MAX_RATE_LIMIT_BACKOFF_MS,
        );
      }
    }
    return Math.min(
      INITIAL_RATE_LIMIT_BACKOFF_MS * 2 ** streak,
      MAX_RATE_LIMIT_BACKOFF_MS,
    );
  }

  private async waitForRequestSlot(
    signal: AbortSignal | null | undefined,
  ): Promise<void> {
    const delay = this.nextRequestAt - Date.now();
    if (delay <= 0) {
      return;
    }
    await this.wait(delay, signal);
  }

  private wait(
    delayMs: number,
    signal: AbortSignal | null | undefined,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(signal?.reason ?? new Error("The operation was aborted."));
      };
      timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
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
