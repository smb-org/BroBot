import { useEffect, useState, type ReactElement } from "react";

import { Button, Dialog, NativeRadio } from "../../../dashboard/ui";
import type { PollsRun, PollsRunChoice } from "../contracts";
import { pollsPanelTexts } from "./locale";
import { pollsApiErrorMessage } from "./error-message";
import { loadFreshPrediction } from "./service";

interface ResolvePredictionContentsProperties {
  channelId: string;
  run: PollsRun;
  language: "de" | "en";
  canOperate: boolean;
  onChoiceChange: (choice: PollsRunChoice | null) => void;
  onReadyChange: (ready: boolean) => void;
}

export function ResolvePredictionContents({ channelId, run, language, canOperate, onChoiceChange, onReadyChange }: ResolvePredictionContentsProperties): ReactElement {
  const labels = pollsPanelTexts[language];
  const [freshRun, setFreshRun] = useState<PollsRun | null>(null);
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    onChoiceChange(null);
    onReadyChange(false);
    void loadFreshPrediction(channelId, run.id, controller.signal).then((fresh) => {
      if (controller.signal.aborted) return;
      setFreshRun(fresh);
      onReadyChange(fresh.choices.length > 0);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(pollsApiErrorMessage(error, labels));
      onReadyChange(false);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [channelId, labels, onChoiceChange, onReadyChange, run.id]);

  const formatCount = (value: number | null): string => new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US").format(value ?? 0);

  return <div className="polls-resolve-dialog__body" aria-busy={loading}>
    {loading ? <p className="polls-resolve-dialog__state">{labels.loadingFresh}</p>
      : loadError !== null ? <p className="polls-resolve-dialog__state" role="alert">{loadError}</p>
        : freshRun === null || freshRun.choices.length === 0 ? <p className="polls-resolve-dialog__state">{labels.noOutcomes}</p>
          : <div className="polls-resolve-dialog__choices" role="radiogroup" aria-label={labels.choices}>
            {freshRun.choices.map((choice) => <label className="polls-resolve-choice" key={choice.id}>
              <NativeRadio
                name={`polls-resolve-${run.id}`}
                value={choice.id}
                checked={selectedChoiceId === choice.id}
                onChange={() => {
                  setSelectedChoiceId(choice.id);
                  onChoiceChange(choice);
                }}
                ariaLabel={choice.title}
                disabled={!canOperate}
              />
              <span className="polls-resolve-choice__title">{choice.title}</span>
              <span className="polls-resolve-choice__counts">
                {formatCount(choice.users)} {labels.users(choice.users ?? 0)} · {formatCount(choice.channelPoints)} {labels.points}
              </span>
            </label>)}
          </div>}
  </div>;
}

interface ResolveDialogProperties {
  channelId: string;
  run: PollsRun;
  language: "de" | "en";
  canOperate: boolean;
  onClose: () => void;
  onResolve: (choiceId: string) => Promise<void>;
}

export default function ResolveDialog({ channelId, run, language, canOperate, onClose, onResolve }: ResolveDialogProperties): ReactElement {
  const labels = pollsPanelTexts[language];
  const [selectedChoice, setSelectedChoice] = useState<PollsRunChoice | null>(null);
  const [choicesReady, setChoicesReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const confirm = async (): Promise<void> => {
    if (!canOperate || !choicesReady || selectedChoice === null || pending) return;
    setPending(true);
    setActionError(null);
    try {
      await onResolve(selectedChoice.id);
    } catch (error) {
      setActionError(pollsApiErrorMessage(error, labels));
    } finally {
      setPending(false);
    }
  };

  return <Dialog opened title={labels.resolveDialog} onClose={onClose} pending={pending} className="polls-resolve-dialog">
    <ResolvePredictionContents
      channelId={channelId}
      run={run}
      language={language}
      canOperate={canOperate && !pending}
      onChoiceChange={setSelectedChoice}
      onReadyChange={setChoicesReady}
    />
    <div className="polls-resolve-dialog__error" role="alert" aria-live="polite">{actionError ?? " "}</div>
    <div className="polls-resolve-dialog__actions">
      <Button variant="subtle" onClick={onClose} disabled={pending}>{labels.closeDialog}</Button>
      <Button variant="primary" onClick={() => { void confirm(); }} disabled={!canOperate || !choicesReady || selectedChoice === null || pending}>
        {selectedChoice === null ? labels.resolve : labels.resolveChoice(selectedChoice.title)}
      </Button>
    </div>
  </Dialog>;
}
