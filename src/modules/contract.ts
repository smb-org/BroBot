import type { Hono } from "hono";
import type { ComponentType } from "react";
import type { z } from "zod";
import type { ChannelRole } from "../contracts/values";

export { truncateTo200Chars } from "../text";

/** Status of the chat-triggering person, derived from Twitch badges. */
export type ModuleChatStatus = "viewer" | "subscriber" | "vip" | "moderator" | "broadcaster";

/**
 * A justification for something a module did, or deliberately did not do.
 *
 * `code` is machine-readable and stable (`shoutout.unterdrueckt`), `detail`
 * carries the numbers that explain the case. Together they answer the
 * question that today goes unanswered everywhere: "Raid detected, why was
 * there no shoutout?"
 */
export interface ModuleDiagnostic {
  code: string;
  detail?: Readonly<Record<string, string | number | boolean | null | readonly ModuleChatStatus[]>>;
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
  action: string;
  before: ModuleAuditSnapshot | null;
  after: ModuleAuditSnapshot | null;
}

/** The host prepares the audit part of the same D1 mutation. */
export type PrepareModuleAudit = (
  entry: ModuleAuditEntry,
  changedAt: string,
) => D1PreparedStatement;

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
}

export type ModuleLanguage = "de" | "en";

export const browserModuleLanguage = (): ModuleLanguage => {
  const language = typeof navigator === "undefined" ? "de" : navigator.language;
  return language.toLowerCase().startsWith("de") ? "de" : "en";
};

export interface ModuleRouteVariables {
  session: { userId: string; sessionId: string };
  channelRole: ChannelRole;
  actor: { userId: string; sessionId: string };
  authorizeMutation: AuthorizeModuleMutation;
  authorizeManagementMutation: AuthorizeModuleMutation;
  prepareModuleAudit: PrepareModuleAudit;
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
  settingsSchema: SettingsSchema;
  defaultSettings: z.output<SettingsSchema>;
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
