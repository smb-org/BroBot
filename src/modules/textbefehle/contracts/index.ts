export type TextbefehlArt = "text" | "liste";
export const TEXTBEFEHL_MINDESTSTUFEN = ["alle", "abonnent", "vip", "moderator", "broadcaster"] as const;
export type TextbefehlMindeststufe = (typeof TEXTBEFEHL_MINDESTSTUFEN)[number];

export interface Textbefehl {
  channelId: string;
  name: string;
  text: string;
  art: TextbefehlArt;
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
  art: TextbefehlArt;
  mindeststufe?: TextbefehlMindeststufe;
  cooldownSekunden: number;
  now: string;
}

export interface TextbefehlAenderung {
  channelId: string;
  name: string;
  neuerName: string;
  text: string;
  enabled: boolean;
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
