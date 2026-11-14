import type { CSSProperties, ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { STATISTICS_WORD_RANKING_DEFAULT_SIZE } from "./kinds";
import { statisticsWordRankingLabels } from "./locale";
import {
  DEFAULT_STATISTICS_WORD_RANKING_CONFIG,
  parseStatisticsWordRankingConfig,
  parseStatisticsWordRankingState,
} from "./state";

import "./ranking-view.css";

const formatCount = (count: number, language: "de" | "en"): string =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 0 }).format(count);

const StatisticsWordRanking = ({ config: rawConfig, state: rawState, language = "de" }: ModuleOverlayElementProps): ReactElement => {
  const config = parseStatisticsWordRankingConfig(rawConfig) ?? DEFAULT_STATISTICS_WORD_RANKING_CONFIG;
  const state = parseStatisticsWordRankingState(rawState);
  const scope = config.scope === "stream" ? state?.stream : state?.total;
  const entries = scope?.entries.slice(0, config.count) ?? [];
  const topCount = entries[0]?.count ?? 0;
  const title = config.title ?? statisticsWordRankingLabels(language).defaultTitle;
  const labels = statisticsWordRankingLabels(language);
  const rows = Array.from({ length: config.count }, (_, index) => entries[index] ?? null);

  return <section className={`statistics-word-ranking${title.length === 0 ? " statistics-word-ranking--no-title" : ""}`}
    style={{ ...STATISTICS_WORD_RANKING_DEFAULT_SIZE, "--word-ranking-count": String(config.count) } as CSSProperties}
    aria-label={title.length > 0 ? title : labels.elementLabel}
    data-stream-live={config.scope === "stream" ? String(scope?.streamIsLive ?? false) : undefined}
    data-testid="statistics-word-ranking">
    {title.length > 0 ? <h2 className="statistics-word-ranking__title" title={title}>{title}</h2> : null}
    <ol className="statistics-word-ranking__rows" aria-live="polite" aria-label={labels.elementLabel}>
      {rows.map((entry, index) => {
        if (entry === null) {
          return <li className="statistics-word-ranking__row statistics-word-ranking__row--empty" key={`empty-${String(index)}`} aria-hidden="true" />;
        }
        const width = topCount === 0 ? 0 : Math.round(entry.count / topCount * 100);
        return <li className={`statistics-word-ranking__row${config.bars ? "" : " statistics-word-ranking__row--without-bars"}`}
          key={entry.word} style={{ "--word-ranking-bar-width": `${String(width)}%` } as CSSProperties}>
          {config.bars ? <span className="statistics-word-ranking__bar" aria-hidden="true" /> : null}
          <span className="statistics-word-ranking__rank">{String(index + 1)}</span>
          <span className="statistics-word-ranking__word" title={entry.displayWord}>{entry.displayWord}</span>
          <span className="statistics-word-ranking__count">{formatCount(entry.count, language)}</span>
        </li>;
      })}
    </ol>
  </section>;
};

export default StatisticsWordRanking;
