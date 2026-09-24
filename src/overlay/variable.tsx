import { useEffect, useState, type ReactElement } from "react";

import type { RealtimeEnvelope } from "../realtime-contract";
import { connectOverlayRealtime } from "./realtime";
import { VariableValueView } from "./variable-view";
import type { OverlayLanguage } from "./model";

interface OverlayVariableValue {
  value: number;
  language: OverlayLanguage | null;
}

interface OverlayVariableProperties {
  token: string | null;
  name: string;
  text: string;
}

const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const RELOAD_DEBOUNCE_MS = 250;
const RELOAD_MAX_WAIT_MS = 1_500;
const LOAD_RETRY_BASE_DELAY_MS = 1_000;
const MAX_LOAD_RETRY_DELAY_MS = 60_000;
const MAX_LOAD_RETRY_ATTEMPT = 6;

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

const hasVariableHint = (
  message: RealtimeEnvelope<"variables.changed">,
  name: string,
): boolean => message.payload.set.some((variable) => variable.name === name) || message.payload.removed.includes(name);

export const VariableOverlay = ({ token, name, text }: OverlayVariableProperties): ReactElement | null => {
  const [current, setCurrent] = useState<OverlayVariableValue | null>(null);

  useEffect(() => {
    if (token === null || !VARIABLE_NAME_PATTERN.test(name)) {
      return;
    }

    let disposed = false;
    let requestNumber = 0;
    let activeController: AbortController | null = null;
    let loadInFlight = false;
    let reloadPending = false;
    let reloadTimer: number | null = null;
    let maximumReloadTimer: number | null = null;
    let retryTimer: number | null = null;
    let retryAttempt = 0;

    const stopRetryTimer = (): void => {
      if (retryTimer === null) return;
      window.clearTimeout(retryTimer);
      retryTimer = null;
    };

    const load = async (): Promise<void> => {
      if (loadInFlight) {
        reloadPending = true;
        return;
      }

      const currentRequest = ++requestNumber;
      const controller = new AbortController();
      activeController = controller;
      loadInFlight = true;
      try {
        const next = await requestOverlayVariable(token, name, controller.signal);
        if (disposed || currentRequest !== requestNumber) return;
        setCurrent(next);
        retryAttempt = 0;
        stopRetryTimer();
      } catch {
        if (disposed || currentRequest !== requestNumber || controller.signal.aborted || retryTimer !== null) return;
        const delay = Math.min(LOAD_RETRY_BASE_DELAY_MS * (2 ** retryAttempt), MAX_LOAD_RETRY_DELAY_MS);
        retryAttempt = Math.min(retryAttempt + 1, MAX_LOAD_RETRY_ATTEMPT);
        retryTimer = window.setTimeout(() => {
          retryTimer = null;
          void load();
        }, delay);
      } finally {
        if (activeController === controller) activeController = null;
        loadInFlight = false;
        if (reloadPending) {
          reloadPending = false;
          stopRetryTimer();
          void load();
        }
      }
    };

    const stopReloadTimer = (): void => {
      if (reloadTimer === null) return;
      window.clearTimeout(reloadTimer);
      reloadTimer = null;
    };

    const stopMaximumReloadTimer = (): void => {
      if (maximumReloadTimer === null) return;
      window.clearTimeout(maximumReloadTimer);
      maximumReloadTimer = null;
    };

    const reloadFromAuthority = (): void => {
      stopReloadTimer();
      stopMaximumReloadTimer();
      void load();
    };

    const scheduleReload = (): void => {
      stopReloadTimer();
      reloadTimer = window.setTimeout(reloadFromAuthority, RELOAD_DEBOUNCE_MS);
      maximumReloadTimer ??= window.setTimeout(reloadFromAuthority, RELOAD_MAX_WAIT_MS);
    };

    const invalidatePendingLoad = (): void => {
      requestNumber++;
      activeController?.abort();
      activeController = null;
      reloadPending = false;
    };

    const stopRealtime = connectOverlayRealtime(token, () => {
      invalidatePendingLoad();
      stopReloadTimer();
      stopMaximumReloadTimer();
      stopRetryTimer();
      setCurrent(null);
    }, {
      onOpen: () => {
        stopRetryTimer();
        retryAttempt = 0;
        void load();
      },
      onMessage: (message) => {
        if (!hasVariableHint(message, name)) return;
        stopRetryTimer();
        retryAttempt = 0;
        scheduleReload();
      },
    });

    void load();
    return () => {
      disposed = true;
      requestNumber++;
      reloadPending = false;
      activeController?.abort();
      stopReloadTimer();
      stopMaximumReloadTimer();
      stopRetryTimer();
      stopRealtime();
    };
  }, [name, token]);

  if (token === null || !VARIABLE_NAME_PATTERN.test(name) || current === null || current.language === null) return null;
  return <VariableValueView name={name} text={text} value={current.value} language={current.language} />;
};
