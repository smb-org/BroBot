import { platformTexts } from "./labels";
import type { DashboardTexts } from "./locale";
import type { DashboardRoute } from "./router";
import type { BotModule, ModuleLanguage } from "../modules/contract";

export type NavPageGroup = "operation" | "channel" | "modules" | "platform";

type ChannelSection = Extract<DashboardRoute, { kind: "channel" }>["section"];

/**
 * One entry per sidebar page (#208): the single source `PanelSidebar`
 * (main.tsx) and `ChannelSpotlight` (spotlight.tsx) both read, so a page
 * added to one shows up in the other automatically instead of drifting the
 * way Spotlight did until #208 (it only knew modules/commands/members).
 * Labels and group headings come from the same navigation/platform catalogs
 * the sidebar renders from; `keywords` are Spotlight-only match aliases
 * (not shown anywhere), so they don't need a translation-catalog entry.
 */
export interface NavPageDefinition {
  id: string;
  group: NavPageGroup;
  iconKind: string;
  route: (channelId: string) => DashboardRoute;
  label: (texts: DashboardTexts) => string;
  keywords: readonly string[];
}

export interface RegisteredModuleNavEntry {
  id: string;
  moduleId: string;
  label: string;
  description?: string;
  iconKind: string;
  keywords: readonly string[];
  route: DashboardRoute;
}

/** Converts module-owned navigation declarations into host routes and labels. */
export const registeredModuleNavEntries = (
  modules: readonly Pick<BotModule, "id" | "navigationEntries">[],
  channelId: string,
  language: ModuleLanguage,
): readonly RegisteredModuleNavEntry[] => modules.flatMap((module) => (module.navigationEntries ?? []).map((entry) => ({
  id: `${module.id}:${entry.id}`,
  moduleId: module.id,
  label: entry.label[language],
  ...(entry.description === undefined ? {} : { description: entry.description[language] }),
  iconKind: entry.iconKind,
  keywords: entry.keywords ?? [],
  route: { kind: "module", channelId, moduleId: module.id },
})));

const channelRoute = (section: ChannelSection) => (channelId: string): DashboardRoute => ({ kind: "channel", channelId, section });

export const NAV_PAGES: readonly NavPageDefinition[] = [
  {
    id: "events",
    group: "operation",
    iconKind: "events",
    route: channelRoute("events"),
    label: (texts) => texts.navigation.events,
    keywords: ["log", "logs", "protokoll", "logbuch", "verlauf", "history"],
  },
  {
    id: "overview",
    group: "channel",
    iconKind: "channel",
    route: channelRoute("overview"),
    label: (texts) => texts.navigation.channel,
    keywords: ["overview", "uebersicht", "home", "start"],
  },
  {
    id: "system",
    group: "channel",
    iconKind: "system",
    route: channelRoute("system"),
    label: (texts) => texts.navigation.system,
    keywords: ["settings", "einstellungen", "konfiguration", "configuration"],
  },
  {
    id: "members",
    group: "channel",
    iconKind: "members",
    route: channelRoute("members"),
    label: (texts) => texts.navigation.members,
    keywords: ["people", "team", "mitarbeiter", "crew"],
  },
  {
    id: "variables",
    group: "channel",
    iconKind: "variable",
    route: channelRoute("variables"),
    label: (texts) => texts.navigation.variables,
    keywords: ["variable", "variablen", "counter", "zaehler"],
  },
  {
    id: "overlays",
    group: "channel",
    iconKind: "token",
    route: channelRoute("overlays"),
    label: (texts) => texts.navigation.overlays,
    keywords: ["overlay", "obs", "link", "links", "token", "widget"],
  },
  {
    id: "audit",
    group: "channel",
    iconKind: "audit",
    route: channelRoute("audit"),
    label: (texts) => texts.navigation.audit,
    keywords: ["audit", "changes", "aenderungen", "protokoll"],
  },
  {
    id: "modules",
    group: "modules",
    iconKind: "modules",
    route: channelRoute("modules"),
    label: (texts) => texts.navigation.module,
    keywords: ["modules", "module", "modulliste", "plugins"],
  },
  {
    id: "platform",
    group: "platform",
    iconKind: "members",
    route: () => ({ kind: "platform" }),
    label: () => platformTexts().navigation,
    keywords: ["operator", "betreiber", "admin", "platform", "plattform"],
  },
];

/** Looks up a known page by id -- for a page every caller expects to always exist (e.g. the sidebar's own "modules" entry point), instead of an `Array.find` result callers would have to null-check for no reason. */
export const navPageById = (id: string): NavPageDefinition => {
  const page = NAV_PAGES.find((candidate) => candidate.id === id);
  if (page === undefined) throw new Error(`Unknown nav page: ${id}`);
  return page;
};

/** Section heading for a page's group -- same catalogs the sidebar renders from, so a relabel there can't drift out of sync here. */
export const navPageGroupHeading = (group: NavPageGroup, texts: DashboardTexts): string => {
  switch (group) {
    case "operation": return texts.navigation.operationSection;
    case "channel": return texts.navigation.channel;
    case "modules": return texts.navigation.module;
    case "platform": return platformTexts().navigation;
  }
};

/**
 * The sidebar's only role-gated group: the platform page appears only for
 * an account-wide platform admin, same flag `PanelSidebar` checks --
 * never a per-channel role, and never shown just because a channel's own
 * role happens to be named "operator".
 */
export const visibleNavPages = (context: { isPlatformAdmin: boolean }): readonly NavPageDefinition[] =>
  NAV_PAGES.filter((page) => page.group !== "platform" || context.isPlatformAdmin);

export const navPageActive = (page: NavPageDefinition, route: DashboardRoute): boolean =>
  page.group === "platform" ? route.kind === "platform" : route.kind === "channel" && route.section === page.id;
