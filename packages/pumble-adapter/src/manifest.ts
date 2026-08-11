import type { BridgeConfig } from "./config.js";
import { joinPublicUrl } from "./config.js";

const botScopes = [
  "messages:read", // Receive channel messages and attachment metadata.
  "messages:write", // Send final replies and progress updates.
  "messages:edit", // Update the bot's in-place progress message.
  "channels:read", // Resolve channel type and membership context.
  "reaction:write", // Acknowledge accepted work on the triggering message.
  "reaction:read", // Receive reaction-driven approvals without later re-consent.
  "user:read", // Resolve stable user ids to display names.
];
const userScopes = ["messages:read"];

export const pumbleAuthorizationScopes = [
  ...userScopes,
  ...botScopes.map((scope) => `bot:${scope}`),
];

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
    listingUrl: joinPublicUrl(config, "/pumble/oauth/start"),
    offlineMessage: "The agent is currently unavailable.",
  };
}
