import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import type { ModuleLanguage } from "../modules/contract";

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
      if (token === null) return;

      const controller = new AbortController();
      activeController = controller;
      try {
        const nextStatus = await requestOverlayStatus(token, controller.signal);
        if (currentRequest !== requestNumber) return;
        if (nextStatus !== null) document.documentElement.lang = nextStatus.language;
        setStatus(nextStatus);
        if (nextStatus === null) {
          failureCount = Math.min(failureCount + 1, MAX_FAILURE_COUNT);
          schedule(delayFor(failureCount));
          return;
        }
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
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  return status === null ? null : <span style={labelStyle}>{texts[status.language].version} {status.version}</span>;
};
