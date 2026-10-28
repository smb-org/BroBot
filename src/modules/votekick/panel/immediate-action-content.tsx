import { useEffect, useMemo, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { useModuleQuery } from "../../../dashboard/data";
import { useDashboardRealtimeStatus } from "../../../dashboard/data/realtime";
import { Select } from "../../../dashboard/ui";
import { activeVotekickTimeouts } from "../domain/active-timeouts";
import { loadVotekickPanel } from "./service";
import { votekickImmediateActionTexts } from "./immediate-action-locale";

interface TimeoutSelectionState {
  channelId: string;
  votekickId: string | null;
}

export default function VotekickTimeoutActionContent({ channelId, language, onReadinessChange }: ModuleImmediateActionContentProperties): ReactElement {
  // Shares the revision-backed panel query with the lock card, cockpit tile and availability check.
  const realtimeStatus = useDashboardRealtimeStatus(channelId);
  const query = useModuleQuery(channelId, "votekick", "panel", (signal) => loadVotekickPanel(channelId, signal), {
    refetchInterval: realtimeStatus === "connected" ? false : 5_000,
  });
  const [selectionState, setSelectionState] = useState<TimeoutSelectionState>({ channelId, votekickId: null });
  const [localNow, setLocalNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => { setLocalNow(Date.now()); }, 1_000);
    return () => { window.clearInterval(interval); };
  }, []);

  const serverNow = query.data === undefined
    ? null
    : (() => {
      const capturedAt = Date.parse(query.data.now);
      return Number.isFinite(capturedAt)
        ? new Date(capturedAt + Math.max(0, localNow - query.dataUpdatedAt)).toISOString()
        : query.data.now;
    })();

  const timeouts = useMemo(
    () => query.data === undefined || serverNow === null ? null : activeVotekickTimeouts(query.data.votekicks, serverNow),
    [query.data, serverNow],
  );
  const failed = query.isError && timeouts === null;
  const availableTimeouts = timeouts ?? [];
  // A selection that left the list (lifted elsewhere, expired) is dropped here.
  const selectedId = selectionState.channelId === channelId && availableTimeouts.some((timeout) => timeout.id === selectionState.votekickId)
    ? selectionState.votekickId
    : null;
  const ready = timeouts !== null && selectedId !== null;
  const readinessReason = ready
    ? null
    : failed
      ? votekickImmediateActionTexts.loadFailed[language]
      : timeouts === null
        ? votekickImmediateActionTexts.loading[language]
        : availableTimeouts.length === 0
          ? votekickImmediateActionTexts.noActiveTimeouts[language]
          : votekickImmediateActionTexts.selectionRequired[language];
  const fieldError = failed
    ? votekickImmediateActionTexts.loadFailed[language]
    : timeouts !== null && availableTimeouts.length === 0
      ? votekickImmediateActionTexts.noActiveTimeouts[language]
      : undefined;

  useEffect(() => {
    onReadinessChange?.(ready, readinessReason);
  }, [onReadinessChange, readinessReason, ready]);

  return <div className="live-action-content live-action-content--votekick-lift" aria-busy={timeouts === null && !failed}>
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
      disabled={timeouts === null || availableTimeouts.length === 0}
      busy={timeouts === null && !failed}
      searchable
      required
    />
  </div>;
}
