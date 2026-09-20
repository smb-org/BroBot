import type {
  NeuerTextbefehl,
  Textbefehl,
  TextbefehlAenderung,
  TextbefehlBeanspruchung,
  TextbefehlAkteur,
} from "./contracts";

export type TextbefehlMutationsgrund =
  | "existiert"
  | "nicht_gefunden"
  | "nicht_berechtigt";

export type TextbefehlMutationsergebnis =
  | { ok: true }
  | { ok: false; grund: TextbefehlMutationsgrund };

export interface TextbefehlRepository {
  auflisten(channelId: string): Promise<Textbefehl[]>;
  finden(channelId: string, name: string): Promise<Textbefehl | null>;
  anlegen(input: NeuerTextbefehl, actor: TextbefehlAkteur): Promise<TextbefehlMutationsergebnis>;
  aendern(input: TextbefehlAenderung, actor: TextbefehlAkteur): Promise<TextbefehlMutationsergebnis>;
  loeschen(channelId: string, name: string, actor: TextbefehlAkteur, now: string): Promise<TextbefehlMutationsergebnis>;
  beanspruchen(channelId: string, name: string, now: string): Promise<TextbefehlBeanspruchung | null>;
}
