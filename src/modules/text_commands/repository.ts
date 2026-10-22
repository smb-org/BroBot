import type {
  NewTextCommand,
  TextCommand,
  TextCommandChange,
  TextCommandClaim,
  TextCommandActor,
  PrepareTextCommandVariableChange,
} from "./contracts";
import type { CommandCollisionWriteGuard } from "../contracts/module-command-collision";

type TextCommandMutationReason =
  | "already_exists"
  | "not_found"
  | "conflict"
  | "not_authorized"
  | "alias_conflict";

export interface TextCommandAliasConflict {
  field: "name" | "aliases";
  trigger: string;
  command: string;
}

export type TextCommandMutationResult =
  | { ok: true }
  | { ok: false; reason: TextCommandMutationReason; conflict?: TextCommandAliasConflict; current?: TextCommand };

export interface TextCommandRepository {
  list(channelId: string): Promise<TextCommand[]>;
  find(channelId: string, name: string): Promise<TextCommand | null>;
  findByAlias(channelId: string, alias: string): Promise<TextCommand | null>;
  create(
    input: NewTextCommand,
    actor: TextCommandActor,
    expectedGraphRevision?: number,
    commandCollisionGuard?: CommandCollisionWriteGuard,
  ): Promise<TextCommandMutationResult>;
  change(input: TextCommandChange, actor: TextCommandActor, commandCollisionGuard?: CommandCollisionWriteGuard): Promise<TextCommandMutationResult>;
  delete(
    channelId: string,
    name: string,
    expectedRevision: number,
    actor: TextCommandActor,
    now: string,
  ): Promise<TextCommandMutationResult>;
  claim(
    channelId: string,
    name: string,
    now: string,
    userId?: string | null,
    userCooldownSeconds?: number,
    prepareVariableChange?: PrepareTextCommandVariableChange,
    variableAmount?: number | null,
    knownCommand?: TextCommand,
  ): Promise<TextCommandClaim | null>;
}
