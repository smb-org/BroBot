import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import { formatCount } from "../text";
import type { ModuleLanguage } from "../modules/contract";
import type { RealtimeEnvelope } from "../realtime-contract";
import { connectOverlayRealtime } from "./realtime";

interface OverlayVariableValue {
  value: number;
  language: ModuleLanguage | null;
}

interface OverlayVariableProperties {
  token: string | null;
  name: string;
  text: string;
}

const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const RELOAD_DELAY_MS = 1_500;
const MAX_LOAD_RETRIES = 3;
const INITIAL_LOAD_RETRY_DELAY_MS = 1_000;

const variableStyle: CSSProperties = {
  backgroundColor: "transparent",
  color: "rgba(255, 255, 255, 0.96)",
  fontFamily: "system-ui, sans-serif",
  fontSize: "48px",
  fontWeight: 700,
  lineHeight: 1.1,
  textShadow: "0 1px 3px rgba(0, 0, 0, 0.9)",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requestOverlayVariable = async (
  token: string,
  name: string,
  signal: AbortSignal,
): Promise<OverlayVariableValue | null> => {
  const response = await fetch(`/api/overlay/variables/${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 404 ||
        (response.status >= 400 && response.status < 500 && response.status !== 429)) return null;
    throw new Error(`Overlay variable request failed with status ${String(response.status)}.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new Error("Overlay variable response was not valid JSON.");
  }
  if (!isRecord(payload) || payload.name !== name || typeof payload.value !== "number" ||
      !Number.isSafeInteger(payload.value)) throw new Error("Overlay variable response had an invalid shape.");
  const language = response.headers.get("Content-Language");
  return {
    value: payload.value,
    language: language === "de" ? "de" : "en",
  };
};

const hasVariableValue = (
  message: RealtimeEnvelope<"variables.changed">,
  name: string,
): number | null => message.payload.set.find((variable) => variable.name === name)?.value ?? null;

export const VariableOverlay = ({ token, name, text }: OverlayVariableProperties): ReactElement | null => {
  const [current, setCurrent] = useState<OverlayVariableValue | null>(null);

  useEffect(() => {
    if (token === null || !VARIABLE_NAME_PATTERN.test(name)) {
      return;
    }

    let disposed = false;
    let requestNumber = 0;
    let activeController: AbortController | null = null;
    let reloadTimer: number | null = null;
    let retryTimer: number | null = null;
    let retryAttempt = 0;

    const stopRetryTimer = (): void => {
      if (retryTimer === null) return;
      window.clearTimeout(retryTimer);
      retryTimer = null;
    };

    const load = async (): Promise<void> => {
      const currentRequest = ++requestNumber;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      try {
        const next = await requestOverlayVariable(token, name, controller.signal);
        if (disposed || currentRequest !== requestNumber) return;
        setCurrent(next);
        retryAttempt = 0;
        stopRetryTimer();
      } catch {
        if (disposed || currentRequest !== requestNumber || retryTimer !== null || retryAttempt >= MAX_LOAD_RETRIES) return;
        const delay = INITIAL_LOAD_RETRY_DELAY_MS * (2 ** retryAttempt);
        retryAttempt++;
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void load();
        }, delay);
      }
    };

    const stopReloadTimer = (): void => {
      if (reloadTimer === null) return;
      window.clearTimeout(reloadTimer);
      reloadTimer = null;
    };

    const scheduleReload = (): void => {
      stopReloadTimer();
      reloadTimer = window.setTimeout(() => {
        reloadTimer = null;
        void load();
      }, RELOAD_DELAY_MS);
    };

    const invalidatePendingLoad = (): void => {
      requestNumber++;
      activeController?.abort();
      activeController = null;
    };

    const stopRealtime = connectOverlayRealtime(token, () => {
      invalidatePendingLoad();
      stopReloadTimer();
      stopRetryTimer();
      setCurrent(null);
    }, {
      onOpen: () => {
        stopRetryTimer();
        retryAttempt = 0;
        void load();
      },
      onMessage: (message) => {
        if (message.payload.removed.includes(name)) {
          invalidatePendingLoad();
          stopReloadTimer();
          stopRetryTimer();
          retryAttempt = 0;
          setCurrent(null);
          return;
        }
        const nextValue = hasVariableValue(message, name);
        if (nextValue === null) return;
        invalidatePendingLoad();
        stopRetryTimer();
        retryAttempt = 0;
        setCurrent((previous) => previous === null
          ? { value: nextValue, language: null }
          : { ...previous, value: nextValue });
        scheduleReload();
      },
    });

    void load();
    return () => {
      disposed = true;
      requestNumber++;
      activeController?.abort();
      stopReloadTimer();
      stopRetryTimer();
      stopRealtime();
    };
  }, [name, token]);

  if (token === null || !VARIABLE_NAME_PATTERN.test(name) || current === null || current.language === null) return null;
  const formatted = formatCount(current.value, current.language);
  const placeholderIndex = text.indexOf("{value}");
  const before = placeholderIndex === -1
    ? text.length === 0 ? "" : `${text} `
    : text.slice(0, placeholderIndex);
  const after = placeholderIndex === -1 ? "" : text.slice(placeholderIndex + "{value}".length);

  return <div className="brobot-variable" data-variable={name} style={variableStyle}>
    <span className="brobot-variable__text">{before}</span>
    <span className="brobot-variable__value">{formatted}</span>
    {after.length === 0 ? null : <span className="brobot-variable__text">{after}</span>}
  </div>;
};
