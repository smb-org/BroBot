export interface OverlayAlertPayload {
  operationId: string;
  imageUrl?: string;
  soundUrl?: string;
  text: string;
  durationSeconds: number;
  volumePercent: number;
}

export type QueuedOverlayAlert = OverlayAlertPayload;

interface ActiveOverlayAlert extends QueuedOverlayAlert {
  startedAt: string;
  endsAt: string;
}

export interface OverlayAlertQueueState {
  revision: number;
  serverNow: string;
  current: ActiveOverlayAlert | null;
  queue: readonly QueuedOverlayAlert[];
  operationIds: readonly string[];
}

export interface OverlayAlertConfig {
  textColor: string;
  fontSize: number;
}

export const DEFAULT_OVERLAY_ALERT_CONFIG: OverlayAlertConfig = {
  textColor: "#ffffff",
  fontSize: 32,
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const isIntegerBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

const isMediaUrl = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/api/overlay/media/") && value.length <= 256;

export const parseOverlayAlertConfig = (value: unknown): OverlayAlertConfig | null => {
  const input = record(value);
  if (input === null || Object.keys(input).some((key) => key !== "textColor" && key !== "fontSize")) return null;
  const textColor = input.textColor ?? DEFAULT_OVERLAY_ALERT_CONFIG.textColor;
  const fontSize = input.fontSize ?? DEFAULT_OVERLAY_ALERT_CONFIG.fontSize;
  return typeof textColor === "string" && /^#[0-9a-f]{6}$/iu.test(textColor) &&
    isIntegerBetween(fontSize, 12, 72)
    ? { textColor, fontSize }
    : null;
};

export const parseOverlayAlertPayload = (value: unknown): QueuedOverlayAlert | null => {
  const input = record(value);
  if (input === null || typeof input.operationId !== "string" || input.operationId.length === 0 || input.operationId.length > 128 ||
      typeof input.text !== "string" || input.text.length > 200 ||
      !isIntegerBetween(input.durationSeconds, 2, 15) || !isIntegerBetween(input.volumePercent, 0, 100) ||
      input.imageUrl !== undefined && !isMediaUrl(input.imageUrl) ||
      input.soundUrl !== undefined && !isMediaUrl(input.soundUrl) ||
      input.imageUrl === undefined && input.soundUrl === undefined && input.text.trim().length === 0) return null;
  return {
    operationId: input.operationId,
    ...(input.imageUrl === undefined ? {} : { imageUrl: input.imageUrl }),
    ...(input.soundUrl === undefined ? {} : { soundUrl: input.soundUrl }),
    text: input.text,
    durationSeconds: input.durationSeconds,
    volumePercent: input.volumePercent,
  };
};

export const parseOverlayAlertQueueState = (value: unknown): OverlayAlertQueueState | null => {
  const input = record(value);
  const queue = input?.queue ?? [];
  const operationIds = input?.operationIds ?? [];
  if (input === null || !isIntegerBetween(input.revision, 0, Number.MAX_SAFE_INTEGER) ||
      typeof input.serverNow !== "string" || !Number.isFinite(Date.parse(input.serverNow)) ||
      !(input.current === null || record(input.current) !== null) || !Array.isArray(queue) ||
      !queue.every((item) => parseOverlayAlertPayload(item) !== null) ||
      !Array.isArray(operationIds) || !operationIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) return null;
  let current: ActiveOverlayAlert | null = null;
  if (input.current !== null) {
    const parsed = parseOverlayAlertPayload(input.current);
    const active = record(input.current);
    if (parsed === null || active === null || typeof active.startedAt !== "string" || !Number.isFinite(Date.parse(active.startedAt)) ||
        typeof active.endsAt !== "string" || !Number.isFinite(Date.parse(active.endsAt))) return null;
    current = { ...parsed, startedAt: active.startedAt, endsAt: active.endsAt };
  }
  return {
    revision: input.revision,
    serverNow: input.serverNow,
    current,
    queue: queue.flatMap((item) => {
      const parsed = parseOverlayAlertPayload(item);
      return parsed === null ? [] : [parsed];
    }),
    operationIds,
  };
};

export const emptyOverlayAlertQueueState = (now: number): OverlayAlertQueueState => ({
  revision: 0,
  serverNow: new Date(now).toISOString(),
  current: null,
  queue: [],
  operationIds: [],
});

const startAlert = (alert: QueuedOverlayAlert, now: number): ActiveOverlayAlert => ({
  ...alert,
  startedAt: new Date(now).toISOString(),
  endsAt: new Date(now + alert.durationSeconds * 1_000).toISOString(),
});

const operationHistory = (state: OverlayAlertQueueState, operationId: string): readonly string[] =>
  [...state.operationIds.filter((current) => current !== operationId), operationId].slice(-2_048);

export const advanceOverlayAlertQueue = (
  state: OverlayAlertQueueState,
  now: number,
  connected: boolean,
): OverlayAlertQueueState => {
  if (state.current !== null && Date.parse(state.current.endsAt) > now) return state;
  if (state.current === null && (!connected || state.queue.length === 0)) return state;
  if (!connected) {
    return {
      ...state,
      revision: state.revision + 1,
      serverNow: new Date(now).toISOString(),
      current: null,
    };
  }
  const [next, ...remaining] = state.queue;
  return {
    ...state,
    revision: state.revision + 1,
    serverNow: new Date(now).toISOString(),
    current: next === undefined ? null : startAlert(next, now),
    queue: remaining,
  };
};

export const enqueueOverlayAlert = (
  state: OverlayAlertQueueState,
  rawAlert: OverlayAlertPayload,
  now: number,
  connected: boolean,
): { state: OverlayAlertQueueState; outcome: "enqueued" | "duplicate" | "not_connected" } => {
  const alert = parseOverlayAlertPayload(rawAlert);
  if (alert === null) throw new Error("invalid_overlay_alert");
  if (state.operationIds.includes(alert.operationId)) return { state, outcome: "duplicate" };
  if (!connected) return { state, outcome: "not_connected" };

  const advanced = advanceOverlayAlertQueue(state, now, true);
  const nextState: OverlayAlertQueueState = advanced.current === null
    ? { ...advanced, current: startAlert(alert, now), operationIds: operationHistory(advanced, alert.operationId) }
    : {
      ...advanced,
      queue: [...advanced.queue, alert],
      operationIds: operationHistory(advanced, alert.operationId),
    };
  return {
    state: {
      ...nextState,
      revision: Math.max(state.revision, advanced.revision) + 1,
      serverNow: new Date(now).toISOString(),
    },
    outcome: "enqueued",
  };
};

/** Returns a bootstrap-safe view without persisting or replaying an expired alert. */
export const overlayAlertStateForBootstrap = (state: OverlayAlertQueueState, now: number): OverlayAlertQueueState => ({
  ...state,
  serverNow: new Date(now).toISOString(),
  current: state.current !== null && Date.parse(state.current.endsAt) > now ? state.current : null,
});

export interface OverlayAlertTemplateValues {
  userName: string;
  userLogin: string;
  userInput: string;
  rewardTitle: string;
}

/** Replaces only the supported placeholders and treats viewer input as an ordinary string. */
export const renderOverlayAlertText = (template: string, values: OverlayAlertTemplateValues): string =>
  template.replace(/\{(user|input|reward)\}/gu, (_match, name: string) => {
    if (name === "user") return values.userName || values.userLogin;
    if (name === "input") return values.userInput;
    return values.rewardTitle;
  }).slice(0, 200);
