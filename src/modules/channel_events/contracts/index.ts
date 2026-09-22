export type ChannelEventDetail = Readonly<Record<string, string | number | null>>;

export interface ChannelEventDiagnostic {
  code: string;
  detail?: ChannelEventDetail;
}
