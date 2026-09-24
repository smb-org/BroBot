import { lazy, Suspense, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import type { ModuleLanguage } from "../modules/contract";

const LazyVariableOverlay = lazy(async () => {
  const module = await import("./variable");
  return { default: module.VariableOverlay };
});

type OverlayEntryConfig =
  | { kind: "status" }
  | { kind: "variable"; token: string | null; name: string; text: string };

const readOverlayEntryConfig = (): OverlayEntryConfig => {
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const parameters = new URLSearchParams(fragment);
  const name = parameters.get("var");
  if (name === null) return { kind: "status" };
  const token = parameters.get("token");
  return {
    kind: "variable",
    token: token === null || token.length === 0 ? null : token,
    name,
    text: parameters.get("text") ?? `${name}: {value}`,
  };
};

interface OverlayStatus {
  version: string;
  language: ModuleLanguage;
}

interface OverlayTexts {
  version: string;
}

const texts: Record<ModuleLanguage, OverlayTexts> = {
  de: { version: "Version" },
  en: { version: "Version" },
};

const POLL_INTERVAL_MS = 60_000;
const MAX_FAILURE_COUNT = 4;
const MAX_POLL_DELAY_MS = 5 * 60_000;

const labelStyle: CSSProperties = {
  backgroundColor: "transparent",
  color: "rgba(255, 255, 255, 0.88)",
  fontFamily: "system-ui, sans-serif",
  fontSize: "12px",
  lineHeight: 1.3,
  padding: "4px 6px",
  textShadow: "0 1px 2px rgba(0, 0, 0, 0.85)",
};

const readTokenFromFragment = (): string | null => {
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const token = new URLSearchParams(fragment).get("token");
  return token === null || token.length === 0 ? null : token;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isModuleLanguage = (value: unknown): value is ModuleLanguage => value === "de" || value === "en";

const requestOverlayStatus = async (
  token: string,
  signal: AbortSignal,
): Promise<OverlayStatus | null> => {
  const response = await fetch("/api/overlay/status", {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) return null;
  const payload = JSON.parse(await response.text()) as unknown;
  if (!isRecord(payload)) return null;
  const version = payload.version;
  return typeof version === "string" && version.length > 0 && isModuleLanguage(payload.language)
    ? { version, language: payload.language }
    : null;
};

const delayFor = (failureCount: number): number =>
  Math.min(POLL_INTERVAL_MS * 2 ** Math.max(failureCount - 1, 0), MAX_POLL_DELAY_MS);

export const OverlayStatusView = (): ReactElement | null => {
  const [status, setStatus] = useState<OverlayStatus | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    let requestNumber = 0;
    let activeController: AbortController | null = null;
    let failureCount = 0;
    let realtimeToken: string | null = null;
    let stopRealtime: (() => void) | null = null;
    let realtimeGeneration = 0;
    let realtimeTerminalClose = false;

    const disconnectRealtime = (): void => {
      realtimeGeneration += 1;
      stopRealtime?.();
      stopRealtime = null;
      realtimeToken = null;
      realtimeTerminalClose = false;
    };

    const connectRealtime = (token: string): void => {
      if (realtimeToken === token && !realtimeTerminalClose) return;
      disconnectRealtime();
      realtimeToken = token;
      const generation = realtimeGeneration;
      void import("./realtime").then(({ connectOverlayRealtime }) => {
        if (disposed || generation !== realtimeGeneration) return;
        const stop = connectOverlayRealtime(token, () => {
          // Let the next successful status poll reopen a socket that reached a
          // terminal close. The HTTP check remains authoritative for revocation.
          if (realtimeToken === token) realtimeTerminalClose = true;
        });
        stopRealtime = stop;
      }).catch(() => {
        // The HTTP status remains available if the optional realtime chunk fails to load.
        if (generation === realtimeGeneration) realtimeToken = null;
      });
    };

    const schedule = (delay: number): void => {
      if (disposed) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void check();
      }, delay);
    };

    const check = async (): Promise<void> => {
      if (disposed) return;
      const currentRequest = ++requestNumber;
      activeController?.abort();
      const token = readTokenFromFragment();
      setStatus(null);
      if (token === null) {
        disconnectRealtime();
        return;
      }
      if (realtimeToken !== null && realtimeToken !== token) disconnectRealtime();

      const controller = new AbortController();
      activeController = controller;
      try {
        const nextStatus = await requestOverlayStatus(token, controller.signal);
        if (currentRequest !== requestNumber) return;
        if (nextStatus !== null) document.documentElement.lang = nextStatus.language;
        setStatus(nextStatus);
        if (nextStatus === null) {
          disconnectRealtime();
          failureCount = Math.min(failureCount + 1, MAX_FAILURE_COUNT);
          schedule(delayFor(failureCount));
          return;
        }
        connectRealtime(token);
        failureCount = 0;
        schedule(POLL_INTERVAL_MS);
      } catch {
        if (currentRequest !== requestNumber) return;
        failureCount = Math.min(failureCount + 1, MAX_FAILURE_COUNT);
        schedule(delayFor(failureCount));
      }
    };

    const handleHashChange = (): void => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      failureCount = 0;
      activeController?.abort();
      void check();
    };

    window.addEventListener("hashchange", handleHashChange);
    void check();

    return () => {
      disposed = true;
      requestNumber++;
      if (timer !== undefined) window.clearTimeout(timer);
      activeController?.abort();
      disconnectRealtime();
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  return status === null ? null : <span style={labelStyle}>{texts[status.language].version} {status.version}</span>;
};

/** Keeps the version view as the default and loads the variable widget only when configured. */
export const OverlayEntry = (): ReactElement => {
  const [config, setConfig] = useState(readOverlayEntryConfig);

  useEffect(() => {
    const handleHashChange = (): void => setConfig(readOverlayEntryConfig());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  if (config.kind === "status") return <OverlayStatusView />;
  return <Suspense fallback={null}>
    <LazyVariableOverlay key={`${config.token ?? ""}:${config.name}:${config.text}`} {...config} />
  </Suspense>;
};
