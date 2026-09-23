import type { AuditArea, ChannelRole } from "../../contracts/values";
import type { PanelAuditEntry, PanelAuditFilters } from "../../panel-contract";
import { auditAreaForAction } from "./areas";
import { auditActionLabel, roleLabel } from "../labels";
import { memberAsWord, type DashboardLanguage } from "../locale";
import { dayKey } from "../events/model";
import { moduleName } from "../module-labels";
import type { IconName } from "../ui/Icon";

export { auditAreaForAction, auditSubjectUserId } from "./areas";

export const emptyAuditFilter: PanelAuditFilters = { person: null, area: null };

export const auditFilterIsActive = (filters: PanelAuditFilters): boolean =>
  filters.person !== null || filters.area !== null;

const AREA_ICONS: Record<AuditArea, IconName> = {
  module: "tabSettings",
  command: "tabMessages",
  member: "member",
  channel: "broadcast",
  overlay: "token",
};

export const auditAreaIcon = (area: AuditArea): IconName => AREA_ICONS[area];

/** Structural addressing/bookkeeping keys never worth showing as a "changed field". */
const STRUCTURAL_KEYS = new Set(["channelId", "moduleId", "userId", "createdAt", "updatedAt"]);

const parseObject = (json: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/**
 * Settings are stored as a JSON string nested inside the audit row's own
 * JSON object (`{ channelId, moduleId, enabled, settings: "<json>" }`, see
 * `worker/db/channel-modules.ts`). Splits that out so its keys diff
 * alongside the top-level ones, tagged `fromSettings` for the field-label
 * lookup (module catalogue vs. generic fallback).
 */
const flattenSettings = (record: Record<string, unknown> | null): { rest: Record<string, unknown>; settings: Record<string, unknown> | null } => {
  if (record === null) return { rest: {}, settings: null };
  const { settings: rawSettings, ...rest } = record;
  if (typeof rawSettings !== "string") return { rest, settings: null };
  return { rest, settings: parseObject(rawSettings) };
};

const deepEqual = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export type AuditDiffKind = "changed" | "added" | "removed";

export interface AuditDiffRow {
  key: string;
  kind: AuditDiffKind;
  oldValue: unknown;
  newValue: unknown;
  /** From the nested `settings` JSON, so the caller should label it via the module's own field catalogue instead of the generic fallback. */
  fromSettings: boolean;
}

/**
 * A diff of only the fields that actually changed, per #181 item 3: create
 * entries (`before` is `null`/absent) show every field as "added" (only the
 * "neu" value), remove entries the mirror image, and a null-ish added or
 * removed value is skipped outright (nothing meaningful to announce).
 */
export const auditDiffRows = (beforeJson: string, afterJson: string): AuditDiffRow[] => {
  const before = flattenSettings(parseObject(beforeJson));
  const after = flattenSettings(parseObject(afterJson));
  const rows: AuditDiffRow[] = [];
  const pushRows = (beforeFields: Record<string, unknown>, afterFields: Record<string, unknown>, fromSettings: boolean): void => {
    for (const key of new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])) {
      if (!fromSettings && STRUCTURAL_KEYS.has(key)) continue;
      const hasBefore = Object.hasOwn(beforeFields, key);
      const hasAfter = Object.hasOwn(afterFields, key);
      const oldValue = beforeFields[key];
      const newValue = afterFields[key];
      if (hasBefore && hasAfter) {
        if (deepEqual(oldValue, newValue)) continue;
        rows.push({ key, kind: "changed", oldValue, newValue, fromSettings });
      } else if (hasAfter) {
        if (newValue === null || newValue === undefined) continue;
        rows.push({ key, kind: "added", oldValue: undefined, newValue, fromSettings });
      } else if (hasBefore) {
        if (oldValue === null || oldValue === undefined) continue;
        rows.push({ key, kind: "removed", oldValue, newValue: undefined, fromSettings });
      }
    }
  };
  pushRows(before.rest, after.rest, false);
  if (before.settings !== null || after.settings !== null) pushRows(before.settings ?? {}, after.settings ?? {}, true);
  return rows;
};

/** Renders a diff value generically; booleans use the caller-supplied on/off words (a module's own catalogue, or a generic fallback). */
export const auditDiffValueText = (value: unknown, boolWords: { on: string; off: string }): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? boolWords.on : boolWords.off;
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.map((entry) => auditDiffValueText(entry, boolWords)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : JSON.stringify(value);
};

/**
 * The subject an action affected, derived only from fields already on the
 * entry (moduleId, before/after) -- #181 item 4. `null` when the action
 * carries no meaningful subject (channel mute/pause, overlay tokens, ad
 * breaks, clips).
 */
export const auditSubjectText = (entry: PanelAuditEntry, language: DashboardLanguage): string | null => {
  const area = auditAreaForAction(entry.action);
  const record = parseObject(entry.after) ?? parseObject(entry.before);
  if (area === "module") {
    // A `${moduleId}.settings_changed` action's label already embeds the
    // module name (`labels.ts`'s `auditActionLabel` -> `moduleSettingsChangedText`,
    // e.g. "Settings changed: Ad breaks") -- appending it again here would
    // duplicate it in the row label.
    if (entry.action.endsWith(".settings_changed")) return null;
    return entry.moduleId == null || entry.moduleId.length === 0 ? null : moduleName(entry.moduleId, language);
  }
  if (area === "command") {
    const name = record !== null && typeof record.name === "string" && record.name.length > 0 ? record.name : null;
    return name === null ? null : `!${name}`;
  }
  if (area === "member") {
    const role = record !== null && typeof record.role === "string" ? record.role as ChannelRole : null;
    const login = entry.subjectDisplayName ?? (entry.subjectLogin === null || entry.subjectLogin === undefined ? null : `@${entry.subjectLogin}`);
    if (login === null) return role === null ? null : roleLabel(role);
    return role === null ? login : `${login} ${memberAsWord(language)} ${roleLabel(role)}`;
  }
  if (area === "channel") {
    const login = record !== null && typeof record.login === "string" && record.login.length > 0 ? record.login : null;
    return login === null ? null : `@${login}`;
  }
  return null;
};

/** The action's label with its subject appended, e.g. "Modul aktiviert: Werbung". */
export const auditRowLabel = (entry: PanelAuditEntry, language: DashboardLanguage): string => {
  const action = auditActionLabel(entry.action, language);
  const subject = auditSubjectText(entry, language);
  return subject === null || subject.length === 0 ? action : `${action}: ${subject}`;
};

export interface AuditDayGroup {
  key: string;
  label: string;
  entries: readonly PanelAuditEntry[];
}

/** Day groups, newest day first, matching the event log's grouping (`dashboard/events/model.ts`'s `eventDayGroups`). */
export const auditDayGroups = (entries: readonly PanelAuditEntry[], formatDay: (createdAt: string) => string): AuditDayGroup[] => {
  const days = new Map<string, PanelAuditEntry[]>();
  for (const entry of entries) {
    const key = dayKey(entry.createdAt);
    const existing = days.get(key);
    if (existing === undefined) days.set(key, [entry]);
    else existing.push(entry);
  }
  return Array.from(days, ([key, dayEntries]) => ({ key, label: formatDay(dayEntries[0]?.createdAt ?? key), entries: dayEntries }));
};

/** Renders the "who"/actor cell and the inspector's "who" field alike -- the display name/login the table already shows, never the raw id (#181 item 2; the id is available as a tooltip via `actorUserId`). */
export const auditActorLabel = (entry: Pick<PanelAuditEntry, "actorUserId" | "actorLogin" | "actorDisplayName">): string =>
  entry.actorDisplayName ?? (entry.actorLogin === null ? entry.actorUserId : `@${entry.actorLogin}`);
