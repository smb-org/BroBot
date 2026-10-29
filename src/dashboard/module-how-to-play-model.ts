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

export const moduleChatCommandsForSettings = (
  module: BotModule,
  settings: unknown,
  language: DashboardLanguage,
): ModuleChatCommandDeclaration[] => {
  const declarations = module.chatCommands ?? [];
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

export const moduleSettingsForHelp = (module: BotModule | undefined, serializedSettings: string | undefined): unknown => {
  const defaults = objectValue(module?.defaultSettings) ?? {};
  if (serializedSettings !== undefined) {
    try {
      const parsed = objectValue(JSON.parse(serializedSettings) as unknown);
      return parsed === null ? defaults : { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }
  return defaults;
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
  for (const command of commands) {
    if (command.howToPlayUsage !== "start" && command.howToPlayUsage !== "start_and_participate") continue;
    const startsAndJoins = command.howToPlayUsage === "start_and_participate";
    rows.push({
      kind: "command",
      label: startsAndJoins ? "startAndJoin" : "start",
      text: copy.chatCommand(command.syntax, thresholdLabels[command.minimumChatStatus]),
    });
  }

  if (definition?.autoStartSetting !== undefined) {
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

  if (definition?.participationSetting !== undefined) {
    const { setting, enabled, disabled } = definition.participationSetting;
    rows.push({
      kind: "participation_setting",
      label: "note",
      text: settingsRecord?.[setting] === true ? enabled[language] : disabled[language],
    });
  }

  // A games-category module without any start or join information (Points) is not a game to start: no block at all.
  if (rows.length > 0 && module.navigationCategory === "games" && !rows.some((row) => row.label === "participate" || row.label === "startAndJoin")) {
    rows.push({ kind: "participation", label: "participate", text: copy.missingInstructions });
  }
  return rows;
};
