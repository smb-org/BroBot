import { useEffect, useState } from "react";

import { EVENT_TONES, type AuditArea, type EventTone } from "../contracts/values";
import { isAuditArea } from "./audit/areas";
import type { PanelAuditFilters, PanelEventFilters, PanelEventOrigin } from "../panel-contract";
import { runDashboardNavigationGuards } from "./ui/navigation-guard";

export type DashboardRoute =
  | { kind: "overview" }
  | { kind: "platform" }
  | {
    kind: "channel";
    channelId: string;
    section: "overview" | "system" | "members" | "variables" | "overlays" | "events" | "modules" | "audit";
    overlayId?: string;
    filters?: PanelEventFilters;
    auditFilters?: PanelAuditFilters;
  }
  | { kind: "module"; channelId: string; moduleId: string };

/** Routes whose page content cannot work until the installation bot is signed in. */
export const dashboardRouteRequiresBot = (route: DashboardRoute): boolean =>
  route.kind === "overview" || route.kind === "module" || (route.kind === "channel" &&
    route.section !== "system" && route.section !== "audit" && route.section !== "variables" && route.section !== "overlays");

let suppressNextPopState = false;
let historyIndex = 0;

const historyIndexFromState = (state: unknown): number | null => {
  if (typeof state !== "object" || state === null || Array.isArray(state)) return null;
  const index: unknown = Reflect.get(state, "__brobotRouteIndex");
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : null;
};

const historyStateWithIndex = (index: number): Record<string, unknown> => {
  const current: unknown = window.history.state;
  return {
    ...(typeof current === "object" && current !== null && !Array.isArray(current) ? current : {}),
    __brobotRouteIndex: index,
  };
};

const decodeSegment = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
};

const parseEventFilters = (search: string): PanelEventFilters | undefined => {
  const params = new URLSearchParams(search);
  const origin = params.get("origin");
  const tones = [...new Set(params.getAll("tone"))];
  const moduleId = params.get("module");
  const actor = params.get("actor");
  const validOrigin: PanelEventOrigin | null = origin === "channel" || origin === "module" ? origin : null;
  const validTones = tones.filter((tone): tone is EventTone => EVENT_TONES.includes(tone as EventTone));
  const validTone: EventTone | null = validTones.length === 1 ? validTones[0] ?? null : null;
  const module = moduleId === null || moduleId.length === 0 ? null : moduleId;
  const person = actor === null || actor.length === 0 ? null : actor;
  return validOrigin === null && validTone === null && validTones.length < 2 && module === null && person === null
    ? undefined
    : {
      origin: validOrigin,
      module,
      tone: validTone,
      ...(validTones.length > 1 ? { tones: validTones } : {}),
      person,
    };
};

const parseAuditFilters = (search: string): PanelAuditFilters | undefined => {
  const params = new URLSearchParams(search);
  const actor = params.get("actor");
  const area = params.get("area");
  const validArea: AuditArea | null = area !== null && isAuditArea(area) ? area : null;
  const person = actor === null || actor.length === 0 ? null : actor;
  return validArea === null && person === null ? undefined : { person, area: validArea };
};

export const parseDashboardRoute = (pathname: string, search = ""): DashboardRoute => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return { kind: "overview" };
  // "/platform" is current; "/betreiber" is kept as a parse-only alias so
  // bookmarks and shared links from before the rename still resolve --
  // `dashboardRoutePath` only ever emits "/platform".
  if (segments.length === 1 && (segments[0] === "platform" || segments[0] === "betreiber")) return { kind: "platform" };
  if (segments.length === 4 && segments[0] === "channels" && segments[2] === "modules") {
    const channelId = decodeSegment(segments[1] ?? "");
    const moduleId = decodeSegment(segments[3] ?? "");
    if (channelId === null || moduleId === null) return { kind: "overview" };
    return { kind: "module", channelId, moduleId };
  }
  const channelSections = ["system", "members", "variables", "overlays", "overlay-links", "events", "modules", "audit"];
  if (segments[0] !== "channels" || (segments.length !== 2 && segments.length !== 3) ||
      (segments.length === 3 && !channelSections.includes(segments[2] ?? ""))) return { kind: "overview" };
  const channelId = decodeSegment(segments[1] ?? "");
  if (channelId === null) return { kind: "overview" };
  const section = segments[2];
  const route: DashboardRoute = {
    kind: "channel",
    channelId,
    section: section === "overlay-links" ? "overlays"
      : section === "system" || section === "members" || section === "variables" || section === "overlays" || section === "events" || section === "modules" || section === "audit"
      ? section
      : "overview",
  };
  if (route.section === "overlays") {
    const overlayId = new URLSearchParams(search).get("overlay");
    return overlayId === null || overlayId.length === 0 ? route : { ...route, overlayId };
  }
  if (route.section === "events") {
    const filters = parseEventFilters(search);
    return filters === undefined ? route : { ...route, filters };
  }
  if (route.section === "audit") {
    const auditFilters = parseAuditFilters(search);
    return auditFilters === undefined ? route : { ...route, auditFilters };
  }
  return route;
};

export const dashboardRoutePath = (route: DashboardRoute): string => {
  if (route.kind === "overview") return "/";
  if (route.kind === "platform") return "/platform";
  const base = `/channels/${encodeURIComponent(route.channelId)}`;
  if (route.kind === "module") return `${base}/modules/${encodeURIComponent(route.moduleId)}`;
  if (route.section === "overview") return base;
  const path = `${base}/${route.section}`;
  if (route.section === "overlays" && route.overlayId !== undefined) {
    return `${path}?${new URLSearchParams({ overlay: route.overlayId }).toString()}`;
  }
  if (route.section === "events" && route.filters !== undefined) {
    const params = new URLSearchParams();
    if (route.filters.origin !== null) params.set("origin", route.filters.origin);
    if (route.filters.module !== null) params.set("module", route.filters.module);
    if (route.filters.tones !== undefined && route.filters.tones.length > 1) {
      for (const tone of route.filters.tones) params.append("tone", tone);
    } else if (route.filters.tone !== null) params.set("tone", route.filters.tone);
    if (route.filters.person !== null) params.set("actor", route.filters.person);
    const query = params.toString();
    return query.length === 0 ? path : `${path}?${query}`;
  }
  if (route.section === "audit" && route.auditFilters !== undefined) {
    const params = new URLSearchParams();
    if (route.auditFilters.person !== null) params.set("actor", route.auditFilters.person);
    if (route.auditFilters.area !== null) params.set("area", route.auditFilters.area);
    const query = params.toString();
    return query.length === 0 ? path : `${path}?${query}`;
  }
  return path;
};

export const navigateToDashboardRoute = (route: DashboardRoute, onNavigated?: () => void): void => {
  const path = dashboardRoutePath(route);
  runDashboardNavigationGuards(() => {
    if (`${window.location.pathname}${window.location.search}` !== path) {
      historyIndex += 1;
      window.history.pushState(historyStateWithIndex(historyIndex), "", path);
      suppressNextPopState = true;
      window.dispatchEvent(new PopStateEvent("popstate"));
      suppressNextPopState = false;
    }
    onNavigated?.();
  }, () => undefined);
};

export const replaceDashboardRoute = (route: DashboardRoute): void => {
  const path = dashboardRoutePath(route);
  if (`${window.location.pathname}${window.location.search}` === path) return;
  runDashboardNavigationGuards(() => {
    window.history.replaceState(historyStateWithIndex(historyIndex), "", path);
    suppressNextPopState = true;
    window.dispatchEvent(new PopStateEvent("popstate"));
    suppressNextPopState = false;
  }, () => undefined);
};

export const useDashboardRoute = (): [DashboardRoute, (route: DashboardRoute, onNavigated?: () => void) => void] => {
  const [route, setRoute] = useState<DashboardRoute>(() => parseDashboardRoute(window.location.pathname, window.location.search));

  useEffect(() => {
    const currentIndex = historyIndexFromState(window.history.state);
    historyIndex = currentIndex ?? 0;
    if (currentIndex === null) window.history.replaceState(historyStateWithIndex(historyIndex), "", window.location.href);
    const canonicalPath = dashboardRoutePath(parseDashboardRoute(window.location.pathname, window.location.search));
    if (`${window.location.pathname}${window.location.search}` !== canonicalPath) {
      window.history.replaceState(historyStateWithIndex(historyIndex), "", canonicalPath);
    }
    const onPopState = (): void => {
      const targetRoute = parseDashboardRoute(window.location.pathname, window.location.search);
      const targetIndex = historyIndexFromState(window.history.state);
      if (suppressNextPopState) {
        setRoute(targetRoute);
        if (targetIndex !== null) historyIndex = targetIndex;
        return;
      }
      if (targetIndex !== null && targetIndex === historyIndex) {
        setRoute(targetRoute);
        return;
      }
      const previousIndex = historyIndex;
      const undoDelta = targetIndex === null || targetIndex < previousIndex ? 1 : -1;
      runDashboardNavigationGuards(() => {
        if (targetIndex !== null) historyIndex = targetIndex;
        setRoute(targetRoute);
      }, () => { window.history.go(undoDelta); });
    };
    window.addEventListener("popstate", onPopState);
    return () => { window.removeEventListener("popstate", onPopState); };
  }, []);

  const navigate = (nextRoute: DashboardRoute, onNavigated?: () => void): void => {
    navigateToDashboardRoute(nextRoute, () => {
      setRoute(nextRoute);
      onNavigated?.();
    });
  };

  return [route, navigate];
};
