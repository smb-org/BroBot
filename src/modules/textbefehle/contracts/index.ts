export type TextbefehlArt = "text" | "liste";

export interface Textbefehl {
  channelId: string;
  name: string;
  text: string;
  art: TextbefehlArt;
  enabled: boolean;
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
  cooldownSekunden: number;
  now: string;
}

export interface TextbefehlAenderung {
  channelId: string;
  name: string;
  neuerName: string;
  text: string;
  enabled: boolean;
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
