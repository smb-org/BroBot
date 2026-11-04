import { useCallback, useMemo, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { connectedRefetchInterval, useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";
import { Button, Select } from "../../../dashboard/ui";
import type { PollsRunChoice } from "../contracts";
import { isPollsPanelState, openPollsPredictions } from "./action-model";
import { pollsCockpitActionTexts } from "./action-locale";
import { pollsPanelTexts } from "./locale";
import { ResolvePredictionContents } from "./ResolveDialog";
import { loadPollsState } from "./service";
import "./panel.css";

const formatPredictionDate = (value: string, language: "de" | "en"): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", { dateStyle: "short", timeStyle: "short" }).format(timestamp);
};

export default function PollsCockpitResolveActionContent({ channelId, language, onActionExecute, footerElement }: ModuleImmediateActionContentProperties): ReactElement {
  const labels = pollsPanelTexts[language];
  const actionTexts = pollsCockpitActionTexts[language];
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [choiceSelection, setChoiceSelection] = useState<{ runId: string; choice: PollsRunChoice | null }>({ runId: "", choice: null });
  const [readyRunId, setReadyRunId] = useState<string | null>(null);
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const stateQuery = useModuleQuery(channelId, "polls", "data", (signal) => loadPollsState(channelId, signal), {
    refetchInterval: connectedRefetchInterval(realtimeStatus === "connected", 15_000),
  });
  const data = isPollsPanelState(stateQuery.data) ? stateQuery.data : undefined;
  const stateInvalid = stateQuery.data !== undefined && data === undefined;
  const stateFailed = stateQuery.isError || stateInvalid;
  const predictions = useMemo(() => data === undefined ? [] : openPollsPredictions(data), [data]);
  const selectedRun = predictions.find(({ id }) => id === selectedRunId) ?? predictions[0] ?? null;
  const runOptions = useMemo(() => predictions.map((run) => ({
    value: run.id,
    label: `${run.title} · ${formatPredictionDate(run.startedAt, language)}`,
  })), [language, predictions]);
  const currentRunId = selectedRun?.id ?? null;
  const selectedChoice = currentRunId !== null && choiceSelection.runId === currentRunId ? choiceSelection.choice : null;
  const choicesReady = currentRunId !== null && readyRunId === currentRunId;
  const onChoiceChange = useCallback((choice: PollsRunChoice | null) => {
    if (currentRunId !== null) setChoiceSelection({ runId: currentRunId, choice });
  }, [currentRunId]);
  const onReadyChange = useCallback((ready: boolean) => {
    setReadyRunId(ready ? currentRunId : null);
  }, [currentRunId]);

  const resolveSelected = (): void => {
    if (selectedRun === null || selectedChoice === null || !choicesReady || onActionExecute === undefined) return;
    const formData = new FormData();
    formData.set("runId", selectedRun.id);
    formData.set("winningChoiceId", selectedChoice.id);
    void onActionExecute(formData);
  };

  return <div className="polls-cockpit-action polls-cockpit-action--resolve">
    {stateFailed ? <div className="polls-cockpit-action__status" role="alert">{actionTexts.openPredictionCheckFailed}</div> : null}
    {predictions.length === 0
      ? <p className="polls-cockpit-action__empty">{data === undefined ? stateFailed ? actionTexts.openPredictionCheckFailed : labels.loading : actionTexts.noOpenPrediction}</p>
      : <>
        <Select
          label={predictions.length > 1 ? actionTexts.choosePrediction : labels.prediction}
          value={selectedRun?.id ?? null}
          onChange={setSelectedRunId}
          options={runOptions}
          disabled={predictions.length === 1}
        />
        {selectedRun === null ? null : <ResolvePredictionContents
          key={selectedRun.id}
          channelId={channelId}
          run={selectedRun}
          language={language}
          canOperate
          onChoiceChange={onChoiceChange}
          onReadyChange={onReadyChange}
        />}
        {footerElement === null || footerElement === undefined ? null : createPortal(
          <Button
            variant="primary"
            disabled={selectedRun === null || selectedChoice === null || !choicesReady || onActionExecute === undefined}
            onClick={resolveSelected}
          >{selectedChoice === null ? labels.resolve : labels.resolveChoice(selectedChoice.title)}</Button>,
          footerElement,
        )}
      </>}
  </div>;
}
