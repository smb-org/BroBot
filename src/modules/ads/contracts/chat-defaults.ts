/**
 * Default chat texts the bot posts in a channel. Chat templates are channel
 * content, not source text: they stay in the channel's language and are not
 * translated with the code (docs/input/umbau-plan.md, "Chatvorlagen").
 */
export const DEFAULT_AUTOMATIC_TEXT = "Automatische Werbepause: {duration} Sekunden. Bin gleich zurück!";
export const DEFAULT_MANUAL_TEXT = "Werbepause: {duration} Sekunden. Bin gleich zurück!";
export const DEFAULT_PREWARNING_TEXT = "Werbung in {seconds} Sekunden. Bin gleich zurück!";
