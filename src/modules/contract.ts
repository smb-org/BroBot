import type { Hono } from "hono";
import type { ComponentType } from "react";
import type { z } from "zod";
import type { AuditWriteAction, ChannelRole, ChannelStreamState, ChannelVariableOperation, ImmediateActionRequirement } from "../contracts/values";
import type { TemplateContext, TemplateFields } from "../template";
import type { SettingsEditorDefinition } from "../dashboard/ui";
export type { PanelTemplateWarning, PanelTemplateWarningResponse } from "../panel-contract";

export { truncateTo200Chars, textFingerprintIfTruncated } from "../text";
export {
  closestTemplateVariable,
  effectiveTemplateVariables,
  invalidTemplateParameters,
  renderTemplate,
  templateFieldsWarnings,
  templateVariableNames,
  templateWarnings,
  tokenizeTemplate,
  unknownTemplateVariables,
  worstCaseTemplateLength,
  TEMPLATE_TOKEN_CANDIDATE_PATTERN,
  TEMPLATE_VARIABLE_PATTERN,
} from "../template";
export type { TemplateFields, TemplateVariable, TemplateValues, TemplateWarning } from "../template";
export { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../template-variables";

/** Status of the chat-triggering person, derived from Twitch badges. */
export type ModuleChatStatus = "viewer" | "subscriber" | "vip" | "moderator" | "broadcaster";

/**
 * A justification for something a module did, or deliberately did not do.
 *
 * `code` is machine-readable and stable (`shoutout.suppressed`), `detail`
 * carries the numbers that explain the case. Together they answer the
 * question that today goes unanswered everywhere: "Raid detected, why was
 * there no shoutout?"
 */
/**
 * The keys a diagnostic detail may carry. Closed on purpose: the detail lands in
 * `event_log.detail_json` and the interface reads it back, so it is wire data.
 * While this was `Record<string, ...>`, German keys survived four renaming
 * passes here -- each one found by accident, because a scanner only sees the
 * shapes it was taught, and every new way of building the object slipped past
 * it. A union is seen by the compiler at every construction site, however the
 * object is assembled.
 *
 * Adding a key means adding it here, and whoever adds it sees its neighbours.
 */
export type ModuleDiagnosticDetailKey =
  | "action" | "allowed" | "arguments" | "art" | "cause" | "count" | "current"
  | "currentTier" | "missing"
  | "duration" | "endsAt" | "gifter" | "kind" | "lastAdBreakAt" | "message"
  | "messageId" | "moderator" | "moduleId" | "name" | "outcome" | "person" | "alias"
  | "reason" | "recipient" | "remainingSeconds" | "requiredTier" | "response"
  | "scheduledAt" | "scheduledFor" | "scope" | "seconds" | "source"
  | "sourceChannelId" | "startedAt" | "status" | "streamState" | "target" | "targetChannelId" | "variable"
  | "text" | "threshold" | "tier" | "triggerLogin" | "twitchMessage" | "type" | "viewers";

export interface ModuleDiagnostic {
  code: string;
  detail?: Readonly<Partial<Record<
    ModuleDiagnosticDetailKey,
    string | number | boolean | null | readonly ModuleChatStatus[]
  >>>;
}

/**
 * Undoes the `message` -> `twitchMessage` rename a producer's result
 * carries for the event-log diagnostic's sake (provenance: only genuinely
 * Twitch-sourced wording gets labelled "Twitch: ..." in the dashboard
 * popover, see `dashboard/events/model.ts`'s `eventCause`) -- for a route's
 * own JSON error response, which has always used `message` (including a
 * bare `null` for a timeout/network error, where there was never a Twitch
 * body to read one from -- `helixRequest` in `worker/twitch/helix.ts`) and
 * has to keep doing so for existing clients. Converts whenever the
 * `twitchMessage` key is present at all, not only when its value is a
 * nonempty string: a `null` still has to become `detail.message: null`,
 * not vanish and leave the key missing entirely, which previously read to
 * a client as "no diagnostic detail was even attempted" instead of "Twitch
 * gave no message". A producer's `result.detail` otherwise flows straight
 * into both the diagnostic and the response body; this is the one
 * conversion point every route that forwards `result.detail` as an error
 * response calls, instead of each route inlining its own rename.
 */
export const apiErrorDetail = (
  detail: Readonly<Record<string, string | number | boolean | null>>,
): Readonly<Record<string, string | number | boolean | null>> => {
  if (!Object.hasOwn(detail, "twitchMessage") || Object.hasOwn(detail, "message")) return detail;
  // `Object.hasOwn` above already proves the key exists -- `noUncheckedIndexedAccess`
  // still types a plain index-signature read as possibly `undefined`, so this narrows
  // back to what it actually is: one of the detail value types, `undefined` excluded.
  const twitchMessage = detail.twitchMessage as string | number | boolean | null;
  const rest: Record<string, string | number | boolean | null> = { ...detail };
  rest.message = twitchMessage;
  delete rest.twitchMessage;
  return rest;
};

/** A semantically well-named module action for the host to execute. */
export type ModuleAction =
  | { kind: "chat"; text: string; replyToMessageId?: string }
  | { kind: "announcement"; text: string }
  | { kind: "shoutout"; targetChannelId: string }
  | { kind: "shoutout"; targetLogin: string }
  | { kind: "overlay"; type: string; payload: Readonly<Record<string, unknown>> };

/**
 * What a module describes as the result of processing. It executes nothing
 * — per decision 0001 §13 it only describes desired actions, and only the
 * worker then executes them via Twitch, D1, or Durable Objects.
 *
 * The actions live in a shared list so their order is preserved. New
 * semantic action kinds can be added later, additively, without breaking
 * existing modules through new required fields. `diagnostics` describes the
 * business reasons for acting or not acting; the host logs executed actions
 * and their outcome.
 */
export interface ModuleResult {
  actions: readonly ModuleAction[];
  diagnostics: readonly ModuleDiagnostic[];
  /** Variable writes and their overlay recipients, returned by the write's D1 batch. */
  variableChanges?: readonly {
    name: string;
    value: number;
    overlayIds: readonly string[];
  }[];
}

export type ModuleActor = {
  userId: string;
  login: string;
  role: ChannelRole | null;
};

export interface ModuleMutationActor {
  userId: string;
  sessionId?: string;
}

export interface ModuleMutationAuthorization {
  sql: string;
  values: readonly (string | number | null)[];
}

export type ModuleAuditValue = string | number | boolean | null | readonly string[];

/** Business values a module has explicitly cleared for the audit. */
export type ModuleAuditSnapshot = Readonly<Record<string, ModuleAuditValue>>;

export interface ModuleAuditEntry {
  channelId: string;
  moduleId: string | null;
  action: AuditWriteAction;
  before: ModuleAuditSnapshot | null;
  after: ModuleAuditSnapshot | null;
}

/** The host prepares the audit part of the same D1 mutation. */
export type PrepareModuleAudit = (
  entry: ModuleAuditEntry,
  changedAt: string,
) => D1PreparedStatement;

/**
 * Writes an audit entry immediately, for an action with no accompanying D1
 * mutation to batch it with -- an external Twitch call (start a commercial,
 * create a clip), not a row change here. `PrepareModuleAudit` above stays
 * for the batched case.
 */
export type WriteModuleAudit = (
  entry: ModuleAuditEntry,
  changedAt: string,
) => Promise<void>;

export type AuthorizeModuleMutation = (
  channelId: string,
  actor: ModuleMutationActor,
  now: string,
) => ModuleMutationAuthorization;

/** Infrastructure the host gives a module for its own adapter. */
export interface ModuleExecutionContext {
  DB: D1Database;
  authorizeMutation: AuthorizeModuleMutation;
  streamState: () => Promise<ModuleStreamState>;
  /** Lazily loads the current channel's public Helix fields and live start time. */
  channelInfo: () => Promise<ModuleChannelInfo | null>;
  /** Lazily loads whether the caller follows the current channel. */
  followedAt: (userId: string) => Promise<ModuleFollowedAt>;
  followerTotal: () => Promise<number | null>;
  chattersTotal: () => Promise<number | null>;
  userCreatedAt: (userId: string) => Promise<string | null>;
  readChannelVariables: (names: readonly string[]) => Promise<Readonly<Record<string, number>>>;
  renderTemplate: (
    text: string,
    moduleValues: Readonly<Record<string, string | number>>,
    changed?: { name: string; value: number },
  ) => Promise<{ text: string; diagnostics: readonly ModuleDiagnostic[] }>;
  prepareVariableChange: (
    channelId: string,
    change: { name: string; operation: ChannelVariableOperation; amount: number | null },
    now: string,
    claim: { commandName: string; revision: number; userId: string | null },
  ) => D1PreparedStatement;
  /** Lazily reads the channel's configured chat-template language. */
  channelLanguage: () => Promise<ModuleLanguage>;
}

export type ModuleFollowedAt = (string & {}) | null | "unavailable";

export type ModuleStreamState = "online" | "offline" | "unknown";

export interface ModuleChannelInfo {
  title: string;
  gameName: string;
  startedAt: string | null;
  viewerCount: number;
}

export interface ModuleVariableReferenceUsage {
  moduleId: string;
  itemName: string;
  kind: "action" | "template" | "display";
  overlayId?: string;
  elementId?: string;
  reconnect?: boolean;
}

export interface ModuleVariableReferences {
  usages: (db: D1Database, channelId: string, name: string) => Promise<readonly ModuleVariableReferenceUsage[]>;
  rename: (db: D1Database, channelId: string, from: string, to: string) => readonly D1PreparedStatement[];
}

export interface ModuleChannelVariable {
  name: string;
  value: number;
  description: string;
}

/** Host-backed variable access for module routes; each call is channel-scoped. */
export interface ModuleChannelVariableAccess {
  listChannelVariables: (channelId: string) => Promise<readonly ModuleChannelVariable[]>;
  findChannelVariable: (channelId: string, name: string) => Promise<ModuleChannelVariable | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Finds and rewrites channel-variable template references in module settings. */
export const settingsVariableReferences = (
  moduleId: string,
  fields: readonly string[],
): ModuleVariableReferences => ({
  async usages(db, channelId, name): Promise<readonly ModuleVariableReferenceUsage[]> {
    const row = await db.prepare(
      "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ?",
    ).bind(channelId, moduleId).first<{ settings: string }>();
    if (row === null) return [];
    let settings: unknown;
    try {
      settings = JSON.parse(row.settings) as unknown;
    } catch {
      return [];
    }
    if (!isRecord(settings)) return [];
    const token = `{var.${name}}`;
    return fields.flatMap((field) => {
      const value = settings[field];
      return typeof value === "string" && value.includes(token)
        ? [{ moduleId, itemName: field, kind: "template" as const }]
        : [];
    });
  },
  rename(db, channelId, from, to) {
    const oldToken = `{var.${from}}`;
    const nextToken = `{var.${to}}`;
    return [db.prepare(
      `UPDATE channel_modules
          SET settings = replace(settings, ?, ?), revision = revision + 1
        WHERE channel_id = ? AND module_id = ? AND instr(settings, ?) > 0
          AND EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)
          AND NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)`,
    ).bind(oldToken, nextToken, channelId, moduleId, oldToken, channelId, to, channelId, from)];
  },
});

/** Infrastructure for one-time initial data when a module is enabled. */
export interface ModuleEnableContext {
  DB: D1Database;
  authorizeMutation: AuthorizeModuleMutation;
  /** Prepares a success-coupled audit entry for prepared initial data. */
  prepareModuleAudit?: PrepareModuleAudit;
  actor: ModuleMutationActor;
  now: string;
}

/** Shared props for lazily loaded panel views. */
export interface ModulePanelProperties {
  channelId: string;
  /** The panel language resolved by the host; optional for legacy modules. */
  language?: ModuleLanguage;
  /** May the view execute management controls? */
  canManage?: boolean;
  /** Last known status of the bot's moderator role in this channel. */
  botIsModerator?: boolean | null;
  /** Called by the host when an inspector is closed. */
  onCloseInspector?: () => void;
  /** Deep-link target set by the host (Spotlight, #164) -- a module reads
   *  its own identifier out of this if it wants to pre-select something on
   *  mount (e.g. text_commands selects the command by name); most modules
   *  ignore it. */
  initialSelection?: string;
}

/** Props for one lazily loaded card in the channel's immediate-action row. */
export interface ModuleImmediateActionProperties {
  channelId: string;
  streamState?: ChannelStreamState | null;
  /** Localized by the host from the action's declared requirements and current stream state. */
  availabilityReason: string | null;
}

export interface ModuleImmediateActionDefinition {
  /** Conditions are evaluated by the host; the module remains enabled implicitly. */
  requires: readonly ImmediateActionRequirement[];
  /** Kept lazy so disabled modules add no immediate-action bytes to the panel bundle. */
  load: () => Promise<{ default: ComponentType<ModuleImmediateActionProperties> }>;
}

export type ModuleLanguage = "de" | "en";

export const browserModuleLanguage = (): ModuleLanguage => {
  const language = typeof navigator === "undefined" ? "de" : navigator.language;
  return language.toLowerCase().startsWith("de") ? "de" : "en";
};

/** HTTP method a Helix request may use; `helixRequest` sets no default body encoding beyond JSON. */
export type HelixMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Base transport-level classification `helixRequest` derives from the raw
 * response -- nothing about what a status *means* for a given endpoint (a
 * 401 is a missing scope here, a revoked moderator there). That reading
 * stays with the caller; see `worker/twitch/helix.ts`'s header comment.
 */
export type HelixErrorReason =
  | "rate_limited" | "network_error" | "timeout" | "invalid_response" | "pagination_loop"
  | `http_${string}`;

export interface HelixRequestOptions<Data = unknown> {
  method?: HelixMethod;
  url: string;
  query?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  accessToken: string;
  clientId: string;
  /** Validates and narrows a successful response body; a mismatch reports as `invalid_response`. */
  schema?: z.ZodType<Data>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export type HelixResult<Data = unknown> =
  | { ok: true; status: number; data: Data }
  | {
    ok: false;
    status: number | null;
    reason: HelixErrorReason;
    message: string | null;
    /** Twitch's parsed error body, tolerant of a missing or non-JSON response. */
    body: Readonly<Record<string, unknown>>;
  };

export type HelixRequest = <Data = unknown>(options: HelixRequestOptions<Data>) => Promise<HelixResult<Data>>;

export interface ModuleRouteVariables {
  session: { userId: string; sessionId: string };
  channelRole: ChannelRole;
  actor: { userId: string; sessionId: string };
  authorizeMutation: AuthorizeModuleMutation;
  authorizeManagementMutation: AuthorizeModuleMutation;
  prepareModuleAudit: PrepareModuleAudit;
  writeModuleAudit: WriteModuleAudit;
  listChannelVariables: ModuleChannelVariableAccess["listChannelVariables"];
  findChannelVariable: ModuleChannelVariableAccess["findChannelVariable"];
  writeModuleDiagnostics: (
    db: D1Database,
    channelId: string,
    moduleId: string,
    triggerId: string,
    actorUserId: string | null,
    diagnostics: readonly ModuleDiagnostic[],
    now: string,
  ) => Promise<unknown>;
  broadcasterHasScope: (db: D1Database, channelId: string, scope: string) => Promise<boolean>;
  broadcasterScopesForChannel: (db: D1Database, channelId: string) => Promise<readonly string[]>;
  measureServerTiming: <T>(phase: "auth" | "d1" | "do" | "helix", run: () => Promise<T>) => Promise<T>;
  recordServerTiming: (phase: "auth" | "d1" | "do" | "helix", durationMs: number) => void;
  scheduleBackgroundWork: (work: Promise<unknown>) => void;
  getAppAccessToken: (environment: Env, now: string, fetcher?: typeof fetch) => Promise<string>;
  /** Thin Helix HTTP transport (issue #163); modules never talk to `api.twitch.tv` directly. */
  helixRequest: HelixRequest;
}

export interface ModuleRouteEnvironment {
  Bindings: Env;
  Variables: ModuleRouteVariables;
}

/**
 * What a module learns about the triggering event. Deliberately narrow: the
 * channel comes from the verified event, not from the module, so a module
 * cannot act on a foreign channel. `triggerId` is Twitch's message ID and
 * links all rows in the event log that belong to the same trigger.
 */
export interface ModuleEvent<Settings = unknown> {
  channelId: string;
  subscriptionType: string;
  /** The variant, like the channel, comes from the EventSub subscription condition. */
  subscriptionVariant?: string;
  triggerId: string;
  payload: Readonly<Record<string, unknown>>;
  settings: Settings;
  receivedAt: string;
  /** The role comes from channel_members; `null` means not a member. */
  actor: ModuleActor | null;
  /** Events unrelated to chat carry `null` here; chat events carry all matching statuses. */
  chatStatus: readonly ModuleChatStatus[] | null;
}

export type BotModule<SettingsSchema extends z.ZodType = z.ZodType> = {
  id: string;
  /** The module is always enabled for every released channel and cannot be disabled. */
  mandatory?: boolean;
  /**
   * The declaration the release path uses to write an enabled
   * `channel_modules` row for new channels. A channel released before the
   * module existed gets that row from a backfill migration instead. Every
   * reader treats a missing row as disabled — this flag never substitutes
   * for the row at read time.
   */
  defaultEnabled?: boolean;
  settingsSchema: SettingsSchema;
  defaultSettings: z.output<SettingsSchema>;
  /** Template fields and variables used by both panel validation and worker rendering. */
  templateFields?: TemplateFields<z.output<SettingsSchema>>;
  /** Which host catalog groups are available in this module's templates. */
  templateContext?: TemplateContext;
  /** Optional references to channel variables stored in module-owned data. */
  variableReferences?: ModuleVariableReferences;
  /** Broadcaster consent the host verifies before the EventSub subscription. */
  broadcasterScopes?: readonly string[];
  eventSubTypes?: readonly string[];
  routes?: Hono<ModuleRouteEnvironment>;
  /**
   * The business entry point. A pure function: it describes what should
   * happen and executes nothing. The host executes the actions and logs
   * their outcome; the module justifies with `diagnostics` why it acted or
   * did not act (decision 0004).
   *
   * If the function throws, this blocks neither the worker nor the other
   * modules — the error ends up as a diagnostic in the event log.
   */
  handleEvent?: (
    event: ModuleEvent<z.output<SettingsSchema>>,
    context: ModuleExecutionContext,
  ) => ModuleResult | Promise<ModuleResult>;
  /** Called before enabling to create module-specific initial data. */
  onEnable?: (
    context: ModuleEnableContext,
    channelId: string,
  ) => readonly D1PreparedStatement[] | undefined | Promise<readonly D1PreparedStatement[] | undefined>;
  // Module migrations and further action kinds join the contract once the
  // first module needs them. Command processing launched with
  // ModuleResult.
  /**
   * Deliberately just a lazy import: Vite can cut its own chunk, so a
   * disabled module costs zero overlay bytes. Do not turn this into a
   * direct import.
   */
  overlay?: () => Promise<{ default: ComponentType }>;
  /**
   * This view also stays deliberately lazy: a disabled module should
   * likewise cost zero bytes in the panel bundle. Do not turn this into a
   * direct import.
   */
  panel?: () => Promise<{ default: ComponentType<ModulePanelProperties> }>;
  /** Lazily loaded editor declaration for this module's settings. */
  settingsEditor?: () => Promise<{ default: SettingsEditorDefinition<z.output<SettingsSchema>> }>;
  /** Lazily loaded immediate-action card, shown only while this module is enabled. */
  immediateActions?: ModuleImmediateActionDefinition;
};
