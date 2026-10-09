import type { PanelAuditFilters, PanelEventFilters } from "../../panel-contract";

export type ChannelQueryParams = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type ModuleQueryKey = readonly ["channel", string, "module", string, string];
export type ChannelQueryKey = readonly ["channel", string, string, ...ChannelQueryParams[]] | ModuleQueryKey;

export const queryKeys = {
  channels: () => ["channels"] as const,
  channel: (channelId: string, resource: string, ...params: ChannelQueryParams[]): ChannelQueryKey => [
    "channel",
    channelId,
    resource,
    ...params,
  ],
  module: (channelId: string, moduleId: string, part: string): ModuleQueryKey => [
    "channel",
    channelId,
    "module",
    moduleId,
    part,
  ],
};

export const isChannelQueryKey = (queryKey: readonly unknown[]): queryKey is ChannelQueryKey =>
  queryKey[0] === "channel" &&
  typeof queryKey[1] === "string" &&
  (queryKey[2] === "module"
    ? typeof queryKey[3] === "string" && typeof queryKey[4] === "string" && queryKey.length === 5
    : typeof queryKey[2] === "string" &&
      queryKey.slice(3).every((value) => typeof value === "object" && value !== null && !Array.isArray(value)));

export const dashboardDataKeys = {
  module: (channelId: string, moduleId: string) => ["channel", channelId, "module", moduleId] as const,
  system: (channelId: string) => queryKeys.channel(channelId, "system"),
  members: (channelId: string) => queryKeys.channel(channelId, "members"),
  variables: (channelId: string) => queryKeys.channel(channelId, "variables"),
  overlays: (channelId: string) => queryKeys.channel(channelId, "overlays"),
  overlay: (channelId: string, overlayId: string) => queryKeys.channel(channelId, "overlays", { overlayId }),
  audit: (channelId: string, filters: PanelAuditFilters) => queryKeys.channel(channelId, "audit-log", {
    person: filters.person,
    area: filters.area,
  }),
  events: (channelId: string, filters: PanelEventFilters) => queryKeys.channel(channelId, "events", {
    origin: filters.origin,
    module: filters.module,
    tone: filters.tone,
    tones: filters.tones === undefined ? null : [...filters.tones].sort((a, b) => a.localeCompare(b)).join(","),
    person: filters.person,
  }),
};
