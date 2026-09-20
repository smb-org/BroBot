export type KanalereignisDetail = Readonly<Record<string, string | number | null>>;

export interface KanalereignisDiagnose {
  code: string;
  detail?: KanalereignisDetail;
}
