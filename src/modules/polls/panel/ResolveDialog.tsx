import { useEffect, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { Button, Dialog, NativeRadio } from "../../../dashboard/ui";
import type { PollsRun } from "../contracts";
import { pollsPanelTexts } from "./locale";
import { loadFreshPrediction } from "./service";

interface ResolveDialogProperties {
  channelId: string;
  run: PollsRun;
  language: "de" | "en";
  canOperate: boolean;
  onClose: () => void;
  onResolve: (choiceId: string) => Promise<void>;
}

const resolveError = (error: unknown, labels: typeof pollsPanelTexts.en): string => {
  if (!(error instanceof PanelApiError)) return labels.requestFailed;
  if (error.code === "polls_not_open") return labels.notOpen;
  if (error.code === "polls_run_not_found") return labels.runNotFound;
  if (error.code === "polls_not_eligible") return labels.notEligible;
  if (error.code === "polls_management_denied" || error.code === "polls_precondition_failed") return labels.managementDenied;
  if (error.code === "polls_module_disabled") return labels.moduleDisabled;
  if (error.code === "polls_rate_limited") return labels.rateLimited;
  if (error.code === "polls_network") return labels.network;
  if (error.code === "polls_not_connected") return labels.missingConnection;
  if (error.code === "polls_token_unavailable") return labels.tokenUnavailable;
  if (error.code === "polls_scope_missing") return labels.missingScope;
  if (error.code === "polls_revoked") return labels.revoked;
  if (error.code === "polls_refresh_failed") return labels.refreshFailed;
  if (error.code === "polls_unknown_status") return labels.twitchStatusUnknown;
  if (error.code === "polls_invalid_response") return labels.twitchInvalidResponse;
  if (error.code === "polls_invalid_choice" || error.code === "polls_invalid_input") return labels.choiceInvalid;
  return labels.requestFailed;
};

export default function ResolveDialog({ channelId, run, language, canOperate, onClose, onResolve }: ResolveDialogProperties): ReactElement {
  const labels = pollsPanelTexts[language];
  const [freshRun, setFreshRun] = useState<PollsRun | null>(null);
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadFreshPrediction(channelId, run.id, controller.signal).then((fresh) => {
      if (controller.signal.aborted) return;
      setFreshRun(fresh);
      setSelectedChoiceId(null);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setLoadError(resolveError(error, labels));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [channelId, labels, run.id]);

  const selected = freshRun?.choices.find(({ id }) => id === selectedChoiceId) ?? null;
  const confirm = async (): Promise<void> => {
    if (!canOperate || selected === null || pending) return;
    setPending(true);
    setActionError(null);
    try {
      await onResolve(selected.id);
    } catch (error) {
      setActionError(resolveError(error, labels));
    } finally {
      setPending(false);
    }
  };

  const formatCount = (value: number | null): string => new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US").format(value ?? 0);

  return <Dialog opened title={labels.resolveDialog} onClose={onClose} pending={pending} className="polls-resolve-dialog">
    <div className="polls-resolve-dialog__body" aria-busy={loading}>
      {loading ? <p className="polls-resolve-dialog__state">{labels.loadingFresh}</p>
        : loadError !== null ? <p className="polls-resolve-dialog__state" role="alert">{loadError}</p>
          : freshRun === null || freshRun.choices.length === 0 ? <p className="polls-resolve-dialog__state">{labels.noOutcomes}</p>
            : <div className="polls-resolve-dialog__choices" role="radiogroup" aria-label={labels.choices}>
              {freshRun.choices.map((choice) => <label className="polls-resolve-choice" key={choice.id}>
                <NativeRadio
                  name={`polls-resolve-${run.id}`}
                  value={choice.id}
                  checked={selectedChoiceId === choice.id}
                  onChange={() => { setSelectedChoiceId(choice.id); setActionError(null); }}
                  ariaLabel={choice.title}
                  disabled={!canOperate || pending}
                />
                <span className="polls-resolve-choice__title">{choice.title}</span>
                <span className="polls-resolve-choice__counts">
                  {formatCount(choice.users)} {labels.users} · {formatCount(choice.channelPoints)} {labels.points}
                </span>
              </label>)}
            </div>}
    </div>
    <div className="polls-resolve-dialog__error" role="alert" aria-live="polite">{actionError ?? "\u00a0"}</div>
    <div className="polls-resolve-dialog__actions">
      <Button variant="subtle" onClick={onClose} disabled={pending}>{labels.closeDialog}</Button>
      <Button variant="primary" onClick={() => { void confirm(); }} disabled={!canOperate || loading || loadError !== null || selected === null || pending}>
        {selected === null ? labels.resolve : labels.resolveChoice(selected.title)}
      </Button>
    </div>
  </Dialog>;
}
