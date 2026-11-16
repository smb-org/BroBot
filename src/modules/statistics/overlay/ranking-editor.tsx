import type { CSSProperties, ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { overlayAppearanceToJsonObject } from "../../../overlay/appearance";
import { statisticsWordRankingLabels } from "./locale";
import {
  DEFAULT_STATISTICS_WORD_RANKING_CONFIG,
  parseStatisticsWordRankingConfig,
  type StatisticsWordRankingScope,
} from "./state";

import "./ranking-editor.css";

const sampleEntries = [
  { word: "fak", displayWord: "Fak", count: 34 },
  { word: "chat", displayWord: "Chat", count: 25 },
  { word: "alpha", displayWord: "Alpha", count: 18 },
  { word: "stream", displayWord: "Stream", count: 12 },
  { word: "gaming", displayWord: "Gaming", count: 7 },
  { word: "viewer", displayWord: "Viewer", count: 5 },
  { word: "welcome", displayWord: "Welcome", count: 4 },
  { word: "word", displayWord: "Word", count: 3 },
  { word: "live", displayWord: "Live", count: 2 },
  { word: "great", displayWord: "Great", count: 1 },
] as const;

export default function StatisticsWordRankingEditor({
  config,
  onChange,
  language = "de",
  readOnly = false,
  readOnlyReason,
}: OverlayElementEditorProps): ReactElement {
  const values = parseStatisticsWordRankingConfig(config) ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG;
  const labels = statisticsWordRankingLabels(language);
  const titleValue = values.title ?? labels.defaultTitle;
  const sample = sampleEntries.slice(0, values.count);
  const rows = Array.from({ length: values.count }, (_, index) => sample[index] ?? null);
  const number = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 0 });

  const changeScope = (scope: StatisticsWordRankingScope): void => {
    if (!readOnly) onChange({ ...values, scope, appearance: overlayAppearanceToJsonObject(values.appearance) });
  };

  const changeCount = (rawCount: string): void => {
    if (readOnly || rawCount.trim().length === 0) return;
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 3 || count > 10) return;
    onChange({ ...values, count, appearance: overlayAppearanceToJsonObject(values.appearance) });
  };

  const changeTitle = (title: string): void => {
    if (!readOnly) onChange({ ...values, title, appearance: overlayAppearanceToJsonObject(values.appearance) });
  };

  const changeBars = (bars: boolean): void => {
    if (!readOnly) onChange({ ...values, bars, appearance: overlayAppearanceToJsonObject(values.appearance) });
  };

  return <div className="statistics-word-ranking-editor">
    <label className="statistics-word-ranking-editor__field" htmlFor="statistics-word-ranking-scope">
      <span>{labels.scope}</span>
      <select id="statistics-word-ranking-scope" value={values.scope} disabled={readOnly}
        title={readOnly ? readOnlyReason : undefined}
        onChange={(event) => changeScope(event.currentTarget.value as StatisticsWordRankingScope)}>
        <option value="stream">{labels.stream}</option>
        <option value="total">{labels.total}</option>
      </select>
    </label>
    <label className="statistics-word-ranking-editor__field" htmlFor="statistics-word-ranking-count">
      <span>{labels.count}</span>
      <input id="statistics-word-ranking-count" type="number" min={3} max={10} step={1} value={values.count}
        disabled={readOnly} title={readOnly ? readOnlyReason : undefined}
        onChange={(event) => changeCount(event.currentTarget.value)} />
    </label>
    <label className="statistics-word-ranking-editor__field" htmlFor="statistics-word-ranking-title">
      <span>{labels.title}</span>
      <input id="statistics-word-ranking-title" type="text" maxLength={80} value={titleValue}
        disabled={readOnly} title={readOnly ? readOnlyReason : undefined}
        onChange={(event) => changeTitle(event.currentTarget.value)} />
    </label>
    <label className="statistics-word-ranking-editor__toggle" htmlFor="statistics-word-ranking-bars">
      <input id="statistics-word-ranking-bars" type="checkbox" checked={values.bars} disabled={readOnly}
        title={readOnly ? readOnlyReason : undefined}
        onChange={(event) => changeBars(event.currentTarget.checked)} />
      <span>{labels.bars}</span>
    </label>
    <section className="statistics-word-ranking-editor__preview" aria-label={labels.preview}>
      {titleValue.length > 0 ? <h3>{titleValue}</h3> : null}
      <ol style={{ "--preview-row-count": String(values.count) } as CSSProperties}>
        {rows.map((entry, index) => entry === null
          ? <li className="statistics-word-ranking-editor__preview-row statistics-word-ranking-editor__preview-row--empty"
            key={`empty-${String(index)}`} aria-hidden="true" />
          : <li className="statistics-word-ranking-editor__preview-row" key={entry.word}>
            {values.bars ? <span className="statistics-word-ranking-editor__preview-bar"
              style={{ width: `${String(Math.round(entry.count / (sample[0]?.count ?? 1) * 100))}%` }} aria-hidden="true" /> : null}
            <span className="statistics-word-ranking-editor__preview-rank">{String(index + 1)}</span>
            <span className="statistics-word-ranking-editor__preview-word">{entry.displayWord}</span>
            <span className="statistics-word-ranking-editor__preview-count">{number.format(entry.count)}</span>
          </li>)}
      </ol>
    </section>
  </div>;
}
