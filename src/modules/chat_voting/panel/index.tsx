import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { Button, Field, Led, LoadState, notify, NumberField, SegmentedControl, Select, Skeleton } from "../../../dashboard/ui";
import type { SelectOption } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { CHAT_VOTING_MAX_TEXT_TERMS, CHAT_VOTING_PRESETS, CHAT_VOTING_TITLE_MAX_LENGTH } from "../contracts";
import type { ChatVotePreset, ChatVotingTextMode } from "../contracts";
import { CHAT_VOTING_LABEL_MAX_LENGTH, isValidVoteLabel, isValidVoteTitle, rankVoteTerms, voteLabelLength } from "../domain";
import { compactDateRange, dateText, timeText } from "./date-range";
import { chatVotingPanelTexts } from "./locale-panel";
import type { ChatVotingPanelState } from "./service";
import { approveChatVotingTerm, closeChatVoting, loadChatVotingState, startChatVoting } from "./service";

type DurationPreset = "open" | "one" | "two" | "five" | "custom";

const durationPresetFor = (seconds: number): DurationPreset =>
  seconds === 0 ? "open" : seconds === 60 ? "one" : seconds === 120 ? "two" : seconds === 300 ? "five" : "custom";

const secondsForDurationPreset = (preset: DurationPreset, customSeconds: number | ""): number | "" =>
  preset === "open" ? 0 : preset === "one" ? 60 : preset === "two" ? 120 : preset === "five" ? 300 : customSeconds;

const emptyPresetRecord = <Value,>(value: Value): Record<ChatVotePreset, Value> => ({
  yes_no: value,
  digit_01: value,
  digit_12: value,
  scale_5: value,
  options_n: value,
  free_text: value,
});

const emptyLabels = (): Record<ChatVotePreset, string[]> => emptyPresetRecord([]);
const emptyTouched = (): Record<ChatVotePreset, boolean> => emptyPresetRecord(false);

const copyDefaultLabels = (defaults: Record<ChatVotePreset, string[]>): Record<ChatVotePreset, string[]> => ({
  yes_no: [...defaults.yes_no],
  digit_01: [...defaults.digit_01],
  digit_12: [...defaults.digit_12],
  scale_5: [...defaults.scale_5],
  options_n: [...defaults.options_n],
  free_text: [...defaults.free_text],
});

const keysForPreset = (preset: ChatVotePreset, optionCount: number): string[] => {
  if (preset === "free_text") return [];
  if (preset === "digit_01") return ["0", "1"];
  if (preset === "digit_12") return ["1", "2"];
  const count = preset === "yes_no" ? 2 : preset === "scale_5" ? 5 : optionCount;
  return Array.from({ length: count }, (_unused, index) => String(index + 1));
};

const presetOptions = (texts: ReturnType<typeof chatVotingPanelTexts>): SelectOption[] => [
  { value: "yes_no", label: texts.yesNo, group: texts.presetGroups.twoOptions, description: texts.presetDescriptions.yes_no },
  { value: "digit_01", label: texts.zeroOne, group: texts.presetGroups.twoOptions, description: texts.presetDescriptions.digit_01 },
  { value: "digit_12", label: texts.oneTwo, group: texts.presetGroups.twoOptions, description: texts.presetDescriptions.digit_12 },
  { value: "scale_5", label: texts.scale, group: texts.presetGroups.scale, description: texts.presetDescriptions.scale_5 },
  { value: "options_n", label: texts.options, group: texts.presetGroups.multipleOptions, description: texts.presetDescriptions.options_n },
  { value: "free_text", label: texts.freeText, group: texts.presetGroups.freeText, description: texts.presetDescriptions.free_text },
];

export const ChatVotingPanel = ({ channelId, language = "de", canOperate = true }: ModulePanelProperties): ReactElement => {
  const labels = chatVotingPanelTexts(language);
  const [state, setState] = useState<ChatVotingPanelState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadErrorNotified = useRef(false);
  const [busy, setBusy] = useState(false);
  const [draftPreset, setDraftPreset] = useState<ChatVotePreset>("yes_no");
  const [draftOptionCount, setDraftOptionCount] = useState<number | "">(2);
  const [draftTextMode, setDraftTextMode] = useState<ChatVotingTextMode>("first_word");
  const [draftQuestion, setDraftQuestion] = useState("");
  const [draftLabels, setDraftLabels] = useState<Record<ChatVotePreset, string[]>>(emptyLabels);
  const [draftDurationPreset, setDraftDurationPreset] = useState<DurationPreset | null>(null);
  const [draftCustomDurationSeconds, setDraftCustomDurationSeconds] = useState<number | "">(60);
  const configurationInitialized = useRef(false);
  const durationDraftTouched = useRef(false);
  const labelDraftTouched = useRef<Record<ChatVotePreset, boolean>>(emptyTouched());
  const lastVote = useRef<ChatVotingPanelState["vote"]>(null);
  const initializedChannel = useRef(channelId);

  const refresh = useCallback(async (): Promise<void> => {
    if (initializedChannel.current !== channelId) {
      initializedChannel.current = channelId;
      configurationInitialized.current = false;
      durationDraftTouched.current = false;
      labelDraftTouched.current = emptyTouched();
      lastVote.current = null;
      setDraftLabels(emptyLabels());
      setDraftQuestion("");
    }
    try {
      const next = await loadChatVotingState(channelId);
      const closedSinceLastRead = next.vote?.status === "closed" && lastVote.current?.id === next.vote.id && lastVote.current.status === "open";
      const justClosedVote = closedSinceLastRead ? next.vote : null;
      if (justClosedVote !== null) {
        labelDraftTouched.current = emptyTouched();
        labelDraftTouched.current[justClosedVote.preset] = true;
        setDraftQuestion(justClosedVote.title ?? "");
      }
      if (!configurationInitialized.current && next.vote?.status === "closed") {
        setDraftQuestion(next.vote.title ?? "");
      }
      const defaults = next.defaultLabels;
      setDraftLabels((current) => {
        const updated = { ...current };
        for (const preset of CHAT_VOTING_PRESETS) {
          if (!labelDraftTouched.current[preset]) updated[preset] = [...defaults[preset]];
        }
        if (justClosedVote !== null) updated[justClosedVote.preset] = [...justClosedVote.labels];
        return updated;
      });
      setState(next);
      lastVote.current = next.vote;
      if (justClosedVote !== null) {
        setDraftPreset(justClosedVote.preset);
        setDraftOptionCount(justClosedVote.optionCount);
        setDraftTextMode(justClosedVote.textMode ?? "first_word");
        const voteDurationPreset = durationPresetFor(justClosedVote.requestedDurationSeconds ?? 0);
        setDraftDurationPreset(voteDurationPreset);
        if (voteDurationPreset === "custom") setDraftCustomDurationSeconds(justClosedVote.requestedDurationSeconds ?? "");
        durationDraftTouched.current = true;
        configurationInitialized.current = true;
      } else if (!configurationInitialized.current || next.vote?.status !== "open" && !durationDraftTouched.current) {
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
  }, [channelId, labels.loadError]);

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

  const selectedCount = draftPreset === "options_n" && typeof draftOptionCount === "number" ? draftOptionCount : 2;
  const labelKeys = keysForPreset(draftPreset, selectedCount);
  const selectedDefaults = state?.defaultLabels[draftPreset] ?? [];
  const effectiveDraftLabels = labelKeys.map((key, index) => {
    const entered = draftLabels[draftPreset][index]?.trim() ?? "";
    return entered || selectedDefaults[index] || key;
  });
  const validLabels = effectiveDraftLabels.every(isValidVoteLabel);
  const validQuestion = isValidVoteTitle(draftQuestion);

  const start = async (): Promise<void> => {
    if (draftDurationPreset === null) return;
    const durationSeconds = secondsForDurationPreset(draftDurationPreset, draftCustomDurationSeconds);
    const validOptionCount = typeof draftOptionCount === "number" && Number.isInteger(draftOptionCount) && draftOptionCount >= 2 && draftOptionCount <= 9;
    const minimumDurationSeconds = draftDurationPreset === "open" ? 0 : 1;
    if (durationSeconds === "" || !Number.isSafeInteger(durationSeconds) || durationSeconds < minimumDurationSeconds || durationSeconds > 14_400 ||
        draftPreset === "options_n" && !validOptionCount || !validLabels || !validQuestion) return;
    setBusy(true);
    try {
      await startChatVoting(channelId, {
        preset: draftPreset,
        ...(draftPreset === "options_n" ? { optionCount: draftOptionCount as number } : {}),
        durationSeconds,
        ...(draftQuestion.trim().length === 0 ? {} : { title: draftQuestion.trim() }),
        ...(draftPreset === "free_text" ? { textMode: draftTextMode } : {}),
        ...(draftPreset === "free_text" ? {} : { labels: effectiveDraftLabels }),
      });
      durationDraftTouched.current = false;
      labelDraftTouched.current = emptyTouched();
      if (state !== null) setDraftLabels(copyDefaultLabels(state.defaultLabels));
      const defaultDurationSeconds = state?.defaultDurationSeconds ?? 0;
      const defaultDurationPreset = durationPresetFor(defaultDurationSeconds);
      setDraftDurationPreset(defaultDurationPreset);
      if (defaultDurationPreset === "custom") setDraftCustomDurationSeconds(defaultDurationSeconds);
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

  const approveTerm = async (pollId: string, term: string): Promise<void> => {
    setBusy(true);
    try {
      await approveChatVotingTerm(channelId, pollId, term);
      notify({ tone: "success", message: labels.approvalSaved });
      await refresh();
    } catch (error: unknown) {
      const unavailable = error instanceof Error && "code" in error && error.code === "chat_voting_blocked_terms_unavailable";
      notify({ tone: "error", message: unavailable ? labels.termsUnavailable : labels.approvalFailed });
    } finally {
      setBusy(false);
    }
  };

  if (state === null) return <section className="module-stack chat-voting-panel" aria-label={labels.title}>
    <LoadState
      status={loadFailed ? "error" : "loading"}
      minHeight="calc(var(--s10) * 8)"
      loading={<Skeleton rows={8} height={34} />}
      empty={<p className="empty-state">{labels.noVote}</p>}
      error={<div />}
    >{null}</LoadState>
  </section>;

  const vote = state.vote;
  const running = vote?.status === "open";
  const closed = vote?.status === "closed";
  const counts = state.counts ?? vote?.counts ?? [];
  const total = counts.reduce((sum, count) => sum + count, 0);
  const terms = state.terms ?? vote?.textResults ?? [];
  const textTotal = terms.reduce((sum, entry) => sum + entry.count, 0);
  const moreTerms = state.moreTerms ?? vote?.moreTerms ?? 0;
  const activeBallot = running || state.hasOpenBallot;
  const configurationDisabled = busy || activeBallot || !canOperate;
  const displayedPreset = running ? vote.preset : draftPreset;
  const displayedOptionCount = running ? vote.optionCount : draftOptionCount;
  const displayedTextMode = running ? vote.textMode ?? "first_word" : draftTextMode;
  const displayedDurationPreset = running
    ? durationPresetFor(vote.requestedDurationSeconds ?? 0)
    : draftDurationPreset;
  const displayedCustomDurationSeconds = running && displayedDurationPreset === "custom"
    ? vote.requestedDurationSeconds ?? ""
    : draftCustomDurationSeconds;
  const validOptionCount = typeof draftOptionCount === "number" && Number.isInteger(draftOptionCount) && draftOptionCount >= 2 && draftOptionCount <= 9;
  const durationSeconds = draftDurationPreset === null ? "" : secondsForDurationPreset(draftDurationPreset, draftCustomDurationSeconds);
  const minimumDurationSeconds = draftDurationPreset === "open" ? 0 : 1;
  const validDuration = typeof durationSeconds === "number" && Number.isSafeInteger(durationSeconds) && durationSeconds >= minimumDurationSeconds && durationSeconds <= 14_400;
  const validConfiguration = (draftPreset !== "options_n" || validOptionCount) && validDuration && validLabels && validQuestion;
  const actionHint = !canOperate ? labels.roleDisabledReason : activeBallot ? labels.startDisabledReason
    : !validDuration ? labels.invalidDuration
      : draftPreset === "options_n" && !validOptionCount ? labels.invalidOptionCount : null;
  const loadStateProps = {
    minHeight: "calc(var(--s10) * 8)",
    loading: <Skeleton rows={8} height={34} />,
    empty: <p className="empty-state">{labels.noVote}</p>,
    error: <p className="form-error" role="alert">{labels.loadError}</p>,
  } as const;
  const displayedLabelKeys = keysForPreset(displayedPreset, typeof displayedOptionCount === "number" ? displayedOptionCount : 2);
  const displayedQuestion = running ? vote.title ?? "" : draftQuestion;
  const displayedLabels = running ? vote.labels : draftLabels[displayedPreset];
  const displayedDefaults = state.defaultLabels[displayedPreset];
  const resultCount = vote === null ? 0 : closed ? vote.voterCount ?? (vote.preset === "free_text" ? textTotal : total)
    : vote.preset === "free_text" ? textTotal : total;
  const resultRange = closed ? compactDateRange(vote.openedAt, vote.closedAt ?? vote.closesAt, language, labels.nextDay) : null;
  const resultFrom = vote === null ? "" : resultRange?.[0] ?? dateText(vote.openedAt, language);
  const resultTo = closed ? resultRange?.[1] ?? dateText(vote.closedAt ?? vote.closesAt, language) : null;
  const resultMetadata = vote === null ? null : labels.resultMeta(resultCount, resultFrom, resultTo, vote.preset === "free_text" ? moreTerms : undefined);
  const leaderIndex = total === 0 ? -1 : counts.findIndex((count) => count === Math.max(...counts));
  const rankedTerms = rankVoteTerms(terms, CHAT_VOTING_MAX_TEXT_TERMS);
  const termLeader = rankedTerms[0];
  const headerStatus = vote === null ? labels.readyStatus : running ? labels.runningStatus : labels.closedStatus;

  return <section className="module-stack chat-voting-panel" aria-label={labels.title}>
    <LoadState status="success" {...loadStateProps}>
      <section className="config-section" aria-label={labels.title}>
        <div className="section-heading">
          <h2>{labels.title}</h2>
          <div className="chat-voting-panel__status" data-testid="chat-voting-header-status">
            <Led status={running ? "green" : "off"} word={headerStatus} />
            <span className="muted chat-voting-panel__status-detail" data-testid="chat-voting-header-detail"
              aria-hidden={!running}
              title={running ? vote.requestedDurationSeconds === null ? labels.openStatus : labels.ends(timeText(vote.closesAt, language)) : ""}>
              {running ? `· ${vote.requestedDurationSeconds === null ? labels.openStatus : labels.ends(timeText(vote.closesAt, language))}` : ""}
            </span>
          </div>
        </div>

        <div className="chat-voting-panel__body">
          <div className="chat-voting-setup">
            <h3 className="chat-voting-column-heading">{labels.newVote}</h3>
            <div className="chat-voting-type-question-row">
              <Select
                id="chat-voting-preset"
                label={labels.voteType}
                value={displayedPreset}
                hint={labels.presetHints[displayedPreset]}
                disabled={configurationDisabled}
                onChange={(value) => { if (value !== null) setDraftPreset(value as ChatVotePreset); }}
                options={presetOptions(labels)}
              />
              <Field
                id="chat-voting-question"
                label={labels.question}
                value={displayedQuestion}
                maxLength={CHAT_VOTING_TITLE_MAX_LENGTH}
                countLength={voteLabelLength}
                countLabel={labels.questionCount}
                disabled={configurationDisabled}
                onChange={(value) => {
                  setDraftQuestion(value);
                }}
              />
            </div>

            {displayedPreset === "options_n" ? <NumberField
              id="chat-voting-option-count"
              label={labels.optionCount}
              hint={labels.optionCountHint}
              value={displayedOptionCount}
              min={2}
              max={9}
              step={1}
              {...(!running && !validOptionCount ? { error: labels.invalidOptionCount } : {})}
              increaseLabel={labels.increaseOptionCount}
              decreaseLabel={labels.decreaseOptionCount}
              disabled={configurationDisabled}
              onChange={setDraftOptionCount}
            /> : null}

            {displayedPreset === "free_text" ? <SegmentedControl
              label={labels.textMode}
              hint={labels.freeTextHint}
              value={displayedTextMode}
              disabled={configurationDisabled}
              onChange={(value) => setDraftTextMode(value as ChatVotingTextMode)}
              options={[
                { value: "first_word", label: labels.firstWord },
                { value: "whole_message", label: labels.wholeMessage },
              ]}
            /> : <div className="chat-voting-labels-group">
              <h3>{labels.labelsHeading}</h3>
              <div className={`chat-voting-labels${displayedPreset === "scale_5" ? " chat-voting-labels--scale" : displayedPreset === "options_n" ? " chat-voting-labels--options" : ""}`}>
                {displayedLabelKeys.map((key, index) => <Field
                  key={`${displayedPreset}-${key}`}
                  id={`chat-voting-label-${displayedPreset}-${key}`}
                  label={labels.labelFieldName(key)}
                  ariaLabel={labels.labelFieldName(key)}
                  labelHidden
                  leftLabel={key}
                  value={displayedLabels[index] ?? ""}
                  placeholder={displayedDefaults[index] ?? key}
                  maxLength={CHAT_VOTING_LABEL_MAX_LENGTH}
                  countLabel={labels.labelCount}
                  countLength={voteLabelLength}
                  disabled={configurationDisabled}
                  onChange={(value) => {
                    labelDraftTouched.current[draftPreset] = true;
                    setDraftLabels((current) => {
                      const next = [...current[draftPreset]];
                      next[index] = value;
                      return { ...current, [draftPreset]: next };
                    });
                  }}
                />)}
              </div>
            </div>}

            <div className={`chat-voting-duration-row${displayedDurationPreset === "custom" ? " chat-voting-duration-row--custom" : ""}`}>
              <Select
                id="chat-voting-duration"
                label={labels.duration}
                value={displayedDurationPreset ?? "open"}
                {...(displayedDurationPreset === "open" ? { hint: labels.openDurationHint } : {})}
                disabled={configurationDisabled}
                onChange={(value) => {
                  if (value === null) return;
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
              {displayedDurationPreset === "custom" ? <NumberField
                id="chat-voting-duration-seconds"
                label={labels.customDurationSeconds}
                hint={labels.durationRange}
                value={displayedCustomDurationSeconds}
                min={1}
                max={14_400}
                step={30}
                unit="s"
                {...(!running && !validDuration ? { error: labels.invalidDuration } : {})}
                increaseLabel={labels.increaseDuration}
                decreaseLabel={labels.decreaseDuration}
                disabled={configurationDisabled}
                onChange={(value) => {
                  durationDraftTouched.current = true;
                  setDraftCustomDurationSeconds(value);
                }}
              /> : null}
            </div>

            <Button
              className="chat-voting-action"
              variant="primary"
              danger={running}
              {...(running ? { icon: "close" as const } : {})}
              disabled={running ? busy || !canOperate : configurationDisabled || !validConfiguration}
              onClick={() => { void (running ? close() : start()); }}>
              {running ? labels.stop : labels.start}
            </Button>
            <p className="chat-voting-hint" data-testid="chat-voting-hint-slot" title={actionHint ?? ""} aria-live="polite">{actionHint}</p>
          </div>

          <div className="chat-voting-result">
            <div className="chat-voting-result__heading">
              <h3>{labels.result}</h3>
              {resultMetadata === null ? null : <span className="number chat-voting-result__meta" title={resultMetadata}>{resultMetadata}</span>}
            </div>
            <p className="chat-voting-result__question" title={vote?.title ?? ""} aria-hidden={vote?.title == null || vote.title.length === 0}>
              {vote?.title ?? ""}
            </p>
            {vote === null ? <p className="empty-state chat-voting-result__empty">{labels.noVote}</p>
              : vote.preset === "free_text" ? <div className="chat-voting-results" aria-label={labels.results}>
                {Array.from({ length: 5 }, (_unused, index) => {
                  const entry = rankedTerms[index];
                  if (entry === undefined) return <div className="chat-voting-results__row chat-voting-results__term-row chat-voting-results__empty-slot" key={`${vote.id}-empty-${String(index)}`} role="group" aria-label={labels.emptySlot}>
                    <span className="chat-voting-results__label">{labels.emptySlot}</span>
                    <span className="chat-voting-results__track" aria-hidden="true"><span /></span>
                    <span className="number">{labels.emptySlot}</span>
                    <span className="number">{labels.emptySlot}</span>
                    <span className="chat-voting-results__approval" aria-hidden="true" />
                  </div>;
                  const percent = textTotal === 0 ? 0 : Math.round(entry.count * 100 / textTotal);
                  const leading = entry.term === termLeader?.term;
                  return <div className="chat-voting-results__row chat-voting-results__term-row" data-leading={leading || undefined} key={`${vote.id}-${entry.term}`} role="group" aria-label={labels.resultBar(entry.term, entry.count, percent)}>
                    <span className="chat-voting-results__label" title={entry.term}>{entry.term}</span>
                    <span className="chat-voting-results__track" aria-hidden="true"><span style={{ width: `${String(percent)}%` }} /></span>
                    <span className="number">{String(entry.count)}</span>
                    <span className="number">{String(percent)}%</span>
                    <span className="chat-voting-results__approval">
                      {entry.approved
                        ? <span className="muted" title={labels.approved}>{labels.approvedShort}</span>
                        : <Button size="compact" disabled={busy || !canOperate || !running} ariaLabel={labels.approveTerm(entry.term)} title={labels.approveTerm(entry.term)} onClick={() => { void approveTerm(vote.id, entry.term); }}>{labels.approve}</Button>}
                    </span>
                  </div>;
                })}
              </div> : <div className="chat-voting-results" aria-label={labels.results}>
                {vote.labels.map((label, index) => {
                  const count = counts[index] ?? 0;
                  const percent = total === 0 ? 0 : Math.round(count * 100 / total);
                  return <div className="chat-voting-results__row" data-leading={index === leaderIndex || undefined} key={`${vote.id}-${String(index)}`} role="group" aria-label={labels.resultBar(label, count, percent)}>
                    <span className="number chat-voting-results__key">{keysForPreset(vote.preset, vote.optionCount)[index] ?? String(index + 1)}</span>
                    <span className="chat-voting-results__label">{label}</span>
                    <span className="chat-voting-results__track" aria-hidden="true"><span style={{ width: `${String(percent)}%` }} /></span>
                    <span className="number">{String(count)}</span>
                    <span className="number">{String(percent)}%</span>
                  </div>;
                })}
              </div>}
          </div>
        </div>
      </section>
    </LoadState>
  </section>;
};

export default ChatVotingPanel;
