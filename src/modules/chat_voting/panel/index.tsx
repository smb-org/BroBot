import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { Button, Led, NumberField, SegmentedControl } from "../../../dashboard/ui";
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preset, setPreset] = useState<ChatVotePreset>("yes_no");
  const [optionCount, setOptionCount] = useState<number | "">(2);
  const [durationPreset, setDurationPreset] = useState<DurationPreset | null>(null);
  const [customDurationSeconds, setCustomDurationSeconds] = useState<number | "">(60);
  const configurationInitialized = useRef(false);
  const durationDraftTouched = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await loadChatVotingState(channelId);
      setState(next);
      if (next.vote?.status === "open") {
        setPreset(next.vote.preset);
        setOptionCount(next.vote.optionCount);
        configurationInitialized.current = true;
      } else if (!configurationInitialized.current || !durationDraftTouched.current) {
        const defaultDurationSeconds = next.defaultDurationSeconds;
        const defaultDurationPreset = durationPresetFor(defaultDurationSeconds);
        setDurationPreset(defaultDurationPreset);
        if (defaultDurationPreset === "custom") setCustomDurationSeconds(defaultDurationSeconds);
        durationDraftTouched.current = false;
        configurationInitialized.current = true;
      }
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [channelId, setCustomDurationSeconds, setDurationPreset, setOptionCount, setPreset]);

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
    if (durationPreset === null) return;
    const durationSeconds = secondsForDurationPreset(durationPreset, customDurationSeconds);
    const validOptionCount = typeof optionCount === "number" && Number.isInteger(optionCount) && optionCount >= 2 && optionCount <= 9;
    if (durationSeconds === "" || !Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 14_400 ||
        preset === "options_n" && !validOptionCount) return;
    setBusy(true);
    setMessage(null);
    try {
      await startChatVoting(channelId, preset, preset === "options_n" ? optionCount as number : undefined, durationSeconds);
      const defaultDurationSeconds = state?.defaultDurationSeconds ?? 0;
      const defaultDurationPreset = durationPresetFor(defaultDurationSeconds);
      setDurationPreset(defaultDurationPreset);
      if (defaultDurationPreset === "custom") setCustomDurationSeconds(defaultDurationSeconds);
      durationDraftTouched.current = false;
      await refresh();
    } catch (error: unknown) {
      setMessage(error instanceof Error && "code" in error && error.code === "chat_voting_busy" ? labels.busy : labels.startError);
    } finally {
      setBusy(false);
    }
  };

  const close = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await closeChatVoting(channelId);
      await refresh();
    } catch {
      setMessage(labels.closeError);
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return <p className={loadFailed ? "form-error" : "loading-line"} role={loadFailed ? "alert" : undefined}>{loadFailed ? labels.loadError : labels.loading}</p>;
  const vote = state.vote;
  const counts = state.counts ?? vote?.counts ?? [];
  const total = counts.reduce((sum, count) => sum + count, 0);
  const running = vote?.status === "open";
  const closed = vote?.status === "closed";
  const activeBallot = running || state.hasOpenBallot;
  const configurationDisabled = busy || activeBallot || !canOperate;
  const validOptionCount = typeof optionCount === "number" && Number.isInteger(optionCount) && optionCount >= 2 && optionCount <= 9;
  const durationSeconds = durationPreset === null ? "" : secondsForDurationPreset(durationPreset, customDurationSeconds);
  const validDuration = typeof durationSeconds === "number" && Number.isSafeInteger(durationSeconds) && durationSeconds >= 0 && durationSeconds <= 14_400;
  const validConfiguration = (preset !== "options_n" || validOptionCount) && validDuration;
  const disabledReason = !canOperate ? labels.roleDisabledReason : activeBallot && !running ? labels.startDisabledReason : null;

  return <section className="module-stack chat-voting-panel" aria-label={labels.title}>
    <section className="config-section" aria-label={labels.title}>
      <div className="section-heading">
        <h2>{labels.title}</h2>
        <div className="chat-voting-panel__status">
          <Led
            status={running ? "green" : "off"}
            word={vote === null ? labels.readyStatus : running ? labels.runningStatus : labels.closedStatus}
          />
          {running ? <span className="muted">· {vote.requestedDurationSeconds === null ? labels.openStatus : labels.ends(timeText(vote.closesAt, language))}</span> : null}
        </div>
      </div>
      <div className="chat-voting-result-area" style={{ height: "calc(var(--s10) * 7)" }}>
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
          value={preset}
          disabled={configurationDisabled}
          onChange={(value) => setPreset(value as ChatVotePreset)}
          options={[
            { value: "yes_no", label: labels.yesNo },
            { value: "scale_5", label: labels.scale },
            { value: "options_n", label: labels.options },
          ]}
        />
        <div className="chat-voting-configuration__field-slot" style={{ height: "calc(var(--s10) + var(--s6))" }}>
          {preset === "options_n" ? <NumberField
            id="chat-voting-option-count"
            label={labels.optionCount}
            value={optionCount}
            min={2}
            max={9}
            step={1}
            increaseLabel={labels.increaseOptionCount}
            decreaseLabel={labels.decreaseOptionCount}
            disabled={configurationDisabled}
            onChange={setOptionCount}
          /> : null}
        </div>
        <SegmentedControl
          label={labels.duration}
          value={durationPreset ?? "open"}
          disabled={configurationDisabled}
          onChange={(value) => {
            durationDraftTouched.current = true;
            setDurationPreset(value as DurationPreset);
          }}
          options={[
            { value: "open", label: labels.openDuration },
            { value: "one", label: labels.oneMinute },
            { value: "two", label: labels.twoMinutes },
            { value: "five", label: labels.fiveMinutes },
            { value: "custom", label: labels.customDuration },
          ]}
        />
        <div className="chat-voting-configuration__field-slot" style={{ height: "calc(var(--s10) + var(--s6))" }}>
          {durationPreset === "custom" ? <NumberField
            id="chat-voting-duration-seconds"
            label={labels.customDurationSeconds}
            value={customDurationSeconds}
            min={1}
            max={14_400}
            step={30}
            unit="s"
            increaseLabel={labels.increaseDuration}
            decreaseLabel={labels.decreaseDuration}
            disabled={configurationDisabled}
            onChange={(value) => {
              durationDraftTouched.current = true;
              setCustomDurationSeconds(value);
            }}
          /> : null}
        </div>
      </div>

      {disabledReason === null ? null : <p className="lock-reason">{disabledReason}</p>}
      {preset === "options_n" && !validOptionCount ? <p className="form-error">{labels.invalidOptionCount}</p> : null}
      {!validDuration ? <p className="form-error">{labels.invalidDuration}</p> : null}
      <div className="chat-voting-actions">
        {running
          ? <Button variant="primary" icon="close" disabled={busy || !canOperate} onClick={() => { void close(); }}>{labels.stop}</Button>
          : <Button variant="primary" disabled={configurationDisabled || !validConfiguration} onClick={() => { void start(); }}>{labels.start}</Button>}
      </div>
      {message === null ? null : <p className="form-error" role="alert">{message}</p>}
    </section>
  </section>;
};

export default ChatVotingPanel;
