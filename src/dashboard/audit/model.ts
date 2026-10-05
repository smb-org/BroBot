import { AUDIT_ACTIONS, CHANNEL_ROLES, type AuditArea, type ChannelRole } from "../../contracts/values";
import type { PanelAuditEntry, PanelAuditFilters } from "../../panel-contract";
import { auditAreaForAction } from "./areas";
import { auditActionLabel, roleLabel } from "../labels";
import { auditObjectFallback, auditSentenceForAction, auditSettingsChangedSentence, dashboardTexts, memberAsWord, type AuditSentenceParts, type DashboardLanguage } from "../locale";
import { dayKey } from "../events/model";
import { moduleName } from "../module-labels";
import { MODULES } from "../../modules/registry";
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

interface FlattenedRecord {
  rest: Record<string, unknown>;
  /** The `settings` field's own raw JSON string, kept around even when it parses, so a malformed/non-object `settings` on either side can still fall back to a raw-string comparison (#181 review) instead of silently vanishing. */
  rawSettings: string | null;
  settings: Record<string, unknown> | null;
}

/**
 * Settings are stored as a JSON string nested inside the audit row's own
 * JSON object (`{ channelId, moduleId, enabled, settings: "<json>" }`, see
 * `worker/db/channel-modules.ts`). Splits that out so its keys diff
 * alongside the top-level ones, tagged `fromSettings` for the field-label
 * lookup (module catalogue vs. generic fallback).
 */
const flattenSettings = (record: Record<string, unknown> | null): FlattenedRecord => {
  if (record === null) return { rest: {}, rawSettings: null, settings: {} };
  const { settings: rawSettings, ...rest } = record;
  if (!Object.hasOwn(record, "settings")) return { rest, rawSettings: null, settings: {} };
  if (typeof rawSettings !== "string") return { rest, rawSettings: null, settings: null };
  return { rest, rawSettings, settings: parseObject(rawSettings) };
};

/** `rest` with the raw (unparsed) `settings` string reattached as a plain field -- the fallback when the nested diff isn't viable. */
const withRawSettingsField = (flat: FlattenedRecord): Record<string, unknown> =>
  flat.rawSettings === null ? flat.rest : { ...flat.rest, settings: flat.rawSettings };

const deepEqual = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export type AuditDiffKind = "changed" | "added" | "removed" | "changed-truncated";

export interface AuditDiffRow {
  key: string;
  kind: AuditDiffKind;
  oldValue: unknown;
  newValue: unknown;
  /** From the nested `settings` JSON, so the caller should label it via the module's own field catalogue instead of the generic fallback. */
  fromSettings: boolean;
}

/** The audit-writer convention (`modules/text_commands/adapters/d1.ts`'s `previewField`) for a truncated preview's companion fingerprint field. */
const HASH_SUFFIX = "Hash";

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
      if (key.endsWith(HASH_SUFFIX) && key.length > HASH_SUFFIX.length) continue; // a companion field, not its own row
      if (!fromSettings && STRUCTURAL_KEYS.has(key)) continue;
      const hasBefore = Object.hasOwn(beforeFields, key);
      const hasAfter = Object.hasOwn(afterFields, key);
      const oldValue = beforeFields[key];
      const newValue = afterFields[key];
      if (hasBefore && hasAfter) {
        if (deepEqual(oldValue, newValue)) {
          // A preview can be identical on both sides while the full value
          // (only its fingerprint is stored) differs -- an edit past the
          // preview's truncation cutoff must still surface as a change. A
          // hash on only one side already proves a difference (a literal,
          // non-truncated preview colliding with a truncated one) without
          // needing to compare anything else.
          const hashKey = `${key}${HASH_SUFFIX}`;
          const hasOldHash = Object.hasOwn(beforeFields, hashKey);
          const hasNewHash = Object.hasOwn(afterFields, hashKey);
          const oldHash = beforeFields[hashKey];
          const newHash = afterFields[hashKey];
          const differs = hasOldHash !== hasNewHash || (hasOldHash && hasNewHash && !deepEqual(oldHash, newHash));
          if (differs) {
            rows.push({ key, kind: "changed-truncated", oldValue, newValue, fromSettings });
          }
          continue;
        }
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
  if (before.settings !== null && after.settings !== null) {
    pushRows(before.rest, after.rest, false);
    pushRows(before.settings, after.settings, true);
  } else {
    // At least one side's `settings` JSON was malformed, not an object, or
    // simply absent: nothing to diff field by field. Compare the raw
    // strings instead of dropping the field outright.
    pushRows(withRawSettingsField(before), withRawSettingsField(after), false);
  }
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
    const storedRole = record !== null && typeof record.role === "string" ? record.role : null;
    const role = storedRole !== null && (CHANNEL_ROLES as readonly string[]).includes(storedRole) ? storedRole as ChannelRole : null;
    // Falls back to the raw subject id, the same chain `auditActorLabel`
    // uses for the actor -- a failed Twitch lookup (e.g. a deleted account)
    // must still name *who*, not just the role (#181 review).
    const identity = entry.subjectUserId === null || entry.subjectUserId === undefined
      ? null
      : auditActorLabel({ actorUserId: entry.subjectUserId, actorLogin: entry.subjectLogin ?? null, actorDisplayName: entry.subjectDisplayName ?? null });
    if (identity === null) return role === null ? null : roleLabel(role, language);
    return role === null ? identity : `${identity} ${memberAsWord(language)} ${roleLabel(role, language)}`;
  }
  if (area === "channel") {
    const login = record !== null && typeof record.login === "string" && record.login.length > 0 ? record.login : null;
    return login === null ? null : `@${login}`;
  }
  const subject = record === null ? null : entry.action.startsWith("overlay.access.") ? record.label : record.name;
  return typeof subject === "string" && subject.length > 0 ? subject : null;
};

/** The action's label with its subject appended, e.g. "Modul aktiviert: Werbung". */
export const auditRowLabel = (entry: PanelAuditEntry, language: DashboardLanguage): string => {
  const action = auditActionLabel(entry.action, language);
  const subject = auditSubjectText(entry, language);
  return subject === null || subject.length === 0 ? action : `${action}: ${subject}`;
};

const recordValue = (record: Record<string, unknown> | null, key: string): unknown => record !== null && Object.hasOwn(record, key) ? record[key] : undefined;

const recordText = (record: Record<string, unknown> | null, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = recordValue(record, key);
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
};

/** A stored role value (`member.*` before/after, or a diff row's raw "role" field) localized via the role catalogue -- `null` when the value isn't a known role. */
export const roleText = (value: unknown, language: DashboardLanguage): string | null =>
  typeof value === "string" && (CHANNEL_ROLES as readonly string[]).includes(value) ? roleLabel(value as ChannelRole, language) : null;

const memberSubject = (entry: PanelAuditEntry, language: DashboardLanguage): string => {
  if (entry.subjectUserId === null || entry.subjectUserId === undefined) return auditObjectFallback("member.added", language);
  return auditActorLabel({ actorUserId: entry.subjectUserId, actorLogin: entry.subjectLogin ?? null, actorDisplayName: entry.subjectDisplayName ?? null });
};

const auditObject = (entry: PanelAuditEntry, language: DashboardLanguage): string => {
  const before = parseObject(entry.before);
  const after = parseObject(entry.after);
  if (entry.action.startsWith("member.")) return memberSubject(entry, language);
  if (entry.action === "module.enabled" || entry.action === "module.disabled") {
    return entry.moduleId == null ? auditObjectFallback(entry.action, language) : moduleName(entry.moduleId, language);
  }
  if (entry.action === "channel.released" || entry.action === "channel.full_consent_changed") {
    return recordText(after, "displayName", "login") ?? recordText(before, "displayName", "login") ?? auditObjectFallback(entry.action, language);
  }
  const name = recordText(after, "name") ?? recordText(before, "name");
  if (entry.action.startsWith("text_commands.command.")) return name === null ? auditObjectFallback(entry.action, language) : `!${name.replace(/^!+/u, "")}`;
  if (entry.action.startsWith("text_library.block.")) return name === null ? auditObjectFallback(entry.action, language) : `{${name}}`;
  if (entry.action.startsWith("text_library.category.")) return name ?? auditObjectFallback(entry.action, language);
  if (entry.action.startsWith("channel.variable.")) return name === null ? auditObjectFallback(entry.action, language) : `{var.${name}}`;
  if (entry.action.startsWith("overlay.") && ["overlay.created", "overlay.updated", "overlay.deleted", "overlay.legacy.imported"].includes(entry.action)) return name ?? auditObjectFallback(entry.action, language);
  return auditObjectFallback(entry.action, language);
};

const sentencePartValue = (action: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, language: DashboardLanguage): { from: string | null; to: string | null } => {
  if (action === "member.role_changed" || action === "member.removed" || action === "member.added") {
    return { from: roleText(recordValue(before, "role"), language), to: roleText(recordValue(after, "role"), language) };
  }
  if (action === "channel.full_consent_changed") {
    const words = dashboardTexts(language).audit;
    const value = (record: Record<string, unknown> | null): string | null => typeof recordValue(record, "fullConsent") === "boolean" ? (recordValue(record, "fullConsent") ? words.yes : words.no) : null;
    return { from: value(before), to: value(after) };
  }
  if (action === "channel.variable.value_changed") {
    const from = recordValue(before, "value");
    const to = recordValue(after, "value");
    return { from: typeof from === "number" ? String(from) : null, to: typeof to === "number" ? String(to) : null };
  }
  if (action === "channel.variable.renamed" || action === "text_library.category.renamed") {
    return { from: recordText(before, "name"), to: recordText(after, "name") };
  }
  if (action === "text_library.settings.updated" || action === "channel.time_zone.updated") {
    return { from: recordText(before, "timeZone"), to: recordText(after, "timeZone") };
  }
  if (action === "channel.location.updated") {
    return { from: recordText(before, "locationName"), to: recordText(after, "locationName") };
  }
  if (action === "ads.commercial_started") {
    const length = recordValue(after, "length");
    return { from: null, to: typeof length === "number" ? `${String(length)} s` : null };
  }
  return { from: null, to: null };
};

type ChannelVariableChangeKind = "renamed" | "description" | "settings";

/**
 * `channel.variable.renamed` is written for any patch (name, description, or
 * the reset-on-stream-start setting) -- #254 review. The stored action never
 * changes, so which sentence to show is derived from the diff itself, which
 * also makes existing stored entries render correctly. A name change always
 * wins (it is the most salient edit); of the rest, the reset setting outranks
 * a plain description edit only because "changed settings" already covers a
 * description edited alongside it, while a description-only edit gets its
 * own, more specific sentence.
 */
const channelVariableChangeKind = (before: Record<string, unknown> | null, after: Record<string, unknown> | null): ChannelVariableChangeKind => {
  if (!deepEqual(recordValue(before, "name"), recordValue(after, "name"))) return "renamed";
  if (!deepEqual(recordValue(before, "resetOnStreamStart"), recordValue(after, "resetOnStreamStart"))) return "settings";
  return "description";
};

/** Builds a complete localized sentence from a closed action template. Unknown stored actions never expose their code. */
export const auditSentenceText = (entry: PanelAuditEntry, language: DashboardLanguage): string => {
  const actor = auditActorLabel(entry);
  const moduleSettingsSuffix = ".settings_changed";
  if (entry.action.endsWith(moduleSettingsSuffix)) {
    const moduleId = entry.action.slice(0, -moduleSettingsSuffix.length);
    if (entry.moduleId === moduleId && MODULES.some((module) => module.id === moduleId)) {
      return auditSettingsChangedSentence(actor, moduleName(moduleId, language), language);
    }
  }
  if (!(AUDIT_ACTIONS as readonly string[]).includes(entry.action)) {
    return auditSentenceForAction(entry.action, { actor, object: "", from: null, to: null }, language);
  }
  const before = parseObject(entry.before);
  const after = parseObject(entry.after);
  const object = auditObject(entry, language);
  if (entry.action === "channel.variable.renamed") {
    const kind = channelVariableChangeKind(before, after);
    if (kind === "description") return dashboardTexts(language).audit.sentenceVariableDescriptionChanged(actor, object);
    if (kind === "settings") return dashboardTexts(language).audit.sentenceVariableSettingsChanged(actor, object);
  }
  const { from, to } = sentencePartValue(entry.action, before, after, language);
  const parts: AuditSentenceParts = {
    actor,
    object,
    from,
    to,
    ...(entry.action === "votekick.timeout_lift_attempted" ? { outcome: recordText(after, "outcome") } : {}),
  };
  return auditSentenceForAction(entry.action, parts, language);
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
