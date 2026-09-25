import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import type { RealtimeEnvelope } from "../realtime-contract";
import { sanitizeOverlayCss } from "../contracts/overlay-css";
import { connectOverlayRealtime } from "./realtime";
import { OverlayCanvas } from "./canvas";
import type { OverlayBootstrapData, OverlayElementData, OverlayLanguage } from "./model";

const LazyLegacyOverlayEntry = lazy(async () => {
  const module = await import("./legacy");
  return { default: module.LegacyOverlayEntry };
});

const renderLegacyOverlay = (onTokenBound: () => void): ReactElement =>
  <Suspense fallback={null}><LazyLegacyOverlayEntry onTokenBound={onTokenBound} /></Suspense>;

const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const RELOAD_DEBOUNCE_MS = 250;
const RELOAD_MAX_WAIT_MS = 1_500;
const LOAD_RETRY_BASE_DELAY_MS = 1_000;
const MAX_LOAD_RETRY_DELAY_MS = 60_000;
const MAX_LOAD_RETRY_ATTEMPT = 6;

interface OverlayShellProperties {
  token: string;
  elementId: string | null;
}

type LoadState = "loading" | "ready" | "unbound" | "error" | "revoked";
interface OverlayLifecycle {
  disposed: boolean;
  revoked: boolean;
  requestNumber: number;
  reloadPending: boolean;
}

const isCurrentRequest = (lifecycle: OverlayLifecycle, requestNumber: number): boolean =>
  !lifecycle.disposed && requestNumber === lifecycle.requestNumber;

const takePendingReload = (lifecycle: OverlayLifecycle): boolean => {
  if (!lifecycle.reloadPending) return false;
  lifecycle.reloadPending = false;
  return true;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

const isOverlayLanguage = (value: unknown): value is OverlayLanguage => value === "de" || value === "en";

const isOverlayElement = (value: unknown): value is OverlayElementData => isRecord(value) &&
  typeof value.id === "string" && value.id.length > 0 && typeof value.kind === "string" &&
  typeof value.label === "string" && (value.variableName === null || typeof value.variableName === "string") &&
  typeof value.text === "string" && isInteger(value.x) && isInteger(value.y) &&
  isInteger(value.scalePercent) && value.scalePercent >= 25 && value.scalePercent <= 400 &&
  isInteger(value.z) && typeof value.inComposition === "boolean";

const parseBootstrap = (value: unknown): OverlayBootstrapData | null => {
  if (!isRecord(value) || !isOverlayLanguage(value.language) || !isRecord(value.variables)) return null;
  const variables: Record<string, number> = {};
  for (const [name, variableValue] of Object.entries(value.variables)) {
    if (VARIABLE_NAME_PATTERN.test(name) && isInteger(variableValue)) variables[name] = variableValue;
  }
  if (value.overlay === null) return { language: value.language, overlay: null, variables };
  if (!isRecord(value.overlay) || typeof value.overlay.id !== "string" || value.overlay.id.length === 0 ||
      !isInteger(value.overlay.revision) || value.overlay.revision < 1 ||
      !isInteger(value.overlay.width) || value.overlay.width < 1 ||
      !isInteger(value.overlay.height) || value.overlay.height < 1 ||
      typeof value.overlay.css !== "string" || value.overlay.css.length > 16_000 ||
      !Array.isArray(value.overlay.elements)) return null;
  return {
    language: value.language,
    overlay: {
      id: value.overlay.id,
      revision: value.overlay.revision,
      width: value.overlay.width,
      height: value.overlay.height,
      css: value.overlay.css,
      elements: value.overlay.elements.filter(isOverlayElement),
    },
    variables,
  };
};

const referencedVariableNames = (bootstrap: OverlayBootstrapData): Set<string> => new Set(
  bootstrap.overlay?.elements.flatMap((element) =>
    element.variableName !== null && VARIABLE_NAME_PATTERN.test(element.variableName) ? [element.variableName] : []) ?? [],
);

const applyVariableMessage = (
  bootstrap: OverlayBootstrapData,
  message: RealtimeEnvelope<"variables.changed">,
): OverlayBootstrapData => {
  const referenced = referencedVariableNames(bootstrap);
  let variables = { ...bootstrap.variables };
  for (const item of message.payload.set) {
    if (referenced.has(item.name) && Number.isSafeInteger(item.value)) variables[item.name] = item.value;
  }
  for (const name of message.payload.removed) {
    if (referenced.has(name)) variables = Object.fromEntries(
      Object.entries(variables).filter(([candidate]) => candidate !== name),
    );
  }
  return { ...bootstrap, variables };
};

const applyPendingVariableChanges = (
  bootstrap: OverlayBootstrapData,
  changes: ReadonlyMap<string, number | null>,
): OverlayBootstrapData => {
  const referenced = referencedVariableNames(bootstrap);
  let variables = { ...bootstrap.variables };
  for (const [name, value] of changes) {
    if (!referenced.has(name)) continue;
    if (value === null) variables = Object.fromEntries(
      Object.entries(variables).filter(([candidate]) => candidate !== name),
    );
    else variables[name] = value;
  }
  return { ...bootstrap, variables };
};

const installOverlayCss = (css: string): (() => void) => {
  let style = document.head.querySelector<HTMLStyleElement>("style[data-brobot-overlay-css]");
  if (style === null) {
    style = document.createElement("style");
    style.dataset.brobotOverlayCss = "";
    document.head.appendChild(style);
  }
  const installedStyle = style;
  // Keep this sanitizer for older saved CSS; the overlay document CSP enforces
  // the actual resource policy, including CSS syntaxes this parser may not see.
  installedStyle.textContent = sanitizeOverlayCss(css);
  return () => installedStyle.remove();
};

/** Owns the source's bootstrap and realtime socket, then passes shared data to the canvas. */
export const OverlayShell = ({ token, elementId }: OverlayShellProperties): ReactElement | null => {
  const [bootstrap, setBootstrap] = useState<OverlayBootstrapData | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const bootstrapRef = useRef<OverlayBootstrapData | null>(null);
  const [bindingVersion, setBindingVersion] = useState(0);
  const reloadLegacyShell = useCallback((): void => { setBindingVersion((version) => version + 1); }, []);

  useEffect(() => {
    const lifecycle: OverlayLifecycle = { disposed: false, revoked: false, requestNumber: 0, reloadPending: false };
    let activeController: AbortController | null = null;
    let loadInFlight = false;
    let realtimeStarted = false;
    let stopRealtime: () => void = () => undefined;
    let reloadTimer: number | null = null;
    let maximumReloadTimer: number | null = null;
    let retryTimer: number | null = null;
    let retryAttempt = 0;
    const pendingVariableChanges = new Map<string, number | null>();

    const install = (next: OverlayBootstrapData | null, nextState: LoadState): void => {
      bootstrapRef.current = next;
      setBootstrap(next);
      setLoadState(nextState);
    };

    const stopRetryTimer = (): void => {
      if (retryTimer === null) return;
      window.clearTimeout(retryTimer);
      retryTimer = null;
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

    const scheduleRetry = (): void => {
      if (lifecycle.disposed || retryTimer !== null) return;
      const delay = Math.min(LOAD_RETRY_BASE_DELAY_MS * 2 ** retryAttempt, MAX_LOAD_RETRY_DELAY_MS);
      retryAttempt = Math.min(retryAttempt + 1, MAX_LOAD_RETRY_ATTEMPT);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void load();
      }, delay);
    };

    const load = async (): Promise<void> => {
      if (lifecycle.disposed || lifecycle.revoked) return;
      if (loadInFlight) {
        lifecycle.reloadPending = true;
        return;
      }
      const currentRequest = ++lifecycle.requestNumber;
      const controller = new AbortController();
      activeController = controller;
      loadInFlight = true;
      try {
        const response = await fetch("/api/overlay/bootstrap", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!isCurrentRequest(lifecycle, currentRequest)) return;
        if (!response.ok) {
          if (response.status >= 500 || response.status === 429) throw new Error("Overlay bootstrap request failed.");
          install(null, "error");
          stopRetryTimer();
          return;
        }
        let payload: unknown;
        try {
          const responseText = await response.text();
          if (!isCurrentRequest(lifecycle, currentRequest)) return;
          payload = JSON.parse(responseText) as unknown;
        } catch {
          throw new Error("Overlay bootstrap response was not valid JSON.");
        }
        const parsed = parseBootstrap(payload);
        if (parsed === null) throw new Error("Overlay bootstrap response had an invalid shape.");
        const next = applyPendingVariableChanges(parsed, pendingVariableChanges);
        pendingVariableChanges.clear();
        document.documentElement.lang = next.language;
        install(next, next.overlay === null ? "unbound" : "ready");
        if (next.overlay !== null) startRealtime();
        retryAttempt = 0;
        stopRetryTimer();
      } catch {
        if (!isCurrentRequest(lifecycle, currentRequest) || controller.signal.aborted) return;
        // Once a source has rendered successfully, transient bootstrap failures
        // must not blank the stream. Keep the last frame while retrying.
        if (bootstrapRef.current === null) install(null, "error");
        scheduleRetry();
      } finally {
        if (activeController === controller) activeController = null;
        loadInFlight = false;
        if (takePendingReload(lifecycle)) {
          stopReloadTimer();
          stopMaximumReloadTimer();
          stopRetryTimer();
          void load();
        }
      }
    };

    const scheduleReload = (): void => {
      stopReloadTimer();
      reloadTimer = window.setTimeout(() => {
        reloadTimer = null;
        stopMaximumReloadTimer();
        stopRetryTimer();
        void load();
      }, RELOAD_DEBOUNCE_MS);
      maximumReloadTimer ??= window.setTimeout(() => {
        maximumReloadTimer = null;
        stopReloadTimer();
        stopRetryTimer();
        void load();
      }, RELOAD_MAX_WAIT_MS);
    };

    const startRealtime = (): void => {
      if (realtimeStarted || lifecycle.disposed || lifecycle.revoked) return;
      realtimeStarted = true;
      stopRealtime = connectOverlayRealtime(token, () => {
        lifecycle.revoked = true;
        lifecycle.requestNumber++;
        lifecycle.reloadPending = false;
        activeController?.abort();
        activeController = null;
        stopReloadTimer();
        stopMaximumReloadTimer();
        stopRetryTimer();
        pendingVariableChanges.clear();
        install(null, "revoked");
      }, {
        onOpen: () => {
          stopReloadTimer();
          stopMaximumReloadTimer();
          stopRetryTimer();
          retryAttempt = 0;
          void load();
        },
        onMessage: (message) => {
          const current = bootstrapRef.current;
          if (loadInFlight || current === null) {
            for (const item of message.payload.set) pendingVariableChanges.set(item.name, item.value);
            for (const name of message.payload.removed) pendingVariableChanges.set(name, null);
          }
          if (current === null) return;
          const next = applyVariableMessage(current, message);
          bootstrapRef.current = next;
          setBootstrap(next);
        },
        onOverlayChanged: (message) => {
          const current = bootstrapRef.current;
          if (current === null) {
            lifecycle.reloadPending = true;
            return;
          }
          if (message.payload.overlayId === current.overlay?.id) scheduleReload();
        },
      });
    };

    void load();
    return () => {
      lifecycle.disposed = true;
      lifecycle.requestNumber++;
      activeController?.abort();
      stopReloadTimer();
      stopMaximumReloadTimer();
      stopRetryTimer();
      stopRealtime();
    };
  }, [bindingVersion, token]);

  useEffect(() => {
    const css = bootstrap?.overlay?.css;
    if (css === undefined) return;
    return installOverlayCss(css);
  }, [bootstrap?.overlay?.css]);

  if (loadState === "unbound") {
    if (elementId !== null) return null;
    return renderLegacyOverlay(reloadLegacyShell);
  }
  if (loadState === "revoked") return null;
  if (loadState === "error") return null;
  if (bootstrap?.overlay === null || bootstrap === null) return null;
  return <OverlayCanvas
    overlay={bootstrap.overlay}
    language={bootstrap.language}
    variables={bootstrap.variables}
    elementId={elementId}
  />;
};
