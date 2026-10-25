import { useEffect, useState, type ReactElement } from "react";

import { useModuleQuery } from "../../../dashboard/data/module-query";
import { Field, Icon, SwitchRow } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { StatisticsWordsResponse } from "../contracts";
import { loadStatisticsWords } from "./service";
import { statisticsWordsPanelTexts } from "./words-locale";
import "./words-panel.css";

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MILLISECONDS = 250;

const numberFormatter = (language: "de" | "en"): Intl.NumberFormat => new Intl.NumberFormat(
  language === "de" ? "de-DE" : "en-US",
  { maximumFractionDigits: 0 },
);

const formatRelativeTime = (date: string, language: "de" | "en"): string => {
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) return date;
  const elapsedSeconds = (timestamp - Date.now()) / 1_000;
  const absoluteSeconds = Math.abs(elapsedSeconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = absoluteSeconds < 60
    ? [Math.round(elapsedSeconds), "second"]
    : absoluteSeconds < 3_600
      ? [Math.round(elapsedSeconds / 60), "minute"]
      : absoluteSeconds < 86_400
        ? [Math.round(elapsedSeconds / 3_600), "hour"]
        : [Math.round(elapsedSeconds / 86_400), "day"];
  return new Intl.RelativeTimeFormat(language === "de" ? "de" : "en", { numeric: "auto", style: "short" }).format(value, unit);
};

const shareFormatter = (language: "de" | "en"): Intl.NumberFormat => new Intl.NumberFormat(
  language === "de" ? "de-DE" : "en-US",
  { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 },
);

const skeletonRows = Array.from({ length: 12 }, (_unused, index) => index);

export function StatisticsWordsPanel({ channelId, language = "de" }: ModulePanelProperties): ReactElement {
  const labels = statisticsWordsPanelTexts(language);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [hideFillers, setHideFillers] = useState(true);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchDraft);
      setPage(1);
    }, SEARCH_DEBOUNCE_MILLISECONDS);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const queryPart = `words:${JSON.stringify([page, search, hideFillers])}`;
  const query = useModuleQuery<StatisticsWordsResponse>(
    channelId,
    "statistics",
    queryPart,
    (signal) => loadStatisticsWords(channelId, page, search, hideFillers, signal),
  );
  const data = query.data;
  const rows = data?.words ?? [];
  const maxCount = data?.maxCount ?? 0;
  const formatNumber = numberFormatter(language);
  const formatShare = shareFormatter(language);
  const start = data === undefined || data.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = data === undefined ? 0 : Math.min(page * PAGE_SIZE, data.total);
  const pageSummary = data === undefined
    ? ""
    : labels.pageSummary(formatNumber.format(start), formatNumber.format(end), formatNumber.format(data.total));
  const emptyTitle = data?.totalCount === 0 ? labels.emptyTitle : labels.noMatchesTitle;
  const emptyDescription = data?.totalCount === 0 ? labels.emptyDescription : labels.noMatchesDescription;

  return <section className="statistics-words" aria-label={labels.title}>
    <div className="statistics-words__controls">
      <Field
        className="statistics-words__search"
        label={labels.search}
        ariaLabel={labels.search}
        clearLabel={labels.clearSearch}
        variant="search"
        value={searchDraft}
        placeholder={labels.searchPlaceholder}
        onChange={(value) => setSearchDraft(value.slice(0, 80))}
      />
      <div className="statistics-words__filler-toggle">
        <SwitchRow
          label={labels.hideFillers}
          checked={hideFillers}
          onChange={(checked) => {
            setHideFillers(checked);
            setPage(1);
          }}
        />
      </div>
      <div className="statistics-words__privacy-note" role="note">
        <Icon name="info" />
        <span>{labels.privacyNote}</span>
      </div>
      <div className="statistics-words__paging">
        <span className="statistics-words__range" aria-live="polite">{pageSummary}</span>
        <button
          type="button"
          aria-label={labels.previousPage}
          disabled={page <= 1 || query.isFetching}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          <Icon name="chevron-left" size={20} />
        </button>
        <button
          type="button"
          aria-label={labels.nextPage}
          disabled={data === undefined || page >= data.totalPages || query.isFetching}
          onClick={() => setPage((current) => current + 1)}
        >
          <Icon name="chevron-right" size={20} />
        </button>
      </div>
    </div>
    <div className="statistics-words__table-scroll" aria-busy={query.isLoading}>
      <table className="statistics-words__table" aria-label={labels.title} aria-describedby="statistics-words-rank-context">
        <colgroup>
          <col className="statistics-words__column--rank" />
          <col className="statistics-words__column--word" />
          <col className="statistics-words__column--count" />
          <col className="statistics-words__column--share" />
          <col className="statistics-words__column--last-seen" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="statistics-words__heading--number">{labels.rank}</th>
            <th scope="col">{labels.word}</th>
            <th scope="col" className="statistics-words__heading--number">{labels.count}</th>
            <th scope="col">{labels.share}</th>
            <th scope="col" className="statistics-words__last-seen-heading">{labels.lastSeen}</th>
          </tr>
        </thead>
        <tbody>
          {query.isLoading ? skeletonRows.map((row) => <tr key={row} aria-hidden="true">
            <td><span className="statistics-words__skeleton statistics-words__skeleton--short" /></td>
            <td><span className="statistics-words__skeleton" /></td>
            <td><span className="statistics-words__skeleton statistics-words__skeleton--short" /></td>
            <td><span className="statistics-words__skeleton statistics-words__skeleton--bar" /></td>
            <td className="statistics-words__last-seen"><span className="statistics-words__skeleton statistics-words__skeleton--short" /></td>
          </tr>) : query.isError ? <tr>
            <td colSpan={5} className="statistics-words__empty-cell">
              <div className="statistics-words__empty" role="alert">
                <strong>{labels.loadError}</strong>
                <button type="button" onClick={() => { void query.refetch(); }}>{labels.retry}</button>
              </div>
            </td>
          </tr> : rows.length === 0 ? <tr>
            <td colSpan={5} className="statistics-words__empty-cell">
              <div className="statistics-words__empty">
                <strong>{emptyTitle}</strong>
                <p>{emptyDescription}</p>
              </div>
            </td>
          </tr> : rows.map((word) => {
            const percentage = formatShare.format(word.share);
            const relativeCount = maxCount === 0 ? 0 : Math.min(100, word.count / maxCount * 100);
            const relativeLastSeen = formatRelativeTime(word.lastSeenAt, language);
            return <tr key={word.word}>
              <td className="statistics-words__rank">{formatNumber.format(word.rank)}</td>
              <td className="statistics-words__word-cell">
                <span className="statistics-words__word">{word.word}</span>
                <time className="statistics-words__word-last-seen" dateTime={word.lastSeenAt} aria-label={`${labels.lastSeen}: ${relativeLastSeen}`}>
                  {relativeLastSeen}
                </time>
              </td>
              <td className="statistics-words__count">{formatNumber.format(word.count)}</td>
              <td className="statistics-words__share-cell">
                <span className="statistics-words__share" role="img" aria-label={labels.shareBar(percentage)}>
                  <span className="statistics-words__share-track" aria-hidden="true">
                  <span className="statistics-words__share-fill" style={{ width: `${relativeCount.toString()}%` }} />
                  </span>
                  <span className="statistics-words__share-value">{percentage}</span>
                </span>
              </td>
              <td className="statistics-words__last-seen">
                <time dateTime={word.lastSeenAt}>{relativeLastSeen}</time>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    <span className="sr-only" id="statistics-words-rank-context">{labels.rankContext}</span>
  </section>;
}
