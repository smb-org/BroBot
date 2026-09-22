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
  auflisten(channelId: string): Promise<TextCommand[]>;
  finden(channelId: string, name: string): Promise<TextCommand | null>;
  anlegen(input: NewTextCommand, actor: TextCommandActor): Promise<TextCommandMutationResult>;
  aendern(input: TextCommandChange, actor: TextCommandActor): Promise<TextCommandMutationResult>;
  loeschen(channelId: string, name: string, actor: TextCommandActor, now: string): Promise<TextCommandMutationResult>;
  beanspruchen(channelId: string, name: string, now: string): Promise<TextCommandClaim | null>;
}
