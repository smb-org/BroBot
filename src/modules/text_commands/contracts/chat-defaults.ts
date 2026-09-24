/**
 * Default chat texts the bot posts in a channel. Chat templates are channel
 * content, not source text: they stay in the channel's language and are not
 * translated with the code (docs/input/umbau-plan.md, "Chatvorlagen").
 */
export const NO_COMMANDS_REPLY = "Keine Textbefehle angelegt.";
export const commandListReply = (names: readonly string[]): string =>
  `Befehle: ${names.map((name) => `!${name}`).join(", ")}`;

export const TEXT_COMMAND_DEFAULT_TEXTS = {
  shoutout: "Schaut bei {target} vorbei: twitch.tv/{target}",
} as const;

export const TEXT_COMMAND_DEFAULT_USAGE_TEXT =
  "Nutzung: !so <name>";

export const textCommandDefaultsFor = (kind: "shoutout") => ({
  text: TEXT_COMMAND_DEFAULT_TEXTS[kind],
  usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT,
});
