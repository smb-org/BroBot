import { useEffect, useState } from "react";

import { EVENT_TONES, type EventTone } from "../contracts/values";
import type { PanelEventFilters, PanelEventOrigin } from "../panel-contract";

export type DashboardRoute =
  | { kind: "overview" }
  | { kind: "platform" }
  | { kind: "channel"; channelId: string; section: "overview" | "system" | "members" | "events" | "modules"; filters?: PanelEventFilters }
  | { kind: "module"; channelId: string; moduleId: string };

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
  const tone = params.get("tone");
  const moduleId = params.get("module");
  const actor = params.get("actor");
  const validOrigin: PanelEventOrigin | null = origin === "channel" || origin === "module" ? origin : null;
  const validTone: EventTone | null = tone !== null && EVENT_TONES.includes(tone as EventTone) ? tone as EventTone : null;
  const module = moduleId === null || moduleId.length === 0 ? null : moduleId;
  const person = actor === null || actor.length === 0 ? null : actor;
  return validOrigin === null && validTone === null && module === null && person === null
    ? undefined
    : { origin: validOrigin, module: module, tone: validTone, person };
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
  const channelSections = ["system", "members", "events", "modules"];
  if (segments[0] !== "channels" || (segments.length !== 2 && segments.length !== 3) ||
      (segments.length === 3 && !channelSections.includes(segments[2] ?? ""))) return { kind: "overview" };
  const channelId = decodeSegment(segments[1] ?? "");
  if (channelId === null) return { kind: "overview" };
  const section = segments[2];
  const route: DashboardRoute = {
    kind: "channel",
    channelId,
    section: section === "system" || section === "members" || section === "events" || section === "modules"
      ? section
      : "overview",
  };
  if (route.section !== "events") return route;
  const filters = parseEventFilters(search);
  return filters === undefined ? route : { ...route, filters };
};

export const dashboardRoutePath = (route: DashboardRoute): string => {
  if (route.kind === "overview") return "/";
  if (route.kind === "platform") return "/platform";
  const base = `/channels/${encodeURIComponent(route.channelId)}`;
  if (route.kind === "module") return `${base}/modules/${encodeURIComponent(route.moduleId)}`;
  if (route.section === "overview") return base;
  const path = `${base}/${route.section}`;
  if (route.section !== "events" || route.filters === undefined) return path;
  const params = new URLSearchParams();
  if (route.filters.origin !== null) params.set("origin", route.filters.origin);
  if (route.filters.module !== null) params.set("module", route.filters.module);
  if (route.filters.tone !== null) params.set("tone", route.filters.tone);
  if (route.filters.person !== null) params.set("actor", route.filters.person);
  const query = params.toString();
  return query.length === 0 ? path : `${path}?${query}`;
};

export const navigateToDashboardRoute = (route: DashboardRoute): void => {
  const path = dashboardRoutePath(route);
  if (`${window.location.pathname}${window.location.search}` === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export const useDashboardRoute = (): [DashboardRoute, (route: DashboardRoute) => void] => {
  const [route, setRoute] = useState<DashboardRoute>(() => parseDashboardRoute(window.location.pathname, window.location.search));

  useEffect(() => {
    const onPopState = (): void => { setRoute(parseDashboardRoute(window.location.pathname, window.location.search)); };
    window.addEventListener("popstate", onPopState);
    return () => { window.removeEventListener("popstate", onPopState); };
  }, []);

  const navigate = (nextRoute: DashboardRoute): void => {
    navigateToDashboardRoute(nextRoute);
    setRoute(nextRoute);
  };

  return [route, navigate];
};
