import { dashboardCommonTexts } from "../locale";

/** An empty table value with a stable visible marker and a spoken label. */
export function EmptyCellValue() {
  return <><span className="table-empty-value" aria-hidden="true">—</span><span className="sr-only">{dashboardCommonTexts().noValue}</span></>;
}
