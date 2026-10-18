import type { EventCode } from "./values";
import type { ChatOutputTarget } from "./values";
import type { ModuleDiagnostic } from "../modules/contract";

export type DryRunEntryKind = "text_command" | "faq_entry";

export type DryRunMatch =
  | { kind: "command_name" | "alias"; token: string }
  | { kind: "keyword"; pattern: string }
  | { kind: "regex"; pattern: string; ranges: readonly [number, number][] };

export type DryRunBlockCode =
  | Extract<EventCode,
    | "text_commands.disabled"
    | "text_commands.permission_denied"
    | "text_commands.stream_state"
    | "text_commands.game_filter"
    | "text_commands.cooldown"
    | "text_commands.user_cooldown"
    | "text_commands.argument_invalid"
    | "text_commands.argument_missing">
  | "faq.permission_denied"
  | "faq.game_filter"
  | "faq.cooldown"
  | "faq.person_cooldown"
  | "faq.shadowed"
  | "faq.command_prefix"
  | "faq.own_message"
  | "host.module_disabled"
  | "host.channel_paused";

export type DryRunEffect =
  | {
    kind: "chat" | "announcement";
    text: string;
    target: ChatOutputTarget;
    postsTo: "this_chat" | "all_shared_chats";
    reply: boolean;
    suppressedBy: "channel_muted" | null;
    automated: boolean;
  }
  | { kind: "timeout"; minSeconds: number; maxSeconds: number; reason: string }
  | { kind: "shoutout"; targetLogin: string }
  | { kind: "variable"; name: string; from: number; to: number }
  | { kind: "cooldown"; scope: "global" | "user"; seconds: number };

export interface DryRunEntryReport {
  moduleId: string;
  entry: { kind: DryRunEntryKind; id: string; label: string };
  outcome: "fires" | "blocked";
  match: DryRunMatch;
  blocks: readonly { code: DryRunBlockCode; detail?: Readonly<Record<string, string | number | boolean | null>> }[];
  effects: readonly DryRunEffect[];
  templateNotes: readonly ModuleDiagnostic[];
}

export interface DryRunModuleReport {
  moduleId: string;
  status: "reacts" | "blocked" | "silent" | "not_testable" | "error";
  entries: readonly DryRunEntryReport[];
  error?: "write_blocked" | "module_error";
}

export type DryRunSenderStatus = "subscriber" | "vip" | "moderator" | "broadcaster";

export interface DryRunRequest {
  text: string;
  sender: { login: string; statuses: readonly DryRunSenderStatus[] };
  streamState: "online" | "offline";
  game: { id: string; name: string } | null;
  sharedChat: boolean;
  only?: { moduleId: "text_commands" | "faq"; entryId?: string };
}

export interface DryRunResponse {
  evaluatedAt: string;
  controls: { muted: boolean; paused: boolean };
  sender: { userId: string; resolved: false; perUserCooldownsUseSyntheticId: true };
  modules: readonly DryRunModuleReport[];
}
