import type { BridgeConfig } from "./config.js";
import { joinPublicUrl } from "./config.js";

const botScopes = ["messages:read", "messages:write", "channels:read"];
const userScopes = ["messages:read"];

export function buildManifest(config: BridgeConfig) {
  return {
    name: config.manifestName,
    displayName: config.manifestDisplayName,
    bot: true,
    botTitle: config.manifestBotTitle,
    socketMode: false,
    scopes: {
      botScopes,
      userScopes,
    },
    eventSubscriptions: {
      url: joinPublicUrl(config, "/pumble/events"),
      events: ["APP_UNAUTHORIZED", "APP_UNINSTALLED", "NEW_MESSAGE"],
    },
    redirectUrls: [joinPublicUrl(config, "/pumble/oauth/callback")],
    offlineMessage: "agent is currently unavailable.",
  };
}
