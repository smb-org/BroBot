import { platformTexts } from "./labels";
import type { DashboardTexts } from "./locale";
import type { DashboardRoute } from "./router";
import { modulePermissionsAreMissing } from "./channel-health";
import type { ChannelRole } from "../contracts/values";
import type { BotModule, ModuleLanguage, ModuleNavigationCategory } from "../modules/contract";

export const DASHBOARD_NAVIGATION_CATEGORIES = ["chat", "participation", "twitch", "data", "stream", "admin"] as const;
export type DashboardNavigationCategory = (typeof DASHBOARD_NAVIGATION_CATEGORIES)[number];

/** Every module contract category has an explicit home in the dashboard shell. */
export const MODULE_NAVIGATION_CATEGORY_GROUPS = {
  chat: "chat",
  participation: "participation",
  twitch: "twitch",
  data: "data",
  stream: "stream",
  admin: "admin",
} as const satisfies Readonly<Record<ModuleNavigationCategory, DashboardNavigationCategory>>;

type ChannelSection = Extract<DashboardRoute, { kind: "channel" }>["section"];

interface DashboardNavigationEntry {
  id: string;
  pageId?: string;
  moduleId?: string;
  category: DashboardNavigationCategory;
  area: "live" | "setup";
  label: string;
  description?: string;
  iconKind: string | null;
  keywords: readonly string[];
  route: DashboardRoute;
  sidebarVisible: boolean;
}

export interface DashboardNavigationGroup {
  category: DashboardNavigationCategory;
  heading: string;
  entries: readonly DashboardNavigationEntry[];
}

export interface ModuleNavigationState {
  id: string;
  enabled: boolean;
  missingBroadcasterScopes?: readonly string[];
}

interface NavPageDefinition {
  id: string;
  category: DashboardNavigationCategory;
  area: "live" | "setup";
  iconKind: string;
  route: (channelId: string) => DashboardRoute;
  label: (texts: DashboardTexts) => string;
  keywords: readonly string[];
  requiresChannel: boolean;
}

type ModuleNavigationDefinition = Pick<BotModule, "id" | "navigationCategory" | "navigationEntries">;

/** Module pages are hidden from the sidebar when disabled, blocked, or unavailable to the current channel member. */
const moduleNavigationIsVisible = (state: ModuleNavigationState, memberRole: ChannelRole | null): boolean =>
  memberRole !== null && state.enabled && !modulePermissionsAreMissing(state);

export const visibleModuleNavigationIds = (
  moduleStates: readonly ModuleNavigationState[],
  memberRole: ChannelRole | null,
): ReadonlySet<string> => new Set(
  moduleStates.filter((state) => moduleNavigationIsVisible(state, memberRole)).map((state) => state.id),
);

const channelRoute = (section: ChannelSection) => (channelId: string): DashboardRoute => ({ kind: "channel", channelId, section });

const NAV_PAGES: readonly NavPageDefinition[] = [
  {
    id: "live",
    category: "stream",
    area: "live",
    iconKind: "channel",
    route: () => ({ kind: "overview" }),
    label: (texts) => texts.navigation.live,
    keywords: ["overview", "cockpit", "stream", "home", "start"],
    requiresChannel: false,
  },
  {
    id: "overview",
    category: "stream",
    area: "live",
    iconKind: "channel",
    route: channelRoute("overview"),
    label: (texts) => texts.navigation.channel,
    keywords: ["overview", "kanal", "channel"],
    requiresChannel: true,
  },
  {
    id: "overlays",
    category: "stream",
    area: "setup",
    iconKind: "overlays",
    route: channelRoute("overlays"),
    label: (texts) => texts.navigation.overlays,
    keywords: ["overlay", "obs", "link", "links", "token", "widget"],
    requiresChannel: true,
  },
  {
    id: "location-weather",
    category: "data",
    area: "setup",
    iconKind: "weather",
    route: channelRoute("location-weather"),
    label: (texts) => texts.navigation.locationWeather,
    keywords: ["location", "standort", "weather", "wetter", "place", "ort"],
    requiresChannel: true,
  },
  {
    id: "modules",
    category: "admin",
    area: "setup",
    iconKind: "modules",
    route: channelRoute("modules"),
    label: (texts) => texts.navigation.manageModules,
    keywords: ["modules", "module", "modulliste", "plugins"],
    requiresChannel: true,
  },
  {
    id: "members",
    category: "admin",
    area: "setup",
    iconKind: "members",
    route: channelRoute("members"),
    label: (texts) => texts.navigation.members,
    keywords: ["people", "team", "mitarbeiter", "crew"],
    requiresChannel: true,
  },
  {
    id: "variables",
    category: "admin",
    area: "setup",
    iconKind: "variable",
    route: channelRoute("variables"),
    label: (texts) => texts.navigation.variables,
    keywords: ["variable", "variablen", "counter", "zaehler"],
    requiresChannel: true,
  },
  {
    id: "events",
    category: "admin",
    area: "setup",
    iconKind: "events",
    route: channelRoute("events"),
    label: (texts) => texts.events.channelEvents,
    keywords: ["events", "ereignisse", "eventsub", "history", "kanalereignisse"],
    requiresChannel: true,
  },
  {
    id: "audit",
    category: "admin",
    area: "setup",
    iconKind: "audit",
    route: channelRoute("audit"),
    label: (texts) => texts.navigation.audit,
    keywords: ["audit", "changes", "aenderungen", "protokoll", "log"],
    requiresChannel: true,
  },
  {
    id: "system",
    category: "admin",
    area: "setup",
    iconKind: "system",
    route: channelRoute("system"),
    label: (texts) => texts.navigation.system,
    keywords: ["settings", "einstellungen", "konfiguration", "configuration"],
    requiresChannel: true,
  },
  {
    id: "platform",
    category: "admin",
    area: "setup",
    iconKind: "platform",
    route: () => ({ kind: "platform" }),
    label: () => platformTexts().navigation,
    keywords: ["operator", "betreiber", "admin", "platform", "plattform"],
    requiresChannel: false,
  },
];

const registeredModuleEntries = (
  modules: readonly ModuleNavigationDefinition[],
  channelId: string,
  language: ModuleLanguage,
  moduleStates: readonly ModuleNavigationState[],
  memberRole: ChannelRole | null,
  fallbackLabel: (moduleId: string) => string,
): DashboardNavigationEntry[] => {
  const visibleModules = visibleModuleNavigationIds(moduleStates, memberRole);
  return modules.flatMap((module): DashboardNavigationEntry[] => {
    // The channel-events history is a dedicated page; its mandatory runtime
    // module remains available from the Modules workspace without a duplicate
    // generic module link in the sidebar or command palette.
    if (module.id === "channel_events") return [];
    const category = MODULE_NAVIGATION_CATEGORY_GROUPS[module.navigationCategory];
    const route: DashboardRoute = { kind: "module", channelId, moduleId: module.id };
    const entries = module.navigationEntries ?? [];
    if (entries.length === 0) {
      return [{
        id: `module:${module.id}`,
        moduleId: module.id,
        category,
        area: "setup" as const,
        label: fallbackLabel(module.id),
        iconKind: null,
        keywords: [],
        route,
        sidebarVisible: visibleModules.has(module.id),
      }];
    }
    return entries.map((entry) => ({
      id: `module:${module.id}:${entry.id}`,
      moduleId: module.id,
      category,
      area: "setup" as const,
      label: entry.label[language],
      ...(entry.description === undefined ? {} : { description: entry.description[language] }),
      iconKind: entry.iconKind,
      keywords: entry.keywords ?? [],
      route,
      sidebarVisible: visibleModules.has(module.id),
    }));
  });
};
/** One localized navigation list feeds both the sidebar and the command palette. */
export const dashboardNavigationGroups = (
  context: { isPlatformAdmin: boolean },
  channelId: string,
  texts: DashboardTexts,
  modules: readonly ModuleNavigationDefinition[],
  moduleStates: readonly ModuleNavigationState[],
  memberRole: ChannelRole | null,
  language: ModuleLanguage,
  fallbackLabel: (moduleId: string) => string,
): readonly DashboardNavigationGroup[] => {
  const pages = NAV_PAGES
    .filter((page) => (page.id !== "platform" || context.isPlatformAdmin) && (!page.requiresChannel || channelId.length > 0))
    .map((page): DashboardNavigationEntry => ({
      id: `page:${page.id}`,
      pageId: page.id,
      category: page.category,
      area: page.area,
      label: page.label(texts),
      iconKind: page.iconKind,
      keywords: page.keywords,
      route: page.route(channelId),
      sidebarVisible: page.area === "setup",
    }));
  const moduleEntries = channelId.length === 0
    ? []
    : registeredModuleEntries(modules, channelId, language, moduleStates, memberRole, fallbackLabel);

  return DASHBOARD_NAVIGATION_CATEGORIES.flatMap((category) => {
    const categoryPages = pages.filter((entry) => entry.category === category);
    const categoryModules = moduleEntries.filter((entry) => entry.category === category);
    let entries: DashboardNavigationEntry[];
    if (category === "admin") {
      const beforeAudit = categoryPages.filter((entry) => entry.pageId !== "audit" && entry.pageId !== "events" && entry.pageId !== "platform");
      const channelEvents = categoryPages.filter((entry) => entry.pageId === "events");
      const afterAudit = categoryPages.filter((entry) => entry.pageId === "platform");
      const audit = categoryPages.filter((entry) => entry.pageId === "audit");
      entries = [...beforeAudit, ...categoryModules, ...channelEvents, ...audit, ...afterAudit];
    } else if (category === "stream") {
      entries = [...categoryPages, ...categoryModules];
    } else {
      entries = [...categoryModules, ...categoryPages];
    }
    return entries.length === 0 ? [] : [{ category, heading: texts.navigation.moduleCategories[category], entries }];
  });
};
