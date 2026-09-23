import type { Hono } from "hono";
import type { ComponentType } from "react";
import type { z } from "zod";
import type { AuditWriteAction, ChannelRole } from "../contracts/values";
import type { TemplateFields } from "../template";
export type { PanelTemplateWarning, PanelTemplateWarningResponse } from "../panel-contract";

export { truncateTo200Chars } from "../text";
export {
  closestTemplateVariable,
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
  | "action" | "allowed" | "arguments" | "cause" | "count" | "current"
  | "currentTier" | "missing"
  | "duration" | "endsAt" | "gifter" | "kind" | "lastAdBreakAt" | "message"
  | "messageId" | "moderator" | "moduleId" | "name" | "outcome" | "person"
  | "reason" | "recipient" | "remainingSeconds" | "requiredTier" | "response"
  | "scheduledAt" | "scheduledFor" | "scope" | "seconds" | "source"
  | "sourceChannelId" | "startedAt" | "status" | "target" | "targetChannelId"
  | "text" | "threshold" | "tier" | "triggerLogin" | "type" | "viewers";

export interface ModuleDiagnostic {
  code: string;
  detail?: Readonly<Partial<Record<
    ModuleDiagnosticDetailKey,
    string | number | boolean | null | readonly ModuleChatStatus[]
  >>>;
}

/** A semantically well-named module action for the host to execute. */
export type ModuleAction =
  | { kind: "chat"; text: string; replyToMessageId?: string }
  | { kind: "shoutout"; targetChannelId: string }
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

export type ModuleAuditValue = string | number | boolean | null;

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
}

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
  /** Called by the host when an inspector is closed. */
  onCloseInspector?: () => void;
  /** Deep-link target set by the host (Spotlight, #164) -- a module reads
   *  its own identifier out of this if it wants to pre-select something on
   *  mount (e.g. text_commands selects the command by name); most modules
   *  ignore it. */
  initialSelection?: string;
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
  settingsSchema: SettingsSchema;
  defaultSettings: z.output<SettingsSchema>;
  /** Template fields and variables used by both panel validation and worker rendering. */
  templateFields?: TemplateFields<z.output<SettingsSchema>>;
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
};
