import { useCallback, useEffect, useState, type ReactElement } from "react";

import { Button, Field, Led, LoadState, notify, NumberField, SegmentedControl, Select, Skeleton, Switch } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { CHAT_VOTING_MAX_TEXT_TERMS, CHAT_VOTING_TITLE_MAX_LENGTH } from "../contracts";
import type { ChatVotePreset, ChatVotingTextMode } from "../contracts";
import { CHAT_VOTING_LABEL_MAX_LENGTH, isValidVoteTitle, rankVoteTerms, validateVoteLabels, voteLabelLength } from "../domain";
import { compactDateRange, dateText, timeText } from "./date-range";
import { chatVotingPanelTexts } from "./locale-panel";
import type { ChatVotingPanelState } from "./service";
import { approveChatVotingTerm, closeChatVoting, loadChatVotingState, startChatVoting } from "./service";

type DurationPreset = "open" | "one" | "two" | "five" | "custom";

const durationPresetFor = (seconds: number): DurationPreset =>
  seconds === 0 ? "open" : seconds === 60 ? "one" : seconds === 120 ? "two" : seconds === 300 ? "five" : "custom";

const secondsForDurationPreset = (preset: DurationPreset, customSeconds: number | ""): number | "" =>
  preset === "open" ? 0 : preset === "one" ? 60 : preset === "two" ? 120 : preset === "five" ? 300 : customSeconds;

const keysForPreset = (preset: ChatVotePreset, optionCount: number): string[] => {
  if (preset === "free_text") return [];
  if (preset === "digit_01") return ["0", "1"];
  if (preset === "digit_12") return ["1", "2"];
  const count = preset === "yes_no" ? 2 : preset === "scale_5" ? 5 : optionCount;
  return Array.from({ length: count }, (_unused, index) => String(index + 1));
};

interface VoteDraft {
  channelId: string;
  question: string;
  optionCount: number | "";
  answerLabels: string[];
  freeText: boolean;
  textMode: ChatVotingTextMode;
  durationPreset: DurationPreset;
  customDurationSeconds: number | "";
}

const createVoteDraft = (channelId: string, defaultDurationSeconds: number): VoteDraft => {
  const durationPreset = durationPresetFor(defaultDurationSeconds);
  return {
    channelId,
    question: "",
    optionCount: 0,
    answerLabels: [],
    freeText: false,
    textMode: "first_word",
    durationPreset,
    customDurationSeconds: durationPreset === "custom" ? defaultDurationSeconds : 60,
  };
};

export const ChatVotingPanel = ({ channelId, language = "de", canOperate = true }: ModulePanelProperties): ReactElement => {
  const labels = chatVotingPanelTexts(language);
  const [state, setState] = useState<ChatVotingPanelState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadErrorNotified, setLoadErrorNotified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draftState, setDraftState] = useState<VoteDraft | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await loadChatVotingState(channelId);
      setState(next);
      setDraftState((current) => current?.channelId === channelId
        ? current
        : createVoteDraft(channelId, next.defaultDurationSeconds));
      setLoadFailed(false);
      setLoadErrorNotified(false);
    } catch {
      setLoadFailed(true);
      if (!loadErrorNotified) {
        setLoadErrorNotified(true);
        notify({ tone: "error", message: labels.loadError });
      }
    }
  }, [channelId, labels.loadError, loadErrorNotified]);

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

  const draft = draftState?.channelId === channelId
    ? draftState
    : createVoteDraft(channelId, state?.defaultDurationSeconds ?? 0);
  const updateDraft = (update: Partial<VoteDraft>): void => {
    setDraftState((current) => ({
      ...(current?.channelId === channelId ? current : createVoteDraft(channelId, state?.defaultDurationSeconds ?? 0)),
      ...update,
    }));
  };
  const answerCount = typeof draft.optionCount === "number" ? draft.optionCount : -1;
  const validOptionCount = draft.freeText || answerCount === 0 || answerCount >= 2 && answerCount <= 9;
  const effectiveDraftLabels = answerCount >= 2 && answerCount <= 9
    ? Array.from({ length: answerCount }, (_unused, index) => draft.answerLabels[index]?.trim() || String(index + 1))
    : language === "de" ? ["Ja", "Nein"] : ["Yes", "No"];
  const validLabels = draft.freeText || answerCount === 0 || validateVoteLabels(effectiveDraftLabels, answerCount, answerCount);
  const validQuestion = isValidVoteTitle(draft.question);

  const start = async (): Promise<void> => {
    const durationSeconds = secondsForDurationPreset(draft.durationPreset, draft.customDurationSeconds);
    const minimumDurationSeconds = draft.durationPreset === "open" ? 0 : 1;
    if (durationSeconds === "" || !Number.isSafeInteger(durationSeconds) || durationSeconds < minimumDurationSeconds || durationSeconds > 14_400 ||
        !validOptionCount || !validLabels || !validQuestion) return;
    setBusy(true);
    try {
      const kind = draft.freeText ? "free_text" : answerCount === 0 ? "yes_no" : "options";
      await startChatVoting(channelId, {
        kind,
        ...(kind === "free_text" ? {} : { labels: effectiveDraftLabels }),
        ...(kind === "options" ? { optionCount: answerCount } : {}),
        durationSeconds,
        ...(draft.question.trim().length === 0 ? {} : { title: draft.question.trim() }),
        ...(draft.freeText ? { textMode: draft.textMode } : {}),
      });
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
  const durationSeconds = secondsForDurationPreset(draft.durationPreset, draft.customDurationSeconds);
  const minimumDurationSeconds = draft.durationPreset === "open" ? 0 : 1;
  const validDuration = typeof durationSeconds === "number" && Number.isSafeInteger(durationSeconds) && durationSeconds >= minimumDurationSeconds && durationSeconds <= 14_400;
  const validConfiguration = validOptionCount && validDuration && validLabels && validQuestion;
  const actionHint = !canOperate ? labels.roleDisabledReason : activeBallot ? labels.startDisabledReason
    : !validDuration ? labels.invalidDuration
      : !validOptionCount ? labels.invalidOptionCount
        : !validLabels ? labels.invalidLabels : null;
  const loadStateProps = {
    minHeight: "calc(var(--s10) * 8)",
    loading: <Skeleton rows={8} height={34} />,
    empty: <p className="empty-state">{labels.noVote}</p>,
    error: <p className="form-error" role="alert">{labels.loadError}</p>,
  } as const;
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
            <Field
              id="chat-voting-question"
              label={labels.question}
              value={draft.question}
              maxLength={CHAT_VOTING_TITLE_MAX_LENGTH}
              countLength={voteLabelLength}
              countLabel={labels.questionCount}
              disabled={configurationDisabled}
              onChange={(value) => updateDraft({ question: value })}
            />

            <Switch
              label={labels.freeText}
              hint={labels.freeTextHint}
              checked={draft.freeText}
              disabled={configurationDisabled}
              onChange={(freeText) => updateDraft({ freeText })}
            />

            {draft.freeText ? <SegmentedControl
              label={labels.textMode}
              hint={labels.freeTextHint}
              value={draft.textMode}
              disabled={configurationDisabled}
              onChange={(value) => updateDraft({ textMode: value as ChatVotingTextMode })}
              options={[
                { value: "first_word", label: labels.firstWord },
                { value: "whole_message", label: labels.wholeMessage },
              ]}
            /> : <>
              <NumberField
                id="chat-voting-option-count"
                label={labels.optionCount}
                hint={labels.optionCountHint}
                value={draft.optionCount}
                min={0}
                max={9}
                step={1}
                {...(!validOptionCount ? { error: labels.invalidOptionCount } : {})}
                increaseLabel={labels.increaseOptionCount}
                decreaseLabel={labels.decreaseOptionCount}
                disabled={configurationDisabled}
                onChange={(optionCount) => updateDraft({
                  optionCount,
                  answerLabels: typeof optionCount === "number"
                    ? Array.from({ length: optionCount }, (_unused, index) => draft.answerLabels[index] ?? "")
                    : draft.answerLabels,
                })}
              />
              {answerCount === 0 ? <p className="muted">{labels.yesNoDefaultHint}</p> : null}
              {answerCount > 0 && answerCount <= 9 ? <div className="chat-voting-labels-group">
                <h3>{labels.labelsHeading}</h3>
                <div className="chat-voting-labels chat-voting-labels--options">
                  {Array.from({ length: answerCount }, (_unused, index) => {
                    const answerNumber = String(index + 1);
                    const fieldLabel = labels.labelFieldName(answerNumber);
                    return <Field
                      key={`answer-${answerNumber}`}
                      id={`chat-voting-label-${answerNumber}`}
                      label={fieldLabel}
                      ariaLabel={fieldLabel}
                      labelHidden
                      leftLabel={answerNumber}
                      value={draft.answerLabels[index] ?? ""}
                      placeholder={answerNumber}
                      maxLength={CHAT_VOTING_LABEL_MAX_LENGTH}
                      countLabel={labels.labelCount}
                      countLength={voteLabelLength}
                      disabled={configurationDisabled}
                      onChange={(value) => {
                        const answerLabels = [...draft.answerLabels];
                        answerLabels[index] = value;
                        updateDraft({ answerLabels });
                      }}
                    />;
                  })}
                </div>
              </div> : null}
            </>}

            <div className={`chat-voting-duration-row${draft.durationPreset === "custom" ? " chat-voting-duration-row--custom" : ""}`}>
              <Select
                id="chat-voting-duration"
                label={labels.duration}
                value={draft.durationPreset}
                {...(draft.durationPreset === "open" ? { hint: labels.openDurationHint } : {})}
                disabled={configurationDisabled}
                onChange={(value) => {
                  if (value === null) return;
                  updateDraft({ durationPreset: value as DurationPreset });
                }}
                options={[
                  { value: "open", label: labels.openDuration },
                  { value: "one", label: labels.oneMinute },
                  { value: "two", label: labels.twoMinutes },
                  { value: "five", label: labels.fiveMinutes },
                  { value: "custom", label: labels.customDuration },
                ]}
              />
              {draft.durationPreset === "custom" ? <NumberField
                id="chat-voting-duration-seconds"
                label={labels.customDurationSeconds}
                hint={labels.durationRange}
                value={draft.customDurationSeconds}
                min={1}
                max={14_400}
                step={30}
                unit="s"
                {...(!running && !validDuration ? { error: labels.invalidDuration } : {})}
                increaseLabel={labels.increaseDuration}
                decreaseLabel={labels.decreaseDuration}
                disabled={configurationDisabled}
                onChange={(value) => {
                  updateDraft({ customDurationSeconds: value });
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
