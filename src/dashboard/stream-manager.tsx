import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { PanelEventEntry } from "../panel-contract";
import { createClip, fetchEvents, PanelApiError, sendManualShoutout, startCommercial } from "./api";
import { apiErrorText, dashboardLanguage, dashboardTexts, eventText, formatStreamManagerFeedTime, shoutoutFailureReasonText } from "./locale";
import { eventDetail, eventMetadata } from "./events/model";
import { emptyEventFilter } from "./events/model";
import { useRealtimeEventFeed } from "./realtime";
import { Button, Field, SegmentedControl } from "./ui";
import { Icon } from "./ui/Icon";
import { dashboardRoutePath, type DashboardRoute } from "./router";

/** Twitch's own accepted Start Commercial lengths (seconds); kept here, not
 *  imported from the ads module's adapter -- the dashboard doesn't reach
 *  into a module's internals, only its panel contract. */
const AD_LENGTHS = ["30", "60", "90", "120", "150", "180"];

interface ActionState {
  pending: boolean;
  error: string | null;
  success: string | null;
}

const idleAction: ActionState = { pending: false, error: null, success: null };

const failureText = (error: unknown, fallback: string): string =>
  error instanceof PanelApiError ? apiErrorText(error.code, fallback) : fallback;

const AdNowAction = ({ channelId, streamState }: { channelId: string; streamState?: "online" | "offline" | null | undefined }): ReactElement => {
  const texts = dashboardTexts();
  const [length, setLength] = useState<string | null>(AD_LENGTHS[1] ?? null);
  const [state, setState] = useState<ActionState>(idleAction);

  const run = async (): Promise<void> => {
    if (state.pending || length === null) return;
    setState({ pending: true, error: null, success: null });
    try {
      const result = await startCommercial(channelId, Number(length));
      setState({ pending: false, error: null, success: texts.streamManager.adStarted(String(result.length ?? length)) });
    } catch (error: unknown) {
      setState({ pending: false, error: failureText(error, texts.errors.changeFailed), success: null });
    }
  };

  return (
    <div className="stream-manager-action">
      <div className="stream-manager-action__header"><Icon name="ad" size={20} /><h3>{texts.streamManager.adTitle}</h3></div>
      <div className="stream-manager-action__body">
        <SegmentedControl
          label={texts.streamManager.adLength}
          hint={texts.streamManager.adLengthHint}
          value={length ?? ""}
          onChange={(next) => { setLength(next); }}
          options={AD_LENGTHS.map((value) => ({ value, label: `${value}s` }))}
          disabled={state.pending}
          size="compact"
        />
      </div>
      <Button className="stream-manager-action__button" icon="ad" variant="primary" disabled={state.pending || length === null || streamState === "offline"} onClick={() => { void run(); }}>
        {texts.streamManager.runAd(length ?? "")}
      </Button>
      {streamState === "offline" ? <p className="lock-reason">{texts.streamManager.adDisabledOffline}</p> : null}
      {state.success === null ? null : <p className="form-success" role="status">{state.success}</p>}
      {state.error === null ? null : <p className="form-error" role="alert">{state.error}</p>}
    </div>
  );
};

const ShoutoutAction = ({ channelId }: { channelId: string }): ReactElement => {
  const texts = dashboardTexts();
  const [login, setLogin] = useState("");
  const [state, setState] = useState<ActionState>(idleAction);

  const run = async (): Promise<void> => {
    const trimmed = login.trim();
    if (state.pending || trimmed.length === 0) return;
    setState({ pending: true, error: null, success: null });
    try {
      await sendManualShoutout(channelId, trimmed);
      setState({ pending: false, error: null, success: texts.streamManager.shoutoutSent(trimmed) });
    } catch (error: unknown) {
      const reason = error instanceof PanelApiError && error.details !== null && typeof error.details === "object" && !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>).reason
        : null;
      const reasonText = shoutoutFailureReasonText(reason);
      setState({ pending: false, error: reasonText ?? failureText(error, texts.errors.changeFailed), success: null });
    }
  };

  const isEmpty = login.trim().length === 0;
  const loginId = "stream-manager-shoutout-login";
  const helperId = `${loginId}-description`;

  return (
    <div className="stream-manager-action">
      <div className="stream-manager-action__header"><Icon name="shoutout" size={20} /><h3>{texts.streamManager.shoutoutTitle}</h3></div>
      <div className="stream-manager-action__body">
        <Field
          id={loginId}
          label={texts.streamManager.shoutoutLogin}
          hint={isEmpty ? texts.streamManager.shoutoutLoginRequired : texts.streamManager.shoutoutLoginHint}
          prefix="@"
          value={login}
          onChange={setLogin}
          disabled={state.pending}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void run(); } }}
        />
      </div>
      <Button className="stream-manager-action__button" icon="shoutout" variant="primary" disabled={state.pending || isEmpty} {...(isEmpty ? { describedBy: helperId } : {})} onClick={() => { void run(); }}>
        {texts.streamManager.sendShoutout}
      </Button>
      {state.success === null ? null : <p className="form-success" role="status">{state.success}</p>}
      {state.error === null ? null : <p className="form-error" role="alert">{state.error}</p>}
    </div>
  );
};

const ClipAction = ({ channelId }: { channelId: string }): ReactElement => {
  const texts = dashboardTexts();
  const [state, setState] = useState<ActionState>(idleAction);
  const [editUrl, setEditUrl] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    if (state.pending) return;
    setState({ pending: true, error: null, success: null });
    setEditUrl(null);
    try {
      const result = await createClip(channelId);
      setEditUrl(result.editUrl);
      setState({ pending: false, error: null, success: texts.streamManager.clipCreated });
    } catch (error: unknown) {
      setState({ pending: false, error: failureText(error, texts.errors.changeFailed), success: null });
    }
  };

  return (
    <div className="stream-manager-action">
      <div className="stream-manager-action__header"><Icon name="clip" size={20} /><h3>{texts.streamManager.clipTitle}</h3></div>
      <Button className="stream-manager-action__button" icon="clip" variant="primary" disabled={state.pending} onClick={() => { void run(); }}>
        {texts.streamManager.createClip}
      </Button>
      {state.success === null ? null : (
        <p className="form-success" role="status">
          <span>{state.success}</span>{editUrl === null ? null : <> · <a href={editUrl} target="_blank" rel="noreferrer" aria-label={`${texts.streamManager.openClip} (${texts.streamManager.opensNewTab})`}>{texts.streamManager.openClip}<Icon name="external" size={16} /></a></>}
        </p>
      )}
      {state.error === null ? null : <p className="form-error" role="alert">{state.error}</p>}
    </div>
  );
};

/**
 * The three immediate actions from Epic 4: each reports success/failure at
 * itself (inline, next to its own button), never a global toast, and each
 * guards its own in-flight request the same way `Switch`'s `pending` does.
 */
export const ImmediateActions = ({ channelId, streamState }: { channelId: string; streamState?: "online" | "offline" | null | undefined }): ReactElement => {
  const texts = dashboardTexts();
  return (
    <section className="content-section" aria-label={texts.streamManager.immediateActions}>
      <div className="section-heading"><h2>{texts.streamManager.immediateActions}</h2></div>
      <div className="stream-manager-actions">
        <AdNowAction channelId={channelId} streamState={streamState} />
        <ShoutoutAction channelId={channelId} />
        <ClipAction channelId={channelId} />
      </div>
    </section>
  );
};

/**
 * Warnings and errors only, no interaction (no row selection, no filter
 * bar) -- a glance, not the full event log. Reuses the event log's realtime
 * feed and refreshes its first page when a new event arrives.
 */
export const WarningsAndErrorsFeed = ({ channelId, onNavigate }: { channelId: string; onNavigate?: (route: DashboardRoute) => void }): ReactElement => {
  const texts = dashboardTexts();
  const [entries, setEntries] = useState<readonly PanelEventEntry[]>([]);
  const allAlertsRoute: DashboardRoute = {
    kind: "channel",
    channelId,
    section: "events",
    filters: { ...emptyEventFilter, tones: ["warning", "error"] },
  };
  const refreshFirstPage = useCallback(async (): Promise<void> => {
    const response = await fetchEvents(channelId);
    setEntries(response.entries
      .filter((entry) => {
        const tone = eventMetadata(entry.code)?.tone;
        return tone === "warning" || tone === "error";
      })
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, 3));
  }, [channelId]);
  const atBeginning = useCallback((): boolean => true, []);
  const scrollToBeginning = useCallback((): void => undefined, []);
  useRealtimeEventFeed({ channelId, filters: emptyEventFilter, atBeginning, refreshFirstPage, scrollToBeginning });

  useEffect(() => {
    const controller = new AbortController();
    fetchEvents(channelId, null, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setEntries(response.entries
          .filter((entry) => {
            const tone = eventMetadata(entry.code)?.tone;
            return tone === "warning" || tone === "error";
          })
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
          .slice(0, 3));
      })
      .catch(() => { if (!controller.signal.aborted) setEntries([]); });
    return () => { controller.abort(); };
  }, [channelId]);

  return (
    <section className="content-section" aria-label={texts.streamManager.feedTitle}>
      <div className="section-heading"><h2>{texts.streamManager.feedTitle}</h2><a className="stream-manager-feed__all" href={dashboardRoutePath(allAlertsRoute)} onClick={onNavigate === undefined ? undefined : (event) => { event.preventDefault(); onNavigate(allAlertsRoute); }}>{texts.streamManager.feedAll}</a></div>
      {entries.length === 0 ? (
        <p className="stream-manager-feed__empty">{texts.streamManager.feedEmpty}</p>
      ) : (
        <ul className="stream-manager-feed">
          {entries.map((entry) => {
            const label = eventText(entry.code, eventDetail(entry.detail));
            const metadata = eventMetadata(entry.code);
            const tone = metadata?.tone === "error" ? "error" : metadata?.tone === "warning" ? "warning" : "neutral";
            return (
              <li key={entry.eventId}>
                <a
                  className="stream-manager-feed__row"
                  href={dashboardRoutePath(allAlertsRoute)}
                  onClick={onNavigate === undefined ? undefined : (event) => { event.preventDefault(); onNavigate(allAlertsRoute); }}
                >
                  <span className="event-chip" data-tone={tone}>{metadata?.word[dashboardLanguage()] ?? texts.events.unknown}</span>
                  <span className="stream-manager-feed__text">{label}</span>
                  <time className="stream-manager-feed__time mono" dateTime={entry.createdAt} title={entry.createdAt}>{formatStreamManagerFeedTime(entry.createdAt)}</time>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
