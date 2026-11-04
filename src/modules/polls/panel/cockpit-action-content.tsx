import { useMemo, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { connectedRefetchInterval, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";
import { Button, Field, SegmentChoice } from "../../../dashboard/ui";
import type { PollsKind } from "../contracts";
import { blockingPollsRun, pollsEntryStartReason } from "./action-model";
import { pollsCockpitActionTexts } from "./action-locale";
import { pollsPanelTexts } from "./locale";
import { loadPollsState } from "./service";
import "./panel.css";

type EntryFilter = "all" | PollsKind;

export default function PollsCockpitStartActionContent({ channelId, language, onActionExecute }: ModuleImmediateActionContentProperties): ReactElement {
  const labels = pollsPanelTexts[language];
  const actionTexts = pollsCockpitActionTexts[language];
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<EntryFilter>("all");
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const stateQuery = useModuleQuery(channelId, "polls", "data", (signal) => loadPollsState(channelId, signal), {
    refetchInterval: connectedRefetchInterval(realtimeStatus === "connected", 15_000),
  });
  const data = stateQuery.data;
  const visibleEntries = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return (data?.entries ?? []).filter((entry) => (filter === "all" || entry.kind === filter) &&
      (term.length === 0 || entry.title.toLocaleLowerCase().includes(term)));
  }, [data?.entries, filter, search]);

  const startEntry = (entryId: string): void => {
    const formData = new FormData();
    formData.set("entryId", entryId);
    void onActionExecute?.(formData);
  };

  return <div className="polls-cockpit-action">
    <div className="polls-cockpit-action__toolbar">
      <Field
        label={labels.search}
        icon="search"
        value={search}
        onChange={setSearch}
        placeholder={labels.searchPlaceholder}
        autoComplete="off"
      />
      <SegmentChoice<EntryFilter>
        label={labels.filter}
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: labels.allKinds },
          { value: "poll", label: labels.polls },
          { value: "prediction", label: labels.predictions },
        ]}
        size="compact"
      />
    </div>
    <div className="polls-cockpit-action__status" role={stateQuery.isError ? "alert" : "status"} aria-live="polite">
      {stateQuery.isError ? labels.loadFailed : data === undefined ? labels.loading : " "}
    </div>
    <div className="polls-cockpit-action__list" aria-busy={stateQuery.isFetching}>
      {visibleEntries.length === 0
        ? data === undefined
          ? <p className="polls-cockpit-action__empty">{labels.loading}</p>
          : data.entries.length === 0
            ? <div className="polls-cockpit-action__empty">
              <p>{actionTexts.emptyEntries}</p>
              <a href={`/channels/${encodeURIComponent(channelId)}/modules/polls`}>{actionTexts.modulePageLink}</a>
            </div>
            : <p className="polls-cockpit-action__empty">{labels.noEntries}</p>
        : visibleEntries.map((entry) => {
          const blockedRun = data === undefined ? null : blockingPollsRun(data, entry.kind);
          const reason = data === undefined ? null : pollsEntryStartReason(data, entry.kind, language);
          const disabled = stateQuery.isError || data === undefined || blockedRun !== null;
          return <article className="polls-cockpit-action__entry" aria-label={entry.title} key={entry.id}>
            <div className="polls-cockpit-action__identity">
              <span className="polls-cockpit-action__kind">{entry.kind === "poll" ? labels.poll : labels.prediction}</span>
              <strong className="polls-cockpit-action__title" title={entry.title}>{entry.title}</strong>
              <span className="polls-cockpit-action__meta">{labels.choiceCount(entry.choices.length)} · {labels.duration}: {String(entry.durationSeconds)} {labels.seconds}</span>
            </div>
            <Button
              variant="primary"
              size="compact"
              disabled={disabled}
              {...(reason === null ? {} : { title: reason })}
              onClick={() => { startEntry(entry.id); }}
            >{labels.start}</Button>
            <span className="polls-cockpit-action__reason" role="note">{reason ?? " "}</span>
          </article>;
        })}
    </div>
  </div>;
}
