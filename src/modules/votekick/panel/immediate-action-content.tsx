import { useEffect, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { Select } from "../../../dashboard/ui";
import { activeVotekickTimeouts } from "../domain/active-timeouts";
import type { Votekick } from "../contracts";
import { loadVotekickPanel } from "./service";
import { votekickImmediateActionTexts } from "./immediate-action-locale";

interface TimeoutListState {
  channelId: string;
  timeouts: readonly Votekick[] | null;
  failed: boolean;
}

interface TimeoutSelectionState {
  channelId: string;
  votekickId: string | null;
}

export default function VotekickTimeoutActionContent({ channelId, language, onReadinessChange }: ModuleImmediateActionContentProperties): ReactElement {
  const [timeoutListState, setTimeoutListState] = useState<TimeoutListState>({ channelId, timeouts: null, failed: false });
  const [selectionState, setSelectionState] = useState<TimeoutSelectionState>({ channelId, votekickId: null });

  useEffect(() => {
    const controller = new AbortController();
    void loadVotekickPanel(channelId, controller.signal).then((state) => {
      if (!controller.signal.aborted) {
        setTimeoutListState({ channelId, timeouts: activeVotekickTimeouts(state.votekicks, state.now), failed: false });
      }
    }).catch(() => {
      if (!controller.signal.aborted) setTimeoutListState({ channelId, timeouts: [], failed: true });
    });
    return () => { controller.abort(); };
  }, [channelId]);

  const timeouts = timeoutListState.channelId === channelId ? timeoutListState.timeouts : null;
  const availableTimeouts = timeouts ?? [];
  const selectedId = selectionState.channelId === channelId && availableTimeouts.some((timeout) => timeout.id === selectionState.votekickId)
    ? selectionState.votekickId
    : null;
  const ready = timeouts !== null && !timeoutListState.failed && selectedId !== null;
  const readinessReason = ready
    ? null
    : timeouts === null
      ? votekickImmediateActionTexts.loading[language]
      : timeoutListState.failed
        ? votekickImmediateActionTexts.loadFailed[language]
        : availableTimeouts.length === 0
          ? votekickImmediateActionTexts.noActiveTimeouts[language]
          : votekickImmediateActionTexts.selectionRequired[language];
  const fieldError = timeoutListState.failed
    ? votekickImmediateActionTexts.loadFailed[language]
    : timeouts !== null && availableTimeouts.length === 0
      ? votekickImmediateActionTexts.noActiveTimeouts[language]
      : undefined;

  useEffect(() => {
    onReadinessChange?.(ready, readinessReason);
  }, [onReadinessChange, readinessReason, ready]);

  return <div className="live-action-content live-action-content--votekick-lift" aria-busy={timeouts === null}>
    <Select
      label={votekickImmediateActionTexts.timeoutLabel[language]}
      name="votekickId"
      value={selectedId}
      onChange={(votekickId) => { setSelectionState({ channelId, votekickId }); }}
      options={availableTimeouts.map((timeout) => ({
        value: timeout.id,
        label: timeout.targetLogin === null ? timeout.targetUserId ?? timeout.id : `@${timeout.targetLogin}`,
        description: `${String(timeout.yesVotes)}:${String(timeout.noVotes)}`,
      }))}
      placeholder={votekickImmediateActionTexts.chooseTimeout[language]}
      hint={votekickImmediateActionTexts.chooseTimeoutHint[language]}
      dropdownBelowField
      {...(fieldError === undefined ? {} : { error: fieldError })}
      disabled={timeouts === null || timeoutListState.failed || availableTimeouts.length === 0}
      busy={timeouts === null}
      searchable
      required
    />
  </div>;
}
