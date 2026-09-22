/**
 * Default chat texts the bot posts in a channel. Chat templates are channel
 * content, not source text: they stay in the channel's language and are not
 * translated with the code (docs/input/umbau-plan.md, "Chatvorlagen").
 */
export const NO_COMMANDS_REPLY = "Keine Textbefehle angelegt.";
export const commandListReply = (names: readonly string[]): string =>
  `Befehle: ${names.map((name) => `!${name}`).join(", ")}`;
