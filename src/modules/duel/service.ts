import type { ModuleEvent, ModuleExecutionContext, ModuleResult } from "../contract";
import type { DuelRoundData, DuelSettings } from "./contracts";
import { parseDuelAcceptCommand, parseDuelChallengeCommand, validateDuelTarget } from "./domain/command";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const textVariant = (items: readonly string[], seed: string): string => {
  let hash = 0;
  for (const character of seed) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return items[hash % items.length] ?? items[0] ?? "";
};

const interpolate = (template: string, variables: Readonly<Record<string, string | number>>): string =>
  template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (match, key: string) => {
    const value = variables[key];
    return value === undefined ? match : String(value);
  });

const renderError = (template: string, settings: DuelSettings): string => interpolate(template, {
  min: settings.minStake,
  max: settings.maxStake,
  seconds: settings.cooldownSeconds,
});

const throttledError = async (
  context: ModuleExecutionContext,
  settings: DuelSettings,
  accountId: string,
  messageId: string,
  key: keyof DuelSettings["texts"]["errors"],
): Promise<ModuleResult> => {
  if (!await context.points.claimCooldown(`error:${accountId}`, 60)) return { actions: [], diagnostics: [] };
  return {
    actions: [{
      kind: "chat",
      text: renderError(settings.texts.errors[key], settings),
      ...(settings.chatTarget === null ? {} : { target: settings.chatTarget }),
      replyToMessageId: messageId,
      automated: false,
    }],
    diagnostics: [],
  };
};

const isRestrictedRole = (event: ModuleEvent<DuelSettings>): boolean =>
  event.chatStatus?.some((status) => status === "broadcaster" || status === "moderator") === true ||
  event.actor?.role === "broadcaster";

const canPlay = (event: ModuleEvent<DuelSettings>): boolean =>
  event.settings.broadcasterModsMayPlay || !isRestrictedRole(event);

const openCandidates = async (context: ModuleExecutionContext, userId: string, now: number) => {
  const rounds = await context.points.rounds.listOpen();
  const eligible = rounds.filter((round) => round.state === "open" && round.deadlineAt !== null && round.deadlineAt > now);
  const targeted = eligible.find((round) => record(round.data)?.targetId === userId && record(round.data)?.challengerId !== userId);
  if (targeted !== undefined) return targeted;
  return eligible.find((round) => record(round.data)?.targetId === null && record(round.data)?.challengerId !== userId) ?? null;
};

export const processDuelMessage = async (
  event: ModuleEvent<DuelSettings>,
  context: ModuleExecutionContext,
): Promise<ModuleResult> => {
  if (event.subscriptionType !== "channel.chat.message") return { actions: [], diagnostics: [] };
  const payload = event.payload;
  const userId = payload.chatter_user_id;
  const login = payload.chatter_user_login;
  const messageId = payload.message_id;
  const message = record(payload.message)?.text;
  if (typeof userId !== "string" || typeof login !== "string" || typeof messageId !== "string" ||
      messageId.length === 0 || typeof message !== "string") return { actions: [], diagnostics: [] };
  if (await context.botUserId?.() === userId) return { actions: [], diagnostics: [] };
  const sourceBroadcasterUserId = payload.source_broadcaster_user_id;
  if (typeof sourceBroadcasterUserId === "string" && sourceBroadcasterUserId !== event.channelId) {
    return { actions: [], diagnostics: [] };
  }
  if (!canPlay(event)) return { actions: [], diagnostics: [] };
  const language = await context.channelLanguage();
  const accountId = userId;

  const parsed = parseDuelChallengeCommand(message, event.settings);
  if (!parsed.ok && parsed.reason !== "not_command") {
    return throttledError(context, event.settings, accountId, messageId,
      parsed.reason === "out_of_range" ? "stakeBounds" : "invalidStake");
  }
  if (parsed.ok) {
    let targetId: string | null = null;
    let targetLogin: string | null = null;
    if (parsed.targetLogin !== null) {
      const target = await context.lookupUserByLoginWithBotToken?.(parsed.targetLogin) ?? null;
      if (target === null) return throttledError(context, event.settings, accountId, messageId, "unknownUser");
      const selfTarget = validateDuelTarget(accountId, target.userId);
      if (selfTarget !== null) return throttledError(context, event.settings, accountId, messageId, "cannotAcceptOwn");
      targetId = target.userId;
      targetLogin = target.login;
    }
    const data: DuelRoundData = {
      challengerId: accountId,
      challengerLogin: login,
      targetId,
      targetLogin,
      stake: parsed.stake,
      botEnabled: event.settings.botAcceptsOpenDuels,
      acceptCommand: event.settings.acceptCommand,
      language,
      chatTarget: event.settings.chatTarget,
      sourceBroadcasterUserId: typeof sourceBroadcasterUserId === "string" ? sourceBroadcasterUserId : null,
      challengeMessageId: messageId,
      fightText: textVariant(event.settings.texts.fightVariants, messageId),
      botFightText: textVariant(event.settings.texts.botFightVariants, messageId),
      texts: event.settings.texts,
    };
    const roundId = crypto.randomUUID();
    try {
      const opened = await context.points.rounds.openWithStake(roundId, {
        ...data,
        lockKeys: [`challenger:${accountId}`, ...(targetId === null ? [] : [`target:${targetId}`])],
        durationS: event.settings.acceptWindowSeconds,
        announceText: targetLogin === null ? event.settings.texts.challengeOpen : event.settings.texts.challengeTargeted,
        settlement: { kind: "duel", params: { mode: "expire" } },
      }, `msg:${messageId}`, accountId, login, parsed.stake, {
        key: `challenge:${accountId}`,
        seconds: event.settings.cooldownSeconds,
      });
      if (opened.replayed) return { actions: [], diagnostics: [] };
    } catch (error) {
      const code = error instanceof Error ? error.message : "unknown";
      if (code === "insufficient_points") {
        return throttledError(context, event.settings, accountId, messageId, "notEnoughPoints");
      }
      if (code === "cooldown") return throttledError(context, event.settings, accountId, messageId, "cooldown");
      if (code === "round_limit") return throttledError(context, event.settings, accountId, messageId, "tooManyOpen");
      if (code === "round_locked") {
        const open = await context.points.rounds.listOpen();
        const ownChallenge = open.some((round) => (record(round.data)?.lockKeys as unknown[] | undefined)?.includes(`challenger:${accountId}`));
        return throttledError(context, event.settings, accountId, messageId,
          ownChallenge ? "alreadyChallenging" : "targetBusy");
      }
      return { actions: [], diagnostics: [] };
    }
    return { actions: [], diagnostics: [] };
  }

  if (!parseDuelAcceptCommand(message, event.settings.acceptCommand)) return { actions: [], diagnostics: [] };
  const now = Date.now();
  const candidate = await openCandidates(context, accountId, now);
  if (candidate === null) return throttledError(context, event.settings, accountId, messageId, "noOpenChallenge");
  try {
    await context.points.rounds.accept(candidate.roundId, `msg:${messageId}`, accountId, login, messageId);
    return { actions: [], diagnostics: [] };
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (code === "round_closed" || code === "not_eligible" || code === "operation_conflict") return { actions: [], diagnostics: [] };
    if (code === "insufficient_points") return throttledError(context, event.settings, accountId, messageId, "notEnoughPoints");
    return { actions: [], diagnostics: [] };
  }
};

export const duelTextVariables = (
  data: DuelRoundData,
  values: { target?: string; winner?: string; loser?: string; net?: string; loss?: string; fight?: string } = {},
): Record<string, string | number> => ({
  challenger: data.challengerLogin,
  target: values.target ?? data.targetLogin ?? "chat",
  stake: data.stake,
  acceptCommand: data.acceptCommand,
  winner: values.winner ?? "",
  loser: values.loser ?? "",
  net: values.net ?? "",
  loss: values.loss ?? "",
  fight: values.fight ?? data.fightText,
  botFight: data.botFightText,
});

export const duelAnnouncementTemplate = (data: DuelRoundData): string =>
  data.targetId === null ? data.texts.challengeOpen : data.texts.challengeTargeted;

export const duelResultTemplate = (data: DuelRoundData, bot: boolean): string => bot ? data.texts.botResult : data.texts.result;

export const duelFightLine = (data: DuelRoundData, bot: boolean): string => bot ? data.botFightText : data.fightText;

