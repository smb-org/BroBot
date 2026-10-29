import type { ModuleChatCommandDeclaration, ModuleChatCommandThreshold, BotModule } from "../modules/contract";
import { dashboardTexts, type DashboardLanguage } from "./locale";

export interface ModuleHowToPlayRow {
  kind: "cockpit" | "auto_start" | "command" | "participation" | "participation_setting";
  label: "start" | "participate" | "startAndJoin" | "note";
  text: string;
}

const objectValue = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const configuredThreshold = (command: ModuleChatCommandDeclaration, settings: unknown): ModuleChatCommandThreshold => {
  if (command.minimumChatStatusSetting === undefined) return command.minimumChatStatus;
  const value = objectValue(settings)?.[command.minimumChatStatusSetting];
  if (value === "viewer") return "everyone";
  return value === "subscriber" || value === "vip" || value === "moderator" || value === "broadcaster"
    ? value
    : command.minimumChatStatus;
};

/** Invalid stored settings (null) or unresolvable command names: defaults must not be shown as configured facts. */
const settingsUnavailable = (module: BotModule, settings: unknown): boolean =>
  settings === null
  || (module.chatCommandNames !== undefined && module.chatCommandNames(settings).length < (module.chatCommands?.length ?? 0));

export const moduleChatCommandsForSettings = (
  module: BotModule,
  settings: unknown,
  language: DashboardLanguage,
): ModuleChatCommandDeclaration[] => {
  const declarations = module.chatCommands ?? [];
  if (settingsUnavailable(module, settings)) return [];
  const configuredNames = module.chatCommandNames?.(settings) ?? [];
  return declarations.map((command, index) => {
    const name = configuredNames[index] ?? command.name;
    const sourceSyntax = command.syntaxByLanguage?.[language] ?? command.syntax;
    const defaultToken = sourceSyntax.match(/^\S+/u)?.[0];
    return {
      ...command,
      name,
      syntax: defaultToken === undefined ? sourceSyntax : sourceSyntax.replace(defaultToken, name),
      minimumChatStatus: configuredThreshold(command, settings),
    };
  });
};

/**
 * Stored settings validated with the schema the worker applies at runtime; null when they are malformed or invalid,
 * so help never advertises defaults the worker would not use. Nothing stored yet means the defaults apply.
 */
export const moduleSettingsForHelp = (module: BotModule | undefined, serializedSettings: string | undefined): unknown => {
  if (module === undefined) return null;
  if (serializedSettings === undefined) return module.defaultSettings;
  try {
    const parsed = (module.settingsReadSchema ?? module.settingsSchema).safeParse(JSON.parse(serializedSettings));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const deriveModuleHowToPlay = (
  module: BotModule,
  settings: unknown,
  language: DashboardLanguage,
): ModuleHowToPlayRow[] => {
  const copy = dashboardTexts(language).module.howToPlay;
  const thresholdLabels = dashboardTexts(language).module.chatCommandThresholdShort;
  const definition = module.howToPlay;
  const settingsRecord = objectValue(settings);
  const rows: ModuleHowToPlayRow[] = [];

  const cockpitActionIds = definition?.cockpitActionIds ?? (module.navigationCategory === "games"
    ? module.actions?.map((action) => action.id) ?? []
    : []);
  for (const actionId of cockpitActionIds) {
    const action = module.actions?.find((candidate) => candidate.id === actionId);
    if (action === undefined) continue;
    rows.push({
      kind: "cockpit",
      label: "start",
      text: copy.liveCockpitAction(action.name[language], action.conditions.includes("streamLive")),
    });
  }

  const commands = moduleChatCommandsForSettings(module, settings, language);
  const unavailable = settingsUnavailable(module, settings);
  const settingsDependent = (module.chatCommands?.length ?? 0) > 0
    || definition?.autoStartSetting !== undefined
    || definition?.participationSetting !== undefined;
  if (unavailable && settingsDependent) rows.push({ kind: "command", label: "note", text: copy.commandsUnavailable });
  for (const command of commands) {
    if (command.howToPlayUsage !== "start" && command.howToPlayUsage !== "start_and_participate") continue;
    const startsAndJoins = command.howToPlayUsage === "start_and_participate";
    rows.push({
      kind: "command",
      label: startsAndJoins ? "startAndJoin" : "start",
      text: copy.chatCommand(command.syntax, thresholdLabels[command.minimumChatStatus]),
    });
  }

  if (!unavailable && definition?.autoStartSetting !== undefined) {
    const intervalValue = definition.autoStartIntervalSetting === undefined ? undefined : settingsRecord?.[definition.autoStartIntervalSetting];
    rows.push({
      kind: "auto_start",
      label: "start",
      text: copy.automaticStart(
        settingsRecord?.[definition.autoStartSetting] === true,
        typeof intervalValue === "number" && Number.isSafeInteger(intervalValue) ? intervalValue : null,
      ),
    });
  }

  for (const command of commands) {
    if (command.howToPlayUsage !== "participate") continue;
    rows.push({
      kind: "command",
      label: "participate",
      text: copy.chatCommand(command.syntax, thresholdLabels[command.minimumChatStatus]),
    });
  }

  // Free-text participation is a note once a chat command already explains how to join.
  if (definition?.participation !== undefined) {
    const joinKnown = rows.some((row) => row.label === "participate" || row.label === "startAndJoin");
    rows.push({ kind: "participation", label: joinKnown ? "note" : "participate", text: definition.participation[language] });
  }

  if (!unavailable && definition?.participationSetting !== undefined && settingsRecord !== null) {
    const { setting, enabled, disabled } = definition.participationSetting;
    rows.push({
      kind: "participation_setting",
      label: "note",
      text: settingsRecord[setting] === true ? enabled[language] : disabled[language],
    });
  }

  // A games-category module without any start or join information (Points) is not a game to start: no block at all.
  if (!unavailable && rows.length > 0 && module.navigationCategory === "games" && !rows.some((row) => row.label === "participate" || row.label === "startAndJoin")) {
    rows.push({ kind: "participation", label: "participate", text: copy.missingInstructions });
  }
  return rows;
};
