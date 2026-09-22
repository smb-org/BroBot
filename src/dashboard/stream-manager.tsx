import { useEffect, useState, type ReactElement } from "react";

import type { PanelEventEntry } from "../panel-contract";
import { createClip, fetchEvents, PanelApiError, sendManualShoutout, startCommercial } from "./api";
import { apiErrorText, dashboardTexts, eventText, formatTimestamp } from "./locale";
import { eventDetail, eventMetadata } from "./events/model";
import { Button, Field, Select } from "./ui";
import { Led, type LedStatus } from "./module-panels";

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
      <Select
        label={texts.streamManager.adLength}
        value={length}
        onChange={setLength}
        options={AD_LENGTHS.map((value) => ({ value, label: `${value}s` }))}
        disabled={state.pending}
      />
      <Button variant="primary" disabled={state.pending || length === null} onClick={() => { void run(); }}>
        {texts.streamManager.runAd(length ?? "")}
      </Button>
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

  return (
    <div className="stream-manager-action">
      <Field
        label={texts.streamManager.shoutoutLogin}
        value={login}
        onChange={setLogin}
        disabled={state.pending}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void run(); } }}
      />
      <Button variant="primary" disabled={state.pending || login.trim().length === 0} onClick={() => { void run(); }}>
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
      <Button variant="primary" disabled={state.pending} onClick={() => { void run(); }}>
        {texts.streamManager.createClip}
      </Button>
      {state.success === null ? null : (
        <p className="form-success" role="status">
          <span>{state.success}</span>{editUrl === null ? null : <> · <a href={editUrl} target="_blank" rel="noreferrer">{texts.streamManager.openClip}</a></>}
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

const toneToLed = (tone: string | undefined): LedStatus =>
  tone === "error" ? "red" : tone === "warning" ? "amber" : "off";

/**
 * Warnings and errors only, no interaction (no row selection, no filter
 * bar) -- a glance, not the full event log. Fetches once per channel; the
 * full `EventsPage` (with filtering and an inspector) stays the place to
 * dig in.
 */
export const WarningsAndErrorsFeed = ({ channelId }: { channelId: string }): ReactElement => {
  const texts = dashboardTexts();
  const [entries, setEntries] = useState<readonly PanelEventEntry[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchEvents(channelId, null, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setEntries(response.entries.filter((entry) => eventMetadata(entry.code)?.tone !== "info"));
      })
      .catch(() => { if (!controller.signal.aborted) setEntries([]); });
    return () => { controller.abort(); };
  }, [channelId]);

  return (
    <section className="content-section" aria-label={texts.streamManager.feedTitle}>
      <div className="section-heading"><h2>{texts.streamManager.feedTitle}</h2></div>
      {entries === null ? null : entries.length === 0 ? (
        <p className="empty-state">{texts.streamManager.feedEmpty}</p>
      ) : (
        <ul className="stream-manager-feed">
          {entries.map((entry) => {
            const label = eventText(entry.code, eventDetail(entry.detail));
            return (
              <li key={entry.eventId}>
                <Led status={toneToLed(eventMetadata(entry.code)?.tone)} label={label} />
                <span className="muted mono">{formatTimestamp(entry.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
