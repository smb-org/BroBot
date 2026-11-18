import type { CSSProperties, ReactElement } from "react";

import { Field, Select, SwitchRow, UnitInput } from "../../../dashboard/ui";
import type { OverlayElementEditorProps } from "../../contract";
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
}:OverlayElementEditorProps): ReactElement {
  const values = parseStatisticsWordRankingConfig(config) ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG;
  const labels = statisticsWordRankingLabels(language);
  const titleValue = values.title ?? labels.defaultTitle;
  const sample = sampleEntries.slice(0, values.count);
  const rows = Array.from({ length: values.count }, (_, index) => sample[index] ?? null);
  const number = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 0 });

  const changeScope = (scope: StatisticsWordRankingScope): void => {
    if (!readOnly) onChange({ ...values, scope });
  };

  const changeCount = (rawCount: string): void => {
    if (readOnly || rawCount.trim().length === 0) return;
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 3 || count > 10) return;
    onChange({ ...values, count });
  };

  const changeTitle = (title: string): void => {
    if (!readOnly) onChange({ ...values, title });
  };

  const changeBars = (bars: boolean): void => {
    if (!readOnly) onChange({ ...values, bars });
  };

  return <div className="statistics-word-ranking-editor overlay-editor__module-fields">
    <Select label={labels.scope} value={values.scope} disabled={readOnly}
      options={[{ value: "stream", label: labels.stream }, { value: "total", label: labels.total }]}
      onChange={(scope) => { if (scope !== null) changeScope(scope as StatisticsWordRankingScope); }} />
    <UnitInput label={labels.count} value={values.count} min={3} max={10} step={1} disabled={readOnly}
      onChange={(next) => { if (next !== "") changeCount(String(next)); }} />
    <Field label={labels.title} value={titleValue} disabled={readOnly} normalize={(title) => title.slice(0, 80)}
      onChange={changeTitle} />
    <SwitchRow label={labels.bars} checked={values.bars} disabled={readOnly} onChange={changeBars} />
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
