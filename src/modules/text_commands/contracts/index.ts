export type TextbefehlArt = "text" | "list";
export const TEXTBEFEHL_MINDESTSTUFEN = ["everyone", "subscriber", "vip", "moderator", "broadcaster"] as const;
export type TextbefehlMindeststufe = (typeof TEXTBEFEHL_MINDESTSTUFEN)[number];

export interface Textbefehl {
  channelId: string;
  name: string;
  text: string;
  kind: TextbefehlArt;
  enabled: boolean;
  mindeststufe: TextbefehlMindeststufe;
  cooldownSekunden: number;
  zuletztVerwendetAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NeuerTextbefehl {
  channelId: string;
  name: string;
  text: string;
  kind: TextbefehlArt;
  mindeststufe?: TextbefehlMindeststufe;
  cooldownSekunden: number;
  now: string;
}

export interface TextbefehlAenderung {
  channelId: string;
  name: string;
  neuerName: string;
  text: string;
  kind: TextbefehlArt;
  enabled: boolean;
  nurSchalter?: boolean;
  mindeststufe?: TextbefehlMindeststufe;
  cooldownSekunden: number;
  now: string;
}

export interface TextbefehlBeanspruchung {
  befehl: Textbefehl;
  beansprucht: boolean;
}

export interface TextbefehlAkteur {
  userId: string;
  sessionId?: string;
}
