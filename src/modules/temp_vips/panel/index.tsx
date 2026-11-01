import { useEffect, useMemo, useState, type ReactElement, type SyntheticEvent } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { formatNumber } from "../../../dashboard/locale";
import { Button, ConfirmDialog, Dialog, Field, SegmentChoice, UnitInput, notify } from "../../../dashboard/ui";
import { useModuleQuery } from "../../../dashboard/data";
import type { ModulePanelProperties, ModuleTempVipPerson, ModuleTempVipResult, ModuleTempVipRow } from "../../contract";
import type { TempVipsSettings } from "../contracts";
import {
  endTempVip,
  extendTempVip,
  grantTempVip,
  importTempVip,
  loadExistingVips,
  loadTempVips,
  releaseTempVip,
  retryTempVipRemoval,
} from "./service";
import { tempVipsPanelTexts } from "./locale";
import { channelDateTimeToEpoch } from "./time-zone";
import "./panel.css";

type DialogState = { kind: "grant" } | { kind: "takeover" } | { kind: "extend"; row: ModuleTempVipRow };
type TimeEntryMode = "duration" | "expiry";
type PanelLabels = typeof tempVipsPanelTexts["en"];
const DAY_MS = 24 * 60 * 60 * 1_000;

const isSuccess = (result: ModuleTempVipResult): boolean =>
  ["granted", "extended", "imported", "ended", "released"].includes(result.status);

const formatExpiry = (value: string, now: number, timeZone: string, language: "de" | "en") => {
  const expiry = Date.parse(value);
  if (!Number.isFinite(expiry)) return { absolute: value, relative: value };
  const absolute = new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone,
  }).format(expiry);
  const delta = expiry - now;
  const difference = Math.abs(delta);
  const unit: Intl.RelativeTimeFormatUnit = difference >= DAY_MS
    ? "day"
    : difference >= 60 * 60 * 1_000 ? "hour" : difference >= 60_000 ? "minute" : "second";
  const divisor = unit === "day" ? DAY_MS : unit === "hour" ? 60 * 60 * 1_000 : unit === "minute" ? 60_000 : 1_000;
  const relative = new Intl.RelativeTimeFormat(language === "de" ? "de-DE" : "en-US", { numeric: "auto" })
    .format(Math.round(delta / divisor), unit);
  return { absolute, relative };
};

const resultMessage = (status: string, labels: PanelLabels): string => {
  if (status === "not_vip") return labels.notVip;
  if (status === "maximum_exceeded") return labels.maximumExceeded;
  if (status === "already_vip" || status === "already_managed") return labels.alreadyVip;
  if (status === "not_managed") return labels.notManaged;
  if (status === "queued") return labels.operationPending;
  if (status === "twitch_unavailable") return labels.twitchUnavailable;
  return labels.operationFailed;
};

const errorMessage = (error: unknown, labels: PanelLabels): string => {
  if (!(error instanceof PanelApiError)) return labels.operationFailed;
  if (error.code === "temp_vips_user_not_found") return labels.userNotFound;
  if (error.code === "temp_vips_twitch_unavailable") return labels.twitchUnavailable;
  if (error.code === "temp_vips_duration_invalid") return labels.invalidDuration;
  if (error.code === "temp_vips_operator_required") return labels.operationFailed;
  return labels.operationFailed;
};

const normalizeSettings = (settings: TempVipsSettings | undefined): TempVipsSettings => settings ?? {
  defaultDurationDays: 7,
  maximumDurationDays: 90,
  announceExpiry: false,
};

export default function TempVipsPanel({ channelId, language = "de", canOperate = true }: ModulePanelProperties): ReactElement {
  const labels = tempVipsPanelTexts[language];
  const query = useModuleQuery(channelId, "temp_vips", "vips", (signal) => loadTempVips(channelId, signal));
  const settings = normalizeSettings(query.data?.settings);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [login, setLogin] = useState("");
  const [durationDays, setDurationDays] = useState<number | "">(settings.defaultDurationDays);
  const [timeEntryMode, setTimeEntryMode] = useState<TimeEntryMode>("duration");
  const [expiryInput, setExpiryInput] = useState("");
  const [vipFilter, setVipFilter] = useState("");
  const [existingVips, setExistingVips] = useState<ModuleTempVipPerson[] | null>(null);
  const [existingVipsFailed, setExistingVipsFailed] = useState(false);
  const [selectedVip, setSelectedVip] = useState<ModuleTempVipPerson | null>(null);
  const [confirmRow, setConfirmRow] = useState<ModuleTempVipRow | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | undefined>();
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [pageFeedback, setPageFeedback] = useState<string | null>(null);
  const [localNow, setLocalNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setLocalNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (dialog?.kind !== "takeover") return;
    const controller = new AbortController();
    void loadExistingVips(channelId, controller.signal).then((people) => {
      if (!controller.signal.aborted) setExistingVips(people);
    }).catch(() => {
      if (!controller.signal.aborted) setExistingVipsFailed(true);
    });
    return () => controller.abort();
  }, [channelId, dialog?.kind]);

  const serverNow = query.data === undefined
    ? localNow
    : Date.parse(query.data.now) + Math.max(0, localNow - query.dataUpdatedAt);
  const rows = useMemo(() => [...(query.data?.rows ?? [])].sort((left, right) =>
    Date.parse(left.expiresAt) - Date.parse(right.expiresAt) || left.login.localeCompare(right.login)), [query.data?.rows]);
  const visibleVips = useMemo(() => {
    const search = vipFilter.trim().replace(/^@/u, "").toLocaleLowerCase();
    return (existingVips ?? []).filter((person) => search.length === 0 || person.login.toLocaleLowerCase().includes(search) ||
      person.displayName.toLocaleLowerCase().includes(search));
  }, [existingVips, vipFilter]);

  const openDialog = (next: DialogState): void => {
    setDialog(next);
    setDialogError(null);
    setPageFeedback(null);
    setLogin("");
    setDurationDays(next.kind === "extend" ? settings.defaultDurationDays : Math.min(settings.defaultDurationDays, settings.maximumDurationDays));
    setTimeEntryMode("duration");
    setExpiryInput("");
    setVipFilter("");
    setSelectedVip(null);
    setExistingVips(null);
    setExistingVipsFailed(false);
  };

  const dismissDialog = (): void => {
    if (pending) return;
    setDialog(null);
    setDialogError(null);
  };

  const submitDialog = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (dialog === null || pending) return;
    setDialogError(null);
    const currentTime = Date.now();
    let durationMs: number | null = typeof durationDays === "number" && Number.isInteger(durationDays) && durationDays > 0
      ? durationDays * DAY_MS
      : null;
    if (dialog.kind === "takeover" && timeEntryMode === "expiry") {
      const expiry = channelDateTimeToEpoch(expiryInput, query.data?.timeZone ?? "UTC");
      durationMs = expiry === null ? null : expiry - currentTime;
      if (durationMs === null || durationMs <= 0) {
        setDialogError(labels.expiryRequired);
        return;
      }
    }
    if (durationMs === null) {
      setDialogError(labels.durationRequired);
      return;
    }
    if (durationMs > settings.maximumDurationDays * DAY_MS) {
      setDialogError(labels.maximumExceeded);
      return;
    }
    if (dialog.kind === "grant" && login.trim().length === 0) {
      setDialogError(labels.userNotFound);
      return;
    }
    if (dialog.kind === "takeover" && selectedVip === null) {
      setDialogError(labels.chooseTarget);
      return;
    }

    setPending(true);
    try {
      const result = dialog.kind === "grant"
        ? await grantTempVip(channelId, login.trim(), durationMs)
        : dialog.kind === "takeover" && selectedVip !== null
          ? await importTempVip(channelId, selectedVip.userId, durationMs)
          : dialog.kind === "extend"
            ? await extendTempVip(channelId, dialog.row.userId, durationMs)
            : null;
      if (result === null) return;
      if (!isSuccess(result) && result.status !== "queued") {
        setDialogError(resultMessage(result.status, labels));
        if (result.status === "not_vip") void query.refetch();
        return;
      }
      const success = result.status === "queued"
        ? labels.operationPending
        : dialog.kind === "grant" ? labels.grantSuccess
          : dialog.kind === "takeover" ? labels.importSuccess : labels.extendSuccess;
      setPageFeedback(success);
      notify({ tone: result.status === "queued" ? "info" : "success", message: success });
      setDialog(null);
      await query.refetch();
    } catch (error) {
      setDialogError(errorMessage(error, labels));
    } finally {
      setPending(false);
    }
  };

  const runRowAction = async (row: ModuleTempVipRow, action: "release" | "retry"): Promise<void> => {
    if (busyUserId !== null) return;
    setBusyUserId(row.userId);
    setPageFeedback(null);
    try {
      const result = action === "release"
        ? await releaseTempVip(channelId, row.userId)
        : await retryTempVipRemoval(channelId, row.userId);
      if (result.status !== "released" && result.status !== "queued" && result.status !== "ended") {
        setPageFeedback(resultMessage(result.status, labels));
        return;
      }
      const message = result.status === "queued" ? labels.operationPending : action === "release" ? labels.releaseSuccess : labels.retrySuccess;
      setPageFeedback(message);
      notify({ tone: result.status === "queued" ? "info" : "success", message });
      await query.refetch();
    } catch (error) {
      setPageFeedback(errorMessage(error, labels));
    } finally {
      setBusyUserId(null);
    }
  };

  const endNow = async (): Promise<void> => {
    if (confirmRow === null || confirmPending) return;
    setConfirmPending(true);
    setConfirmError(undefined);
    try {
      const result = await endTempVip(channelId, confirmRow.userId);
      if (result.status !== "ended" && result.status !== "queued") {
        setConfirmError(resultMessage(result.status, labels));
        return;
      }
      const message = result.status === "queued" ? labels.operationPending : labels.endSuccess;
      setPageFeedback(message);
      notify({ tone: result.status === "queued" ? "info" : "success", message });
      setConfirmRow(null);
      await query.refetch();
    } catch (error) {
      setConfirmError(errorMessage(error, labels));
    } finally {
      setConfirmPending(false);
    }
  };

  const dialogTitle = dialog === null ? "" : dialog.kind === "grant" ? labels.grantTitle
    : dialog.kind === "takeover" ? labels.takeOverTitle : labels.extendTitle(dialog.row.displayName);
  const now = Number.isFinite(serverNow) ? serverNow : localNow;
  const expiryZone = query.data?.timeZone ?? "UTC";

  return <section className="temp-vips-page" aria-label={labels.listTitle}>
    <header className="temp-vips-page__actions">
      <div className="temp-vips-page__action-buttons">
        <Button variant="primary" onClick={() => openDialog({ kind: "grant" })} disabled={!canOperate}>{labels.grant}</Button>
        <Button variant="neutral" onClick={() => openDialog({ kind: "takeover" })} disabled={!canOperate}>{labels.takeOver}</Button>
      </div>
      <div className="temp-vips-page__feedback" role="status" aria-live="polite">{pageFeedback ?? "\u00a0"}</div>
    </header>

    <section className="temp-vips-list" aria-label={labels.listTitle}>
      <div className="temp-vips-list__heading">
        <h2>{labels.listTitle}</h2>
        <span>{query.data === undefined ? "\u00a0" : formatNumber(rows.length, language)}</span>
      </div>
      {query.data === undefined ? query.isError ? <div className="temp-vips-list__state" role="alert">
        <p>{labels.loadError}</p>
        <Button variant="neutral" onClick={() => { void query.refetch(); }}>{labels.retry}</Button>
      </div> : <div className="temp-vips-list__state" aria-live="polite">{labels.loading}</div> : rows.length === 0
        ? <div className="temp-vips-list__state">{labels.empty}</div>
        : <div className="temp-vips-list__rows" role="list">
          {rows.map((row) => {
            const expiry = formatExpiry(row.expiresAt, now, expiryZone, language);
            const source = labels.sourceLabels[row.source];
            const busy = busyUserId === row.userId || confirmPending && confirmRow?.userId === row.userId;
            return <article className="temp-vips-row" data-warning={row.removalFailedAt === null ? "false" : "true"} key={row.userId} role="listitem">
              <div className="temp-vips-row__identity">
                <strong>{row.displayName}</strong>
                <span>@{row.login}</span>
                {row.removalFailedAt === null ? null : <span className="temp-vips-row__warning" role="status">
                  {labels.removalWarning}{row.removalError === null ? "" : ` · ${row.removalError}`}
                </span>}
              </div>
              <div className="temp-vips-row__expiry">
                <span className="temp-vips-row__label">{labels.expires}</span>
                <time dateTime={row.expiresAt} title={expiry.absolute}>{expiry.absolute}</time>
                <small>{expiry.relative}</small>
              </div>
              <div className="temp-vips-row__meta">
                <span><b>{labels.grantedBy}:</b> {row.grantedByLogin === null ? "—" : `@${row.grantedByLogin}`}</span>
                <span><b>{labels.source}:</b> {source}</span>
              </div>
              <div className="temp-vips-row__actions">
                <Button variant="subtle" size="compact" onClick={() => openDialog({ kind: "extend", row })} disabled={!canOperate || busy}>{labels.extend}</Button>
                {row.removalFailedAt === null ? null : <Button variant="neutral" size="compact" onClick={() => { void runRowAction(row, "retry"); }} disabled={!canOperate || busy}>{labels.retryRemoval}</Button>}
                <Button variant="neutral" danger size="compact" onClick={() => { setConfirmRow(row); setConfirmError(undefined); }} disabled={!canOperate || busy}>{labels.endNow}</Button>
                <Button variant="subtle" size="compact" onClick={() => { void runRowAction(row, "release"); }} disabled={!canOperate || busy} title={labels.releaseHint}>{labels.release}</Button>
              </div>
            </article>;
          })}
        </div>}
    </section>

    <Dialog opened={dialog !== null} title={dialogTitle} onClose={dismissDialog} pending={pending} className="temp-vips-dialog">
      <form className="temp-vips-dialog__form" onSubmit={(event) => { void submitDialog(event); }}>
        {dialog?.kind === "grant" ? <>
          <Field
            label={labels.name}
            hint={labels.loginHint}
            value={login}
            onChange={setLogin}
            placeholder="@pixelpilz"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            required
          />
          <UnitInput
            name="durationDays"
            label={labels.duration}
            unit={labels.days}
            value={durationDays}
            min={1}
            max={settings.maximumDurationDays}
            onChange={setDurationDays}
            hint={labels.durationHint}
            disabled={pending}
            required
          />
        </> : dialog?.kind === "extend" ? <UnitInput
          name="durationDays"
          label={labels.duration}
          unit={labels.days}
          value={durationDays}
          min={1}
          max={settings.maximumDurationDays}
          onChange={setDurationDays}
          hint={labels.durationHint}
          disabled={pending}
          required
        /> : dialog?.kind === "takeover" ? <>
          <Field
            label={labels.targetSearch}
            value={vipFilter}
            onChange={setVipFilter}
            variant="search"
            clearLabel={labels.clearSearch}
            placeholder="@pixelpilz"
            autoComplete="off"
            disabled={pending || existingVips === null || existingVipsFailed}
          />
          <div className="temp-vips-dialog__vip-list" role="listbox" aria-label={labels.chooseTarget}>
            {existingVips === null && !existingVipsFailed
              ? <p className="temp-vips-dialog__vip-empty" aria-live="polite">{labels.loading}</p>
              : existingVipsFailed
                ? <p className="temp-vips-dialog__vip-empty" role="alert">{labels.twitchUnavailable}</p>
                : visibleVips.length === 0
                  ? <p className="temp-vips-dialog__vip-empty">{labels.targetEmpty}</p>
                  : visibleVips.map((person) => (
                    <button
                      key={person.userId}
                      type="button"
                      className="temp-vips-dialog__vip-option"
                      role="option"
                      aria-selected={selectedVip?.userId === person.userId}
                      onClick={() => { setSelectedVip(person); setDialogError(null); }}
                      disabled={pending}
                    >
                      <strong>{person.displayName}</strong><span>@{person.login}</span>
                    </button>
                  ))}
          </div>
          <p className="temp-vips-dialog__selection">{selectedVip === null
            ? "\u00a0"
            : <>{labels.selectedTarget}: <strong>{selectedVip.displayName} (@{selectedVip.login})</strong></>}</p>
          <SegmentChoice<TimeEntryMode>
            label={labels.remainingTime}
            value={timeEntryMode}
            onChange={setTimeEntryMode}
            disabled={pending || existingVips === null || existingVipsFailed || existingVips.length === 0}
            wrap
            options={[
              { value: "duration", label: labels.remainingDuration },
              { value: "expiry", label: labels.expiryDate },
            ]}
          />
          {timeEntryMode === "duration" ? <UnitInput
            label={labels.duration}
            unit={labels.days}
            value={durationDays}
            min={1}
            max={settings.maximumDurationDays}
            onChange={setDurationDays}
            hint={labels.durationHint}
            disabled={pending || existingVips === null || existingVipsFailed || existingVips.length === 0 || selectedVip === null}
            required
          /> : <Field
            label={`${labels.expiryDate} · ${expiryZone}`}
            type="datetime-local"
            value={expiryInput}
            onChange={setExpiryInput}
            hint={labels.expiryDateHint(expiryZone)}
            disabled={pending || existingVips === null || existingVipsFailed || existingVips.length === 0 || selectedVip === null}
            required
          />}
        </> : null}
        <div className="temp-vips-dialog__error" role="alert" aria-live="polite">{dialogError ?? "\u00a0"}</div>
        <div className="temp-vips-dialog__actions">
          <Button variant="subtle" type="button" onClick={dismissDialog} disabled={pending}>{labels.cancel}</Button>
          <Button variant="primary" type="submit" disabled={pending || dialog?.kind === "takeover" && (existingVips === null || existingVipsFailed || existingVips.length === 0 || selectedVip === null)}>
            {dialog?.kind === "takeover" ? labels.save : dialog?.kind === "extend" ? labels.extend : labels.grant}
          </Button>
        </div>
      </form>
    </Dialog>

    <ConfirmDialog
      opened={confirmRow !== null}
      title={confirmRow === null ? labels.endNow : labels.endTitle(confirmRow.displayName)}
      description={labels.endDescription}
      confirmLabel={labels.endNow}
      cancelLabel={labels.cancel}
      danger
      pending={confirmPending}
      {...(confirmError === undefined ? {} : { error: confirmError })}
      onCancel={() => { if (!confirmPending) setConfirmRow(null); }}
      onConfirm={() => { void endNow(); }}
    />
  </section>;
}
