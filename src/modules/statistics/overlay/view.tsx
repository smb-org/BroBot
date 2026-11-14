import type { ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { STATISTICS_WORD_COUNTER_DEFAULT_SIZE } from "./kinds";
import { statisticsWordCounterLabels } from "./locale";
import {
  DEFAULT_STATISTICS_WORD_COUNTER_CONFIG,
  parseStatisticsWordCounterConfig,
  parseStatisticsWordCounterState,
} from "./state";

import "./view.css";

const formatCount = (count: number, language: "de" | "en"): string =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 0 }).format(count);

const StatisticsWordCounter = ({ config: rawConfig, state: rawState, language = "de" }: ModuleOverlayElementProps): ReactElement => {
  const config = parseStatisticsWordCounterConfig(rawConfig) ?? DEFAULT_STATISTICS_WORD_COUNTER_CONFIG;
  const state = parseStatisticsWordCounterState(rawState);
  const value = state?.words[config.word] ?? { streamCount: 0, totalCount: 0, streamIsLive: false };
  const labels = statisticsWordCounterLabels(language);
  const counters = config.show === "both"
    ? [
      { key: "stream", label: labels.stream, count: value.streamCount },
      { key: "total", label: labels.total, count: value.totalCount },
    ]
    : [{ key: config.show, label: config.show === "stream" ? labels.stream : labels.total,
      count: config.show === "stream" ? value.streamCount : value.totalCount }];

  return <section className={`statistics-word-counter${config.show === "both" ? " statistics-word-counter--both" : ""}`}
    style={STATISTICS_WORD_COUNTER_DEFAULT_SIZE} aria-label={config.label} data-stream-live={String(value.streamIsLive)} data-testid="statistics-word-counter">
    <h2 className="statistics-word-counter__label" title={config.label}>{config.label}</h2>
    <div className="statistics-word-counter__counts">
      {counters.map(({ key, label, count }) => <div className="statistics-word-counter__count" key={key}>
        <span className="statistics-word-counter__caption">{label}</span>
        <strong className="statistics-word-counter__value" aria-live="polite">{formatCount(count, language)}</strong>
      </div>)}
    </div>
  </section>;
};

export default StatisticsWordCounter;
