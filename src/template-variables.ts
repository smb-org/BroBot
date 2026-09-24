import type { TemplateVariable, TemplateContext } from "./template";

export const SYSTEM_TEMPLATE_VARIABLES = {
  user: { name: "user", group: "context", contexts: ["chat_command"], sample: "viewer", maxLength: 25 },
  displayname: { name: "displayname", group: "context", contexts: ["chat_command"], sample: "Viewer", maxLength: 25 },
  channel: { name: "channel", group: "context", contexts: ["chat_command"], sample: "samplechannel", maxLength: 25 },
  target: { name: "target", group: "context", contexts: ["chat_command"], sample: "friend", maxLength: 25 },
  args: { name: "args", group: "context", contexts: ["chat_command"], sample: "hello everyone", maxLength: 100 },
  game: { name: "game", group: "stream", contexts: ["chat_command", "event", "system"], sample: "Minecraft", maxLength: 100, external: true },
  title: { name: "title", group: "stream", contexts: ["chat_command", "event", "system"], sample: "A cozy evening", maxLength: 140, external: true },
  uptime: { name: "uptime", group: "stream", contexts: ["chat_command", "event", "system"], sample: "2 h 14 min", maxLength: 32, external: true },
  viewers: { name: "viewers", group: "stream", contexts: ["chat_command", "event", "system"], sample: "42", maxLength: 7, external: true },
  live: { name: "live", group: "stream", contexts: ["chat_command", "event", "system"], sample: "live", maxLength: 8 },
  followers: { name: "followers", group: "stream", contexts: ["chat_command", "event", "system"], sample: "12,345", maxLength: 9, external: true },
  chatters: { name: "chatters", group: "stream", contexts: ["chat_command", "event", "system"], sample: "42", maxLength: 7, external: true },
  followage: { name: "followage", group: "person", contexts: ["chat_command"], sample: "1 year, 3 months", maxLength: 48, external: true },
  subage: { name: "subage", group: "person", contexts: ["chat_command"], sample: "6", maxLength: 4 },
  accountage: { name: "accountage", group: "person", contexts: ["chat_command"], sample: "4 years", maxLength: 48, external: true },
  uses: { name: "uses", group: "command", contexts: ["chat_command"], sample: "12", maxLength: 10 },
  cooldown: { name: "cooldown", group: "command", contexts: ["chat_command"], sample: "5", maxLength: 5 },
  command: { name: "command", group: "command", contexts: ["chat_command"], sample: "hello", maxLength: 33 },
  date: { name: "date", group: "time_random", contexts: ["chat_command", "event", "system"], sample: "23.09.2026", maxLength: 10 },
  time: { name: "time", group: "time_random", contexts: ["chat_command", "event", "system"], sample: "20:15", maxLength: 5 },
  random: { name: "random", group: "time_random", contexts: ["chat_command", "event", "system"], sample: "73", maxLength: 7, parameters: "range" },
  pick: { name: "pick", group: "time_random", contexts: ["chat_command", "event", "system"], sample: "heads", maxLength: 200, parameters: "choices" },
} as const satisfies Readonly<Record<string, TemplateVariable>>;

export type SystemVariableName = keyof typeof SYSTEM_TEMPLATE_VARIABLES;

export const SYSTEM_TEMPLATE_VARIABLE_LIST: readonly TemplateVariable[] =
  Object.values(SYSTEM_TEMPLATE_VARIABLES);

export const systemVariablesForContext = (context: TemplateContext): readonly TemplateVariable[] =>
  SYSTEM_TEMPLATE_VARIABLE_LIST.filter((variable) => variable.contexts?.includes(context) ?? true);
