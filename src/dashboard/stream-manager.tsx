import { useEffect, useState, type ReactElement } from "react";

import type { PanelEventEntry } from "../panel-contract";
import { createClip, fetchEvents, PanelApiError, sendManualShoutout, startCommercial } from "./api";
import { apiErrorText, dashboardLanguage, dashboardTexts, eventText, formatStreamManagerFeedTime } from "./locale";
import { eventDetail, eventMetadata } from "./events/model";
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

const AdNowAction = ({ channelId }: { channelId: string }): ReactElement => {
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
      <div className="stream-manager-action__controls">
        <div className="stream-manager-action__field stream-manager-action__field--length">
          <SegmentedControl
            label={texts.streamManager.adLength}
            hint={texts.streamManager.adLengthHint}
            value={length ?? ""}
            onChange={(next) => { setLength(next); }}
            options={AD_LENGTHS.map((value) => ({ value, label: `${value}s` }))}
            disabled={state.pending}
          />
        </div>
        <Button icon="ad" variant="primary" disabled={state.pending || length === null} onClick={() => { void run(); }}>
          {texts.streamManager.runAd(length ?? "")}
        </Button>
      </div>
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
      setState({ pending: false, error: failureText(error, texts.errors.changeFailed), success: null });
    }
  };

  const emptyReasonId = "stream-manager-shoutout-reason";

  return (
    <div className="stream-manager-action">
      <div className="stream-manager-action__controls">
        <div className="stream-manager-action__field">
          <Field
            label={texts.streamManager.shoutoutLogin}
            hint={texts.streamManager.shoutoutLoginHint}
            prefix="@"
            value={login}
            onChange={setLogin}
            disabled={state.pending}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void run(); } }}
          />
        </div>
        <Button icon="shoutout" variant="primary" disabled={state.pending || login.trim().length === 0} {...(login.trim().length === 0 ? { describedBy: emptyReasonId } : {})} onClick={() => { void run(); }}>
          {texts.streamManager.sendShoutout}
        </Button>
      </div>
      {login.trim().length === 0 ? <p id={emptyReasonId} className="muted stream-manager-action__reason">{texts.streamManager.shoutoutLoginRequired}</p> : null}
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
      <div className="stream-manager-action__controls">
        <Button icon="clip" variant="primary" disabled={state.pending} onClick={() => { void run(); }}>
          {texts.streamManager.createClip}
        </Button>
      </div>
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
export const ImmediateActions = ({ channelId }: { channelId: string }): ReactElement => {
  const texts = dashboardTexts();
  return (
    <section className="content-section" aria-label={texts.streamManager.immediateActions}>
      <div className="section-heading"><h2>{texts.streamManager.immediateActions}</h2></div>
      <div className="stream-manager-actions">
        <AdNowAction channelId={channelId} />
        <ShoutoutAction channelId={channelId} />
        <ClipAction channelId={channelId} />
      </div>
    </section>
  );
};

/**
 * Warnings and errors only, no interaction (no row selection, no filter
 * bar) -- a glance, not the full event log. Fetches once per channel; the
 * full `EventsPage` (with filtering and an inspector) stays the place to
 * dig in.
 */
export const WarningsAndErrorsFeed = ({ channelId, onNavigate }: { channelId: string; onNavigate?: (route: DashboardRoute) => void }): ReactElement => {
  const texts = dashboardTexts();
  const [entries, setEntries] = useState<readonly PanelEventEntry[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchEvents(channelId, null, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setEntries(response.entries
          .filter((entry) => eventMetadata(entry.code)?.tone !== "info")
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)));
      })
      .catch(() => { if (!controller.signal.aborted) setEntries([]); });
    return () => { controller.abort(); };
  }, [channelId]);

  return (
    <section className="content-section" aria-label={texts.streamManager.feedTitle}>
      <div className="section-heading"><h2>{texts.streamManager.feedTitle}</h2></div>
      {entries === null ? null : entries.length === 0 ? (
        <p className="stream-manager-feed__empty">{texts.streamManager.feedEmpty}</p>
      ) : (
        <ul className="stream-manager-feed">
          {entries.map((entry) => {
            const label = eventText(entry.code, eventDetail(entry.detail));
            const metadata = eventMetadata(entry.code);
            const tone = metadata?.tone === "error" ? "error" : metadata?.tone === "warning" ? "warning" : "neutral";
            const route: DashboardRoute = { kind: "channel", channelId, section: "events" };
            return (
              <li key={entry.eventId}>
                <a
                  className="stream-manager-feed__row"
                  href={dashboardRoutePath(route)}
                  onClick={onNavigate === undefined ? undefined : (event) => { event.preventDefault(); onNavigate(route); }}
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
