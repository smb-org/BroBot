import { useEffect, useState } from "react";

export type DashboardRoute =
  | { kind: "overview" }
  | { kind: "channel"; channelId: string; section: "overview" | "system" | "members" | "events" | "modules" };

const decodeSegment = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
};

export const parseDashboardRoute = (pathname: string): DashboardRoute => {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return { kind: "overview" };
  const channelSections = ["system", "members", "events", "modules"];
  if (segments[0] !== "channels" || (segments.length !== 2 && segments.length !== 3) ||
      (segments.length === 3 && !channelSections.includes(segments[2] ?? ""))) return { kind: "overview" };
  const channelId = decodeSegment(segments[1] ?? "");
  if (channelId === null) return { kind: "overview" };
  const section = segments[2];
  return {
    kind: "channel",
    channelId,
    section: section === "system" || section === "members" || section === "events" || section === "modules"
      ? section
      : "overview",
  };
};

export const dashboardRoutePath = (route: DashboardRoute): string => {
  if (route.kind === "overview") return "/";
  const base = `/channels/${encodeURIComponent(route.channelId)}`;
  if (route.section === "overview") return base;
  return `${base}/${route.section}`;
};

export const navigateToDashboardRoute = (route: DashboardRoute): void => {
  const path = dashboardRoutePath(route);
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export const useDashboardRoute = (): [DashboardRoute, (route: DashboardRoute) => void] => {
  const [route, setRoute] = useState<DashboardRoute>(() => parseDashboardRoute(window.location.pathname));

  useEffect(() => {
    const onPopState = (): void => { setRoute(parseDashboardRoute(window.location.pathname)); };
    window.addEventListener("popstate", onPopState);
    return () => { window.removeEventListener("popstate", onPopState); };
  }, []);

  const navigate = (nextRoute: DashboardRoute): void => {
    navigateToDashboardRoute(nextRoute);
    setRoute(nextRoute);
  };

  return [route, navigate];
};
