import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { Badge, Button, ConfirmDialog, InspectorSection, LoadState, Skeleton, notify } from "../../../dashboard/ui";
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
  const [dialogError, setDialogError] = useState<string | undefined>();
  const loadErrorNotified = useRef(false);
  const [cancelTarget, setCancelTarget] = useState<Votekick | null>(null);
  const [liftTarget, setLiftTarget] = useState<Votekick | null>(null);
  const [now, setNow] = useState(0);

  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    try {
      setData(await loadVotekickPanel(channelId));
      loadErrorNotified.current = false;
    } catch {
      if (!loadErrorNotified.current) {
        loadErrorNotified.current = true;
        notify({ tone: "error", message: labels.loadError });
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [channelId, labels.loadError]);

  useEffect(() => {
    let active = true;
    loadErrorNotified.current = false;
    void loadVotekickPanel(channelId)
      .then((value) => { if (active) { setData(value); loadErrorNotified.current = false; } })
      .catch(() => {
        if (active && !loadErrorNotified.current) {
          loadErrorNotified.current = true;
          notify({ tone: "error", message: labels.loadError });
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [channelId, labels.loadError]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { void reload(true); }, 2000);
    return () => window.clearInterval(timer);
  }, [reload]);

  const cancel = async (): Promise<void> => {
    if (cancelTarget === null) return;
    setBusy(true);
    setDialogError(undefined);
    try {
      await cancelVotekick(channelId, cancelTarget.id);
      setCancelTarget(null);
      await reload(true);
    } catch {
      setDialogError(labels.actionError);
    } finally {
      setBusy(false);
    }
  };

  const lift = async (): Promise<void> => {
    if (liftTarget === null) return;
    setBusy(true);
    setDialogError(undefined);
    try {
      await liftVotekickTimeout(channelId, liftTarget.id);
      setLiftTarget(null);
      await reload(true);
    } catch {
      setDialogError(labels.actionError);
    } finally {
      setBusy(false);
    }
  };

  const running = data?.running ?? null;
  const currentTime = now === 0 ? Date.parse(data?.now ?? "") : now;
  const history = data?.votekicks.filter((item) => item.status !== "running") ?? [];
  return <section className="module-stack" aria-label={labels.ariaLabel}>
    <LoadState status={loading ? "loading" : data === null ? "error" : "success"}
      minHeight="calc(var(--s10) * 30)"
      loading={<div className="module-stack" aria-label={labels.ariaLabel}>
        <Skeleton rows={4} height={34} /><Skeleton rows={8} height={34} />
      </div>}
      empty={<div />}
      error={<div style={{ minHeight: "calc(var(--s10) * 30)" }} />}
    >
    {data === null ? null : <>
    <InspectorSection title={labels.running}>
      <div data-testid="votekick-running-slot" style={{ height: "calc(var(--s10) * 7)", overflowY: "auto" }}>
      {running === null
        ? <p className="muted">{labels.emptyRunning}</p>
        : <article className="timer-row">
            <div className="timer-row__copy">
              <strong>{labels.target} · <code>{running.targetLogin ?? running.targetUserId ?? "—"}</code></strong>
              <span>{labels.votes(running.yesVotes, running.noVotes, running.threshold)}</span>
              <span style={{ minWidth: "calc(var(--s10) * 7)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                {labels.remaining(remainingVotekickSeconds(running.endsAt, currentTime))}
              </span>
            </div>
            <div className="timer-row__actions">
              <Button variant="subtle" danger disabled={!canOperate || busy} onClick={() => { setDialogError(undefined); setCancelTarget(running); }}>{labels.cancel}</Button>
            </div>
          </article>}
      </div>
    </InspectorSection>

    <InspectorSection title={labels.history}>
        <div className="state-list" data-testid="votekick-history-list"
          style={{ height: "calc(var(--s10) * 20)", overflowY: "auto" }}>
          {history.length === 0 ? <p className="muted">{labels.emptyHistory}</p> : history.map((item) => (
            <article key={item.id} className="timer-row" style={{ height: "calc(var(--s10) * 5)", overflow: "hidden" }}>
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
                  ? <Button variant="neutral" disabled={!canOperate || busy} onClick={() => { setDialogError(undefined); setLiftTarget(item); }}>{labels.lift}</Button>
                  : item.liftedAt === null ? null : <span role="status">{labels.lifted}</span>}
              </div>
            </article>
          ))}
        </div>
    </InspectorSection>
    </>}
    </LoadState>

    <ConfirmDialog
      opened={cancelTarget !== null}
      title={labels.cancelTitle}
      description={labels.cancelDescription}
      confirmLabel={labels.confirmCancel}
      cancelLabel={labels.cancelDialogCancel}
      onConfirm={() => { void cancel(); }}
      onCancel={() => { setCancelTarget(null); setDialogError(undefined); }}
      pending={busy}
      danger
      {...(dialogError === undefined ? {} : { error: dialogError })}
    />
    <ConfirmDialog
      opened={liftTarget !== null}
      title={labels.liftTitle}
      description={labels.liftDescription}
      confirmLabel={labels.confirmLift}
      cancelLabel={labels.liftDialogCancel}
      onConfirm={() => { void lift(); }}
      onCancel={() => { setLiftTarget(null); setDialogError(undefined); }}
      pending={busy}
      danger
      {...(dialogError === undefined ? {} : { error: dialogError })}
    />
  </section>;
}
