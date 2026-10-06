import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { Button, Led, LoadState, notify, NumberField, SegmentedControl, Skeleton } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { ChatVotePreset } from "../contracts";
import type { ChatVotingPanelState } from "./service";
import { closeChatVoting, loadChatVotingState, startChatVoting } from "./service";
import { chatVotingPanelTexts } from "./locale-panel";

const dateText = (value: string | null, language: DashboardLanguage): string => {
  if (value === null || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
};

const timeText = (value: string, language: DashboardLanguage): string =>
  Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(language, { timeStyle: "short" }).format(new Date(value))
    : "—";

type DurationPreset = "open" | "one" | "two" | "five" | "custom";

const durationPresetFor = (seconds: number): DurationPreset =>
  seconds === 0 ? "open" : seconds === 60 ? "one" : seconds === 120 ? "two" : seconds === 300 ? "five" : "custom";

const secondsForDurationPreset = (preset: DurationPreset, customSeconds: number | ""): number | "" =>
  preset === "open" ? 0 : preset === "one" ? 60 : preset === "two" ? 120 : preset === "five" ? 300 : customSeconds;

export const ChatVotingPanel = ({ channelId, language = "de", canOperate = true }: ModulePanelProperties): ReactElement => {
  const labels = chatVotingPanelTexts(language);
  const [state, setState] = useState<ChatVotingPanelState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadErrorNotified = useRef(false);
  const [busy, setBusy] = useState(false);
  const [draftPreset, setDraftPreset] = useState<ChatVotePreset>("yes_no");
  const [draftOptionCount, setDraftOptionCount] = useState<number | "">(2);
  const [draftDurationPreset, setDraftDurationPreset] = useState<DurationPreset | null>(null);
  const [draftCustomDurationSeconds, setDraftCustomDurationSeconds] = useState<number | "">(60);
  const configurationInitialized = useRef(false);
  const durationDraftTouched = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await loadChatVotingState(channelId);
      setState(next);
      if (!configurationInitialized.current || next.vote?.status !== "open" && !durationDraftTouched.current) {
        const defaultDurationSeconds = next.defaultDurationSeconds;
        const defaultDurationPreset = durationPresetFor(defaultDurationSeconds);
        setDraftDurationPreset(defaultDurationPreset);
        if (defaultDurationPreset === "custom") setDraftCustomDurationSeconds(defaultDurationSeconds);
        durationDraftTouched.current = false;
        configurationInitialized.current = true;
      }
      setLoadFailed(false);
      loadErrorNotified.current = false;
    } catch {
      setLoadFailed(true);
      if (!loadErrorNotified.current) {
        loadErrorNotified.current = true;
        notify({ tone: "error", message: labels.loadError });
      }
    }
  }, [channelId, labels.loadError, setDraftCustomDurationSeconds, setDraftDurationPreset]);

  useEffect(() => { void Promise.resolve().then(() => refresh()); }, [refresh]);

  useEffect(() => {
    const poll = (): void => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(poll, 2_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);

  const start = async (): Promise<void> => {
    if (draftDurationPreset === null) return;
    const durationSeconds = secondsForDurationPreset(draftDurationPreset, draftCustomDurationSeconds);
    const validOptionCount = typeof draftOptionCount === "number" && Number.isInteger(draftOptionCount) && draftOptionCount >= 2 && draftOptionCount <= 9;
    if (durationSeconds === "" || !Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 14_400 ||
        draftPreset === "options_n" && !validOptionCount) return;
    setBusy(true);
    try {
      await startChatVoting(channelId, draftPreset, draftPreset === "options_n" ? draftOptionCount as number : undefined, durationSeconds);
      const defaultDurationSeconds = state?.defaultDurationSeconds ?? 0;
      const defaultDurationPreset = durationPresetFor(defaultDurationSeconds);
      setDraftDurationPreset(defaultDurationPreset);
      if (defaultDurationPreset === "custom") setDraftCustomDurationSeconds(defaultDurationSeconds);
      durationDraftTouched.current = false;
      await refresh();
    } catch (error: unknown) {
      notify({ tone: "error", message: error instanceof Error && "code" in error && error.code === "chat_voting_busy" ? labels.busy : labels.startError });
    } finally {
      setBusy(false);
    }
  };

  const close = async (): Promise<void> => {
    setBusy(true);
    try {
      await closeChatVoting(channelId);
      await refresh();
    } catch {
      notify({ tone: "error", message: labels.closeError });
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return <section className="module-stack chat-voting-panel" aria-label={labels.title}>
    <LoadState
      status={loadFailed ? "error" : "loading"}
      minHeight="calc(var(--s10) * 20)"
      loading={<Skeleton rows={8} height={34} />}
      empty={<p className="empty-state">{labels.noVote}</p>}
      error={<div />}
    >{null}</LoadState>
  </section>;
  const vote = state.vote;
  const running = vote?.status === "open";
  const counts = state.counts ?? vote?.counts ?? [];
  const total = counts.reduce((sum, count) => sum + count, 0);
  const closed = vote?.status === "closed";
  const activeBallot = running || state.hasOpenBallot;
  const configurationDisabled = busy || activeBallot || !canOperate;
  const displayedPreset = running ? vote.preset : draftPreset;
  const displayedOptionCount = running ? vote.optionCount : draftOptionCount;
  const displayedDurationPreset = running
    ? durationPresetFor(vote.requestedDurationSeconds ?? 0)
    : draftDurationPreset;
  const displayedCustomDurationSeconds = running && displayedDurationPreset === "custom"
    ? vote.requestedDurationSeconds ?? ""
    : draftCustomDurationSeconds;
  const validOptionCount = typeof draftOptionCount === "number" && Number.isInteger(draftOptionCount) && draftOptionCount >= 2 && draftOptionCount <= 9;
  const durationSeconds = draftDurationPreset === null ? "" : secondsForDurationPreset(draftDurationPreset, draftCustomDurationSeconds);
  const validDuration = typeof durationSeconds === "number" && Number.isSafeInteger(durationSeconds) && durationSeconds >= 0 && durationSeconds <= 14_400;
  const validConfiguration = (draftPreset !== "options_n" || validOptionCount) && validDuration;
  const disabledReason = !canOperate ? labels.roleDisabledReason : activeBallot && !running ? labels.startDisabledReason : null;
  const actionHint = !running && draftPreset === "options_n" && !validOptionCount ? labels.invalidOptionCount
    : !running && !validDuration ? labels.invalidDuration
      : disabledReason;
  const loadStateProps = {
    minHeight: "calc(var(--s10) * 20)",
    loading: <Skeleton rows={8} height={34} />,
    empty: <p className="empty-state">{labels.noVote}</p>,
    error: <p className="form-error" role="alert">{labels.loadError}</p>,
  } as const;

  return <section className="module-stack chat-voting-panel" aria-label={labels.title}>
    <LoadState status="success" {...loadStateProps}>
    <section className="config-section" aria-label={labels.title}>
      <div className="section-heading">
        <h2>{labels.title}</h2>
        <div className="chat-voting-panel__status" data-testid="chat-voting-header-status"
          style={{ display: "flex", flexWrap: "nowrap", alignItems: "center", width: "calc(var(--s10) * 6)", minWidth: "calc(var(--s10) * 6)", maxWidth: "calc(var(--s10) * 6)", height: "calc(var(--s10) + var(--s2))", overflow: "hidden", whiteSpace: "nowrap" }}>
          <Led
            status={running ? "green" : "off"}
            word={vote === null ? labels.readyStatus : running ? labels.runningStatus : labels.closedStatus}
          />
          <span className="muted" data-testid="chat-voting-header-detail" aria-hidden={!running}
            title={running ? vote.requestedDurationSeconds === null ? labels.openStatus : labels.ends(timeText(vote.closesAt, language)) : ""}
            style={{ minWidth: 0, flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {running ? `· ${vote.requestedDurationSeconds === null ? labels.openStatus : labels.ends(timeText(vote.closesAt, language))}` : ""}
          </span>
        </div>
      </div>
      <div className="chat-voting-result-area" style={{ height: "calc(var(--s10) * 7)", overflowY: "auto" }}>
        {vote === null ? <>
          <p className="empty-state">{labels.noVote}</p>
        </> : <>
          <p className="muted">{labels.starts(dateText(vote.openedAt, language))}</p>
          <div className="chat-voting-results" aria-label={labels.results}>
            <div className="chat-voting-results__header" aria-hidden="true">
              <span /> <span /> <span>{labels.count}</span> <span>{labels.percent}</span>
            </div>
            {vote.labels.map((label, index) => {
              const count = counts[index] ?? 0;
              const percent = total === 0 ? 0 : Math.round(count * 100 / total);
              return <div className="chat-voting-results__row" key={`${vote.id}-${String(index)}`} role="group" aria-label={labels.resultBar(label, count, percent)}>
                <span className="chat-voting-results__label">{label}</span>
                <span className="chat-voting-results__track" aria-hidden="true"><span style={{ width: `${String(percent)}%` }} /></span>
                <span className="number">{String(count)}</span>
                <span className="number">{String(percent)}%</span>
              </div>;
            })}
          </div>
          <p className="muted">{labels.voterCount(closed ? vote.voterCount ?? total : total)}</p>
        </>}
      </div>

      <div className="chat-voting-configuration">
        <SegmentedControl
          label={labels.voteType}
          value={displayedPreset}
          disabled={configurationDisabled}
          onChange={(value) => setDraftPreset(value as ChatVotePreset)}
          options={[
            { value: "yes_no", label: labels.yesNo },
            { value: "scale_5", label: labels.scale },
            { value: "options_n", label: labels.options },
          ]}
        />
        <div className="chat-voting-configuration__field-slot" data-testid="chat-voting-option-count-slot" aria-hidden={displayedPreset !== "options_n"} style={{ height: "calc(var(--s10) + var(--s6))", visibility: displayedPreset === "options_n" ? "visible" : "hidden" }}>
          <NumberField
            id="chat-voting-option-count"
            label={labels.optionCount}
            value={displayedOptionCount}
            min={2}
            max={9}
            step={1}
            increaseLabel={labels.increaseOptionCount}
            decreaseLabel={labels.decreaseOptionCount}
            disabled={configurationDisabled || displayedPreset !== "options_n"}
            onChange={setDraftOptionCount}
          />
        </div>
        <SegmentedControl
          label={labels.duration}
          value={displayedDurationPreset ?? "open"}
          disabled={configurationDisabled}
          onChange={(value) => {
            durationDraftTouched.current = true;
            setDraftDurationPreset(value as DurationPreset);
          }}
          options={[
            { value: "open", label: labels.openDuration },
            { value: "one", label: labels.oneMinute },
            { value: "two", label: labels.twoMinutes },
            { value: "five", label: labels.fiveMinutes },
            { value: "custom", label: labels.customDuration },
          ]}
        />
        <div className="chat-voting-configuration__field-slot" data-testid="chat-voting-custom-duration-slot" aria-hidden={displayedDurationPreset !== "custom"} style={{ height: "calc(var(--s10) + var(--s6))", visibility: displayedDurationPreset === "custom" ? "visible" : "hidden" }}>
          <NumberField
            id="chat-voting-duration-seconds"
            label={labels.customDurationSeconds}
            value={displayedCustomDurationSeconds}
            min={1}
            max={14_400}
            step={30}
            unit="s"
            increaseLabel={labels.increaseDuration}
            decreaseLabel={labels.decreaseDuration}
            disabled={configurationDisabled || displayedDurationPreset !== "custom"}
            onChange={(value) => {
              durationDraftTouched.current = true;
              setDraftCustomDurationSeconds(value);
            }}
          />
        </div>
      </div>

      <div data-testid="chat-voting-hint-slot" style={{ height: "calc(var(--s10) + var(--s3))", overflow: "hidden" }} aria-live={!validConfiguration && !running ? "assertive" : "polite"}>
        {actionHint === null ? null : <p className={!validConfiguration && !running ? "form-error" : "lock-reason"} title={actionHint} style={{ margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{actionHint}</p>}
      </div>
      <div className="chat-voting-actions">
        {running
          ? <Button variant="primary" icon="close" disabled={busy || !canOperate} onClick={() => { void close(); }}>{labels.stop}</Button>
          : <Button variant="primary" disabled={configurationDisabled || !validConfiguration} onClick={() => { void start(); }}>{labels.start}</Button>}
      </div>
    </section>
    </LoadState>
  </section>;
};

export default ChatVotingPanel;
