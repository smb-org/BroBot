import type {
  NewTextCommand,
  TextCommand,
  TextCommandChange,
  TextCommandClaim,
  TextCommandActor,
} from "./contracts";

export type TextCommandMutationReason =
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
  | { ok: false; reason: TextCommandMutationReason; conflict?: TextCommandAliasConflict };

export interface TextCommandRepository {
  list(channelId: string): Promise<TextCommand[]>;
  find(channelId: string, name: string): Promise<TextCommand | null>;
  findByAlias(channelId: string, alias: string): Promise<TextCommand | null>;
  create(input: NewTextCommand, actor: TextCommandActor): Promise<TextCommandMutationResult>;
  change(input: TextCommandChange, actor: TextCommandActor): Promise<TextCommandMutationResult>;
  delete(channelId: string, name: string, actor: TextCommandActor, now: string): Promise<TextCommandMutationResult>;
  claim(
    channelId: string,
    name: string,
    now: string,
    userId?: string | null,
    userCooldownSeconds?: number,
  ): Promise<TextCommandClaim | null>;
}
