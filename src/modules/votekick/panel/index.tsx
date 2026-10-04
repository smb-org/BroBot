import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import { Badge, Button, ConfirmDialog, InspectorSection } from "../../../dashboard/ui";
import { dashboardLanguage } from "../../../dashboard/locale";
import type { ModulePanelProperties } from "../../contract";
import type { Votekick } from "../contracts";
import { remainingVotekickSeconds } from "../domain";
import { cancelVotekick, liftVotekickTimeout, loadVotekickPanel, type VotekickPanelData } from "./service";
import { votekickPanelTexts } from "./locale";

const formatTime = (value: string, language: "de" | "en"): string => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", { dateStyle: "short", timeStyle: "short" }).format(date)
    : value;
};

export default function VotekickPanel({ channelId, language, canOperate = true }: ModulePanelProperties): ReactElement {
  const resolvedLanguage = language ?? dashboardLanguage();
  const labels = useMemo(() => votekickPanelTexts(resolvedLanguage), [resolvedLanguage]);
  const [data, setData] = useState<VotekickPanelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Votekick | null>(null);
  const [liftTarget, setLiftTarget] = useState<Votekick | null>(null);
  const [now, setNow] = useState(0);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    try {
      setData(await loadVotekickPanel(channelId));
      setError(null);
    } catch {
      setError(labels.loadError);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [channelId, labels.loadError]);

  useEffect(() => {
    let active = true;
    void loadVotekickPanel(channelId)
      .then((value) => { if (active) setData(value); })
      .catch(() => { if (active) setError(labels.loadError); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [channelId, labels.loadError]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const runningId = data?.running?.id ?? null;
  useEffect(() => {
    if (runningId === null) return;
    const timer = window.setInterval(() => { void reload(true); }, 2000);
    return () => window.clearInterval(timer);
  }, [runningId, reload]);

  const cancel = async (): Promise<void> => {
    if (cancelTarget === null) return;
    setBusy(true);
    try {
      await cancelVotekick(channelId, cancelTarget.id);
      setCancelTarget(null);
      await reload(true);
    } catch {
      setError(labels.actionError);
    } finally {
      setBusy(false);
    }
  };

  const lift = async (): Promise<void> => {
    if (liftTarget === null) return;
    setBusy(true);
    try {
      await liftVotekickTimeout(channelId, liftTarget.id);
      setLiftTarget(null);
      await reload(true);
    } catch {
      setError(labels.actionError);
    } finally {
      setBusy(false);
    }
  };

  const running = data?.running ?? null;
  const currentTime = now === 0 ? Date.parse(data?.now ?? "") : now;
  const history = data?.votekicks.filter((item) => item.status !== "running") ?? [];
  return <section className="module-stack" aria-label={labels.ariaLabel}>
    <InspectorSection title={labels.running}>
      {loading ? <p className="muted">…</p> : running === null
        ? <p className="muted">{labels.emptyRunning}</p>
        : <article className="timer-row">
            <div className="timer-row__copy">
              <strong>{labels.target} · <code>{running.targetLogin ?? running.targetUserId ?? "—"}</code></strong>
              <span>{labels.votes(running.yesVotes, running.noVotes, running.threshold)}</span>
              <span>{labels.remaining(remainingVotekickSeconds(running.endsAt, currentTime))}</span>
            </div>
            <div className="timer-row__actions">
              <Button variant="subtle" danger disabled={!canOperate || busy} onClick={() => setCancelTarget(running)}>{labels.cancel}</Button>
            </div>
          </article>}
    </InspectorSection>

    <InspectorSection title={labels.history}>
      {loading ? <p className="muted">…</p> : history.length === 0 ? <p className="muted">{labels.emptyHistory}</p> : (
        <div className="state-list">
          {history.map((item) => (
            <article key={item.id} className="timer-row">
              <div className="timer-row__copy">
                <strong>{labels.target} · <code>{item.targetLogin ?? item.targetUserId ?? "—"}</code></strong>
                <span><Badge tone={item.status === "passed" ? "brand" : "neutral"}>{labels.status[item.status]}</Badge> · {formatTime(item.startedAt, resolvedLanguage)}</span>
                <span>{labels.votes(item.yesVotes, item.noVotes, item.threshold)} · {labels.duration(item.durationSeconds)}</span>
              </div>
              <div className="timer-row__actions">
                {item.status === "passed" && item.targetUserId !== null && item.liftedAt === null &&
                  item.endedAt !== null && item.durationSeconds !== null &&
                  Number.isFinite(Date.parse(item.endedAt)) &&
                  Date.parse(item.endedAt) + item.durationSeconds * 1000 > currentTime
                  ? <Button variant="neutral" disabled={!canOperate || busy} onClick={() => setLiftTarget(item)}>{labels.lift}</Button>
                  : item.liftedAt === null ? null : <span role="status">{labels.lifted}</span>}
              </div>
            </article>
          ))}
        </div>
      )}
    </InspectorSection>
    {error === null ? null : <p className="form-error" role="alert">{error}</p>}

    <ConfirmDialog
      opened={cancelTarget !== null}
      title={labels.cancelTitle}
      description={labels.cancelDescription}
      confirmLabel={labels.confirmCancel}
      cancelLabel={labels.cancelDialogCancel}
      onConfirm={() => { void cancel(); }}
      onCancel={() => setCancelTarget(null)}
      pending={busy}
      danger
      {...(error === null ? {} : { error })}
    />
    <ConfirmDialog
      opened={liftTarget !== null}
      title={labels.liftTitle}
      description={labels.liftDescription}
      confirmLabel={labels.confirmLift}
      cancelLabel={labels.liftDialogCancel}
      onConfirm={() => { void lift(); }}
      onCancel={() => setLiftTarget(null)}
      pending={busy}
      danger
      {...(error === null ? {} : { error })}
    />
  </section>;
}
