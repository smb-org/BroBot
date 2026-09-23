/**
 * Default chat texts the bot posts in a channel. Chat templates are channel
 * content, not source text: they stay in the channel's language and are not
 * translated with the code (docs/input/umbau-plan.md, "Chatvorlagen").
 */
export const NO_COMMANDS_REPLY = "Keine Textbefehle angelegt.";
export const commandListReply = (names: readonly string[]): string =>
  `Befehle: ${names.map((name) => `!${name}`).join(", ")}`;

export const TEXT_COMMAND_DEFAULT_TEXTS = {
  uptime: "{channel} ist seit {uptime} live!",
  followage: "{user} folgt {channel} seit {followage}.",
  game: "{channel} spielt gerade {game}: {title}",
  shoutout: "Schaut bei {target} vorbei: twitch.tv/{target}",
} as const;

export const TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES = {
  offlineText: "{channel} ist gerade offline.",
  notFollowingText: "{user} folgt {channel} noch nicht.",
  unavailableText: "Followage ist gerade nicht verfügbar.",
  usageText: "Nutzung: !so <name>",
} as const;

export const textCommandDefaultsFor = (kind: "uptime" | "followage" | "game" | "shoutout") => ({
  text: TEXT_COMMAND_DEFAULT_TEXTS[kind],
  ...(kind === "uptime" ? { offlineText: TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.offlineText } : {}),
  ...(kind === "followage" ? {
    notFollowingText: TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.notFollowingText,
    unavailableText: TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.unavailableText,
  } : {}),
  ...(kind === "shoutout" ? { usageText: TEXT_COMMAND_DEFAULT_EXTRA_TEMPLATES.usageText } : {}),
});
