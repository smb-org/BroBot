import { dashboardCommonTexts, type DashboardLanguage } from "../locale";

/** An empty table value with a stable visible marker and a spoken label. */
export function EmptyCellValue({ language }: { language?: DashboardLanguage | undefined } = {}) {
  return <><span className="table-empty-value" aria-hidden="true">—</span><span className="sr-only">{dashboardCommonTexts(language).noValue}</span></>;
}
