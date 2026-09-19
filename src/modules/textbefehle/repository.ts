import type {
  NeuerTextbefehl,
  Textbefehl,
  TextbefehlAenderung,
  TextbefehlBeanspruchung,
  TextbefehlAkteur,
} from "./contracts";

export interface TextbefehlRepository {
  auflisten(channelId: string): Promise<Textbefehl[]>;
  finden(channelId: string, name: string): Promise<Textbefehl | null>;
  anlegen(input: NeuerTextbefehl, actor: TextbefehlAkteur): Promise<boolean>;
  aendern(input: TextbefehlAenderung, actor: TextbefehlAkteur): Promise<boolean>;
  loeschen(channelId: string, name: string, actor: TextbefehlAkteur, now: string): Promise<boolean>;
  beanspruchen(channelId: string, name: string, now: string): Promise<TextbefehlBeanspruchung | null>;
}
