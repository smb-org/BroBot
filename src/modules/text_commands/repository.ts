import type {
  NewTextCommand,
  TextCommand,
  TextCommandChange,
  TextCommandClaim,
  TextCommandActor,
} from "./contracts";

export type TextCommandMutationReason =
  | "existiert"
  | "nicht_gefunden"
  | "konflikt"
  | "nicht_berechtigt";

export type TextCommandMutationResult =
  | { ok: true }
  | { ok: false; reason: TextCommandMutationReason };

export interface TextCommandRepository {
  list(channelId: string): Promise<TextCommand[]>;
  find(channelId: string, name: string): Promise<TextCommand | null>;
  create(input: NewTextCommand, actor: TextCommandActor): Promise<TextCommandMutationResult>;
  change(input: TextCommandChange, actor: TextCommandActor): Promise<TextCommandMutationResult>;
  delete(channelId: string, name: string, actor: TextCommandActor, now: string): Promise<TextCommandMutationResult>;
  claim(channelId: string, name: string, now: string): Promise<TextCommandClaim | null>;
}
