import type { EventCode } from "../../../contracts/values";

export type ChannelEventDetail = Readonly<Record<string, string | number | null>>;

export interface ChannelEventDiagnostic {
  code: EventCode;
  detail?: ChannelEventDetail;
}
