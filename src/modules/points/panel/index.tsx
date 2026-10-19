import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { moduleQueryKey, refetchModuleQueryData, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { dashboardCommonTexts, dashboardLanguage, formatNumber, pointsDashboardTexts } from "../../../dashboard/locale";
import { ActionMenu } from "../../../dashboard/ui/ActionMenu";
import { CollectionPage } from "../../../dashboard/ui/CollectionPage";
import { DataTable } from "../../../dashboard/ui/DataTable";
import { Field } from "../../../dashboard/ui/Field";
import { Button } from "../../../dashboard/ui/Button";
import { Icon } from "../../../dashboard/ui/Icon";
import { ListPaginationFooter } from "../../../dashboard/ui/ListPaginationFooter";
import { ListToolbar } from "../../../dashboard/ui/ListToolbar";
import { SaveStatus } from "../../../dashboard/ui/SaveStatus";
import { SegmentChoice } from "../../../dashboard/ui/SegmentChoice";
import { PageHeader } from "../../../dashboard/ui/PageHeader";
import type { ModulePanelProperties } from "../../contract";
import type { PointsSettings } from "../contracts";
import { DEFAULT_POINTS_SETTINGS, MAX_POINTS_ADJUSTMENT_REASON_LENGTH, pointsSettingsSchema } from "../contracts";
import type { PointsAccount, PointsAccountDetail, PointsHistoryRow } from "./service";
import { adjustPoints, loadPointsAccount, loadPointsAccounts, loadPointsHistory, loadPointsRank, loadPointsSettings, loadPointsSummary, savePointsSettings } from "./service";
import "./panel.css";

const randomId = (): string => crypto.randomUUID();

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const historySource = (row: PointsHistoryRow, language: "de" | "en", resolveModuleName?: (moduleId: string, language: "de" | "en") => string): string => {
  const copy = pointsDashboardTexts[language].source;
  if (row.kind === "activity") return copy.activity;
  if (row.kind === "bonus") return copy.start;
  if (row.kind === "admin") {
    const detail = asRecord(row.detail);
    const reason = typeof detail?.reason === "string" ? detail.reason : "";
    const actor = typeof detail?.actorLogin === "string" ? detail.actorLogin : "";
    return copy.correction(reason, actor);
  }
  return resolveModuleName?.(row.moduleId, language) ?? row.moduleId;
};

const monthLabel = (month: string, language: "de" | "en"): string => new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
  month: "long", timeZone: "UTC",
}).format(new Date(`${month}-01T00:00:00.000Z`));

const isDefiniteCorrectionRejection = (error: unknown): boolean => error instanceof PanelApiError && error.status === 400 &&
  ["points_adjustment_invalid", "invalid_account", "insufficient_balance", "balance_overflow"].includes(error.code ?? "");

interface CorrectionRequest {
  operationId: string;
  delta: number;
  reason: string;
}

interface PointsSettingsEdit {
  revision: number;
  base: PointsSettings;
  settings: PointsSettings;
}

interface SelectedAccount {
  accountId: string;
  detail: PointsAccount;
}

interface AccountCorrectionState {
  pending: CorrectionRequest | null;
  committedBalance: number | null;
  error?: string | undefined;
  status?: string | undefined;
  submitting: boolean;
}

const emptyCorrectionState = (): AccountCorrectionState => ({ pending: null, committedBalance: null, submitting: false });

function PointsPanelContent({ channelId, language, canManage = true, resolveModuleName }: ModulePanelProperties): ReactElement {
  const locale = language ?? dashboardLanguage();
  const labels = pointsDashboardTexts[locale].panel;
  const commonLabels = dashboardCommonTexts();
  const queryClient = useDashboardQueryClient();
  const [sort, setSort] = useState<"balance" | "month">("balance");
  const [search, setSearch] = useState("");
  const [accountCursor, setAccountCursor] = useState<string | undefined>();
  const [accountCursorStack, setAccountCursorStack] = useState<(string | undefined)[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | undefined>();
  const [historyCursorStack, setHistoryCursorStack] = useState<(string | undefined)[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<SelectedAccount | null>(null);
  const selectedId = selectedAccount?.accountId ?? null;
  const selectedIdRef = useRef<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsEdit, setSettingsEdit] = useState<PointsSettingsEdit | null>(null);
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [corrections, setCorrections] = useState<Record<string, AccountCorrectionState>>({});
  const updateCorrection = useCallback((accountId: string, update: Partial<AccountCorrectionState>): void => {
    setCorrections((previous) => ({
      ...previous,
      [accountId]: { ...emptyCorrectionState(), ...previous[accountId], ...update },
    }));
  }, []);

  const accountsQuery = useModuleQuery(channelId, "points", `accounts:${sort}:${search}:${accountCursor ?? "first"}`,
    (signal) => loadPointsAccounts(channelId, sort, search, accountCursor, signal));
  const summaryQuery = useModuleQuery(channelId, "points", "summary", (signal) => loadPointsSummary(channelId, signal));
  const settingsQuery = useModuleQuery(channelId, "points", "settings", (signal) => loadPointsSettings(channelId, signal));
  const accountDetailQuery = useModuleQuery(channelId, "points", `account:${selectedId ?? "none"}`,
    (signal) => selectedId === null ? Promise.resolve(null) : loadPointsAccount(channelId, selectedId, signal),
    { enabled: selectedId !== null });
  const selected = useMemo(() => selectedAccount === null ? null : {
    ...selectedAccount.detail,
    ...(accountDetailQuery.data ?? {}),
  }, [accountDetailQuery.data, selectedAccount]);
  const selectedCorrection = selected === null ? emptyCorrectionState() : corrections[selected.accountId] ?? emptyCorrectionState();
  const selectedBalance = selected === null ? 0 : selectedCorrection.committedBalance ?? selected.balance;
  const rankQuery = useModuleQuery(channelId, "points", `rank:${selectedId ?? "none"}`,
    (signal) => selectedId === null ? Promise.resolve({ rank: null, net: 0 }) : loadPointsRank(channelId, selectedId, signal),
    { enabled: selectedId !== null });
  const historyQuery = useModuleQuery(channelId, "points", `history:${selectedId ?? "none"}:${historyCursor ?? "first"}`,
    (signal) => selectedId === null ? Promise.resolve<{ rows: PointsHistoryRow[]; cursor?: string }>({ rows: [] }) : loadPointsHistory(channelId, selectedId, historyCursor, signal),
    { enabled: selectedId !== null });
  const accounts = accountsQuery.data?.rows ?? [];
  const summary = summaryQuery.data;
  const history = historyQuery.data?.rows ?? [];
  const deltaNumber = Number(delta);
  const pendingAdjustment = selectedCorrection.pending;
  const adjustPending = selectedCorrection.submitting;
  // Once booked (audit pending), selectedBalance already includes the draft amount.
  const newBalance = selectedCorrection.committedBalance !== null || !Number.isSafeInteger(deltaNumber) ? selectedBalance : selectedBalance + deltaNumber;
  const correctionValid = selected !== null && Number.isSafeInteger(deltaNumber) && delta.trim().length > 0 && deltaNumber !== 0 &&
    Number.isSafeInteger(newBalance) && newBalance >= 0 && reason.trim().length > 0 && reason.trim().length <= MAX_POINTS_ADJUSTMENT_REASON_LENGTH;
  const balanceOverflow = selected !== null && Number.isSafeInteger(deltaNumber) && !Number.isSafeInteger(newBalance);
  const settingsDataRevision = settingsQuery.data?.revision ?? null;
  const settingsDirty = settingsEdit !== null && JSON.stringify(settingsEdit.settings) !== JSON.stringify(settingsEdit.base);
  const settingsRevision = settingsDirty ? settingsEdit.revision : settingsDataRevision ?? settingsEdit?.revision ?? null;
  const settingsDraft = settingsDirty
    ? settingsEdit.settings
    : settingsQuery.data !== undefined && (settingsEdit === null || settingsQuery.data.revision >= settingsEdit.revision)
      ? settingsQuery.data.settings
      : settingsEdit?.settings ?? DEFAULT_POINTS_SETTINGS;
  const settingsConflict = settingsDirty && settingsDataRevision !== null && settingsDataRevision > settingsEdit.revision;
  const settingsValid = pointsSettingsSchema.safeParse(settingsDraft).success;

  const resetAccountPage = (): void => {
    setAccountCursor(undefined);
    setAccountCursorStack([]);
  };

  const resetDetailDraft = (): void => {
    setHistoryCursor(undefined);
    setHistoryCursorStack([]);
    setDelta("");
    setReason("");
  };

  const changeSearch = (value: string): void => {
    setSearch(value);
    resetAccountPage();
  };

  const changeSort = (value: "balance" | "month"): void => {
    setSort(value);
    resetAccountPage();
  };

  const selectAccount = (account: PointsAccount): void => {
    if (selectedId !== account.accountId) {
      setHistoryCursor(undefined);
      setHistoryCursorStack([]);
      const pending = corrections[account.accountId]?.pending;
      setDelta(pending === null || pending === undefined ? "" : String(pending.delta));
      setReason(pending?.reason ?? "");
    }
    selectedIdRef.current = account.accountId;
    setSelectedAccount({ accountId: account.accountId, detail: account });
    setSettingsOpen(false);
  };

  const closeDetail = (): void => {
    resetDetailDraft();
    selectedIdRef.current = null;
    setSelectedAccount(null);
    setSettingsOpen(false);
  };

  const settingFields: readonly [keyof PointsSettings, string, "text" | "number"][] = [
    ["currencyName", labels.currencyName, "text"],
    ["startBonus", labels.startBonus, "number"],
    ["activityAmount", labels.activityAmount, "number"],
    ["windowMinutes", labels.windowMinutes, "number"],
    ["dailyCap", labels.dailyCap, "number"],
  ];

  const saveSettings = useCallback(async (): Promise<void> => {
    if (!canManage || settingsRevision === null || settingsPending || !settingsDirty || settingsConflict || !settingsValid) return;
    setSettingsPending(true);
    setSettingsError(undefined);
    setSettingsSaved(false);
    try {
      const result = await savePointsSettings(channelId, settingsRevision, settingsDraft);
      setSettingsEdit({ revision: result.revision, base: result.settings, settings: result.settings });
      await queryClient.invalidateQueries({ queryKey: ["channel", channelId, "module", "points", "summary"] });
      await queryClient.invalidateQueries({ queryKey: ["channel", channelId, "module", "points", "settings"] });
      setSettingsSaved(true);
    } catch (error) {
      if (error instanceof PanelApiError && error.status === 409) {
        try {
          await refetchModuleQueryData(queryClient, channelId, "points", "settings");
        } catch {
          setSettingsError(labels.settingsError);
        }
      } else {
        setSettingsError(labels.settingsError);
      }
    } finally {
      setSettingsPending(false);
    }
  }, [canManage, channelId, labels.settingsError, queryClient, settingsConflict, settingsDirty, settingsDraft, settingsPending, settingsRevision, settingsValid]);

  const discardSettings = (): void => {
    if (settingsQuery.data === undefined) return;
    setSettingsEdit(null);
    setSettingsError(undefined);
    setSettingsSaved(false);
  };

  const performAdjustment = useCallback(async (accountId: string, request: CorrectionRequest): Promise<void> => {
    if (!canManage || corrections[accountId]?.submitting === true) return;
    updateCorrection(accountId, { submitting: true, error: undefined, status: undefined });
    try {
      const result = await adjustPoints(channelId, accountId, request.operationId, request.delta, request.reason);
      setSelectedAccount((current) => current?.accountId === accountId
        ? { ...current, detail: { ...current.detail, balance: result.balance } }
        : current);
      const accountQueryKey = moduleQueryKey(channelId, "points", `account:${accountId}`);
      await queryClient.cancelQueries({ queryKey: accountQueryKey, exact: true });
      queryClient.setQueryData<PointsAccountDetail | null>(accountQueryKey, (current) =>
        current === undefined || current === null ? current : { ...current, balance: result.balance });
      if (result.auditPending) {
        updateCorrection(accountId, { committedBalance: result.balance, pending: request, status: labels.correctionBookedPending });
      } else {
        // Clear the sent draft before the refetch so the preview never adds the delta to the booked balance again.
        updateCorrection(accountId, { committedBalance: null, pending: null, status: labels.saved });
        if (selectedIdRef.current === accountId) {
          setDelta("");
          setReason("");
        }
        await queryClient.invalidateQueries({ queryKey: ["channel", channelId, "module", "points"] });
      }
    } catch (error) {
      const code = error instanceof PanelApiError ? error.code : "";
      updateCorrection(accountId, {
        pending: isDefiniteCorrectionRejection(error) ? null : request,
        error: code === "insufficient_balance" ? labels.negative : code === "balance_overflow" ? labels.balanceOverflow : labels.correctionError,
        status: undefined,
      });
    } finally {
      updateCorrection(accountId, { submitting: false });
    }
  }, [canManage, channelId, corrections, labels.balanceOverflow, labels.correctionBookedPending, labels.correctionError, labels.negative, labels.saved, queryClient, updateCorrection]);

  const saveAdjustment = useCallback((): void => {
    if (!correctionValid) return;
    const request = { operationId: randomId(), delta: deltaNumber, reason: reason.trim() };
    updateCorrection(selected.accountId, { pending: request });
    void performAdjustment(selected.accountId, request);
  }, [correctionValid, deltaNumber, performAdjustment, reason, selected, updateCorrection]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (settingsOpen && settingsDirty) {
        event.preventDefault();
        if (settingsValid) void saveSettings();
      } else if (!settingsOpen && selectedId !== null && (delta.trim().length > 0 || reason.trim().length > 0)) {
        event.preventDefault();
        if (correctionValid && pendingAdjustment === null) saveAdjustment();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, [settingsOpen, settingsDirty, settingsValid, settingsDraft, settingsRevision, settingsPending, selectedId, delta, reason,
    correctionValid, pendingAdjustment, selected, saveSettings, saveAdjustment]);

  const createTimer = (): void => {
    window.sessionStorage.setItem("brobot.timer-draft-message", JSON.stringify({ name: labels.timerName, messageText: labels.timerMessage }));
    window.location.href = `/channels/${encodeURIComponent(channelId)}/modules/timers`;
  };

  const month = summary?.month ?? new Date().toISOString().slice(0, 7);
  const correctionDirty = pendingAdjustment !== null || delta.trim().length > 0 || reason.trim().length > 0;
  const correctionWarnings = selectedCorrection.status === undefined
    ? correctionDirty ? [labels.unsaved] : []
    : selectedCorrection.status === labels.saved ? [] : [selectedCorrection.status];
  const detail = settingsOpen ? <section className="points-settings" aria-label={labels.settingsTitle}>
    <PageHeader
      title={labels.settingsTitle}
      kind="modules"
      save={{
        dirty: settingsDirty,
        persistent: true,
        pending: settingsPending,
        saved: settingsSaved,
        ...(settingsError === undefined ? {} : { error: settingsError }),
        ...(settingsConflict ? { conflict: {
          message: labels.settingsConflict,
          reloadLabel: labels.settingsReload,
          onReload: discardSettings,
        } } : {}),
        saveDisabled: !canManage || settingsRevision === null || !settingsValid,
        onSave: () => { void saveSettings(); },
        onDiscard: discardSettings,
        saveLabel: labels.save,
        discardLabel: labels.discard,
        savedLabel: labels.saved,
        pendingLabel: labels.saving,
      }}
    />
    <div className="points-settings__fields">
      {settingFields.map(([key, label, type]) => <Field
        key={key}
        {...(key === "dailyCap" ? { className: "points-settings__field--wide" } : {})}
        label={label}
        type="text"
        value={String(settingsDraft[key])}
        disabled={!canManage || settingsPending || settingsRevision === null}
        onChange={(value) => {
          setSettingsSaved(false);
          setSettingsEdit({
            revision: settingsDirty ? settingsEdit.revision : settingsRevision ?? 0,
            base: settingsDirty ? settingsEdit.base : settingsDraft,
            settings: { ...settingsDraft, [key]: type === "number" ? Number(value) : value },
          });
        }}
      />)}
    </div>
    {!canManage ? <p className="points-settings__hint">{labels.managementLocked}</p> : null}
  </section> : selected === null ? <div className="points-detail-empty">
    {accounts.length === 0 ? <>
      <p>{labels.emptyDetail}</p>
      <Button variant="neutral" onClick={createTimer}><Icon name="clock-hour-4" size={16} />{labels.timer}</Button>
    </> : <p>{labels.selectAccount}</p>}
  </div> : <section className="points-detail" aria-label={selected.login}>
    <header className="points-detail__header">
      <div className="points-detail__identity">
        <h2>{selected.login}</h2>
        <p className="points-detail__balance">{formatNumber(selectedBalance, locale)} <span>{settingsQuery.data?.settings.currencyName ?? DEFAULT_POINTS_SETTINGS.currencyName}</span></p>
        <p className="points-detail__meta">{rankQuery.data?.rank === null || (rankQuery.data === undefined && selected.monthNet === null)
          ? labels.noMonthGame(monthLabel(month, locale))
          : labels.monthNet(rankQuery.data?.net ?? selected.monthNet ?? 0, monthLabel(month, locale), rankQuery.data?.rank ?? null)}</p>
      </div>
      <div className="points-detail__header-actions">
        <SaveStatus
          dirty={correctionDirty}
          persistent
          pending={adjustPending}
          {...(selectedCorrection.error === undefined ? {} : { error: selectedCorrection.error })}
          saved={selectedCorrection.status === labels.saved && !correctionDirty}
          warnings={correctionWarnings}
          warningStatusLabel={(warnings, justSaved) => justSaved ? labels.saved : warnings[0] ?? ""}
          saveDisabled={!canManage || adjustPending || (pendingAdjustment === null && !correctionValid)}
          discardDisabled={pendingAdjustment !== null || adjustPending}
          onSave={() => {
            if (pendingAdjustment === null) saveAdjustment();
            else void performAdjustment(selected.accountId, pendingAdjustment);
          }}
          onDiscard={() => {
            if (pendingAdjustment !== null || adjustPending) return;
            setDelta("");
            setReason("");
            updateCorrection(selected.accountId, { error: undefined, status: undefined });
          }}
          saveLabel={pendingAdjustment === null ? labels.save : labels.retry}
          discardLabel={labels.discard}
          savedLabel={labels.saved}
          pendingLabel={labels.saving}
        />
        <ActionMenu
          label={commonLabels.moreActions}
          items={[{ label: labels.settings, onSelect: () => {
            resetDetailDraft();
            setSettingsOpen(true);
            selectedIdRef.current = null;
            setSelectedAccount(null);
          } }]}
        />
      </div>
    </header>
    <section className="points-correction" aria-labelledby="points-correction-title">
      <h3 id="points-correction-title">{labels.correction}</h3>
      <div className="points-correction__fields">
        <Field label={labels.amount} value={delta} onChange={(value) => {
          setDelta(value);
          updateCorrection(selected.accountId, { error: undefined, status: undefined });
        }} disabled={!canManage || adjustPending || pendingAdjustment !== null} mono
          {...(newBalance < 0 ? { error: labels.negative } : balanceOverflow ? { error: labels.balanceOverflow } : {})} />
        <Field label={labels.reason} value={reason} onChange={(value) => {
          setReason(value);
          updateCorrection(selected.accountId, { error: undefined, status: undefined });
        }} disabled={!canManage || adjustPending || pendingAdjustment !== null} required
          {...(reason.trim().length > MAX_POINTS_ADJUSTMENT_REASON_LENGTH ? { error: labels.reasonTooLong } : {})} />
      </div>
      <p className={`points-correction__preview${newBalance < 0 || balanceOverflow ? " is-invalid" : ""}`} role="status">
        {balanceOverflow ? labels.balanceOverflow : labels.newBalance(newBalance, settingsQuery.data?.settings.currencyName ?? DEFAULT_POINTS_SETTINGS.currencyName)}
      </p>
    </section>
    <section className="points-history" aria-labelledby="points-history-title">
      <h3 id="points-history-title">{labels.history}</h3>
      <ListPaginationFooter loadedCount={history.length} loadedLabel={labels.historyEntries}>
        <Button variant="neutral" size="compact" disabled={historyCursorStack.length === 0} onClick={() => {
          const stack = historyCursorStack.slice(0, -1);
          setHistoryCursorStack(stack);
          setHistoryCursor(stack.at(-1));
        }}>{labels.previous}</Button>
        <Button variant="neutral" size="compact" disabled={historyQuery.data?.cursor === undefined} onClick={() => {
          const next = historyQuery.data?.cursor;
          if (next === undefined) return;
          setHistoryCursorStack((stack) => [...stack, next]);
          setHistoryCursor(next);
        }}>{labels.next}</Button>
      </ListPaginationFooter>
      <div className="points-history__content" aria-live="polite">
        {historyQuery.isLoading || (historyQuery.isFetching && historyQuery.data === undefined)
          ? <p className="points-history__state" role="status">{labels.historyLoading}</p>
          : historyQuery.isError
            ? <div className="points-history__state points-history__state--error">
              <p role="alert">{labels.historyError}</p>
              <Button variant="neutral" disabled={historyQuery.isFetching} onClick={() => { void historyQuery.refetch(); }}>
                {labels.retry}
              </Button>
            </div>
            : <DataTable
              ariaLabel={labels.history}
              rows={history.map((row) => ({
                id: row.operationId,
                at: row.at,
                moduleGroup: row.moduleId,
                source: historySource(row, locale, resolveModuleName),
                delta: row.delta,
                balanceAfter: row.balanceAfter,
              }))}
              columns={[
                { key: "source", label: labels.source, render: (row) => row.source },
                { key: "delta", label: labels.movement, render: (row) => <span className="mono">{row.delta > 0 ? "+" : ""}{formatNumber(row.delta, locale)}</span>, width: "100px" },
                { key: "balance", label: labels.balanceAfter, render: (row) => <span className="mono">{formatNumber(row.balanceAfter, locale)}</span>, width: "110px" },
              ]}
              timeZone="UTC"
              emptyLabel={labels.historyEmpty}
              className="points-history__table"
            />}
      </div>
    </section>
  </section>;

  const toolbar = <ListToolbar
    className="points-list-toolbar"
    language={locale}
    searchLabel={labels.search}
    searchPlaceholder={labels.search}
    searchClearLabel={commonLabels.clearSearch}
    searchValue={search}
    onSearchChange={changeSearch}
    filtersLabel={labels.balance}
    filters={<SegmentChoice
      label={labels.balance}
      value={sort}
      onChange={changeSort}
      size="compact"
      options={[{ value: "balance", label: labels.balance }, { value: "month", label: labels.month }]}
    />}
    usage={{
      count: accounts.length,
      loaded: accountsQuery.data !== undefined,
      copy: {
        countSuffix: labels.accounts,
        filteredInfix: commonLabels.of,
        filteredSuffix: labels.accounts,
        limitInfix: commonLabels.of,
        limitSuffix: labels.accounts,
        loadedSuffix: labels.accounts,
      },
    }}
  />;

  const hasAccountPages = accountsQuery.data?.cursor !== undefined || accountCursorStack.length > 0;
  const list = accounts.length === 0 && !hasAccountPages ? null : <>
    {accounts.length === 0 ? <p className="points-list-empty">{labels.pageEmpty}</p> : <div className="points-account-list" role="list">
      {accounts.map((account: PointsAccount) => <button
        type="button"
        role="listitem"
        key={account.accountId}
        className="points-account-row"
        aria-selected={selectedId === account.accountId}
        aria-current={selectedId === account.accountId ? "true" : undefined}
        onClick={() => { selectAccount(account); }}
      >
        <span className="points-account-row__login">{account.login}</span>
        <span className="points-account-row__balance mono">{formatNumber(sort === "month" ? account.monthNet ?? 0 : account.balance, locale)}</span>
        <span className="points-account-row__meta">{account.monthNet === null
          ? labels.noMonthGame(monthLabel(month, locale))
          : labels.monthNet(account.monthNet, monthLabel(month, locale), null)}</span>
      </button>)}
    </div>}
    {hasAccountPages ? <ListPaginationFooter loadedCount={accounts.length} loadedLabel={labels.accounts}>
      <Button variant="neutral" size="compact" disabled={accountCursorStack.length === 0} onClick={() => {
        const stack = accountCursorStack.slice(0, -1);
        setAccountCursorStack(stack);
        setAccountCursor(stack.at(-1));
      }}>{labels.previous}</Button>
      <Button variant="neutral" size="compact" disabled={accountsQuery.data?.cursor === undefined} onClick={() => {
        const next = accountsQuery.data?.cursor;
        if (next === undefined) return;
        setAccountCursorStack((stack) => [...stack, next]);
        setAccountCursor(next);
      }}>{labels.next}</Button>
    </ListPaginationFooter> : null}
  </>;

  const header = <div className="points-page-actions">
    <span className="points-page-actions__meta" aria-hidden={summary === undefined}>
      {summary === undefined ? " " : `${formatNumber(summary.circulation, locale)} ${labels.inCirculation} · ${formatNumber(Object.values(summary.jackpots).reduce((sum, value) => sum + value, 0), locale)} ${labels.jackpot} · ${formatNumber(summary.inRounds, locale)} ${labels.inRounds}`}
    </span>
    <Button variant={settingsOpen ? "secondary" : "neutral"} ariaPressed={settingsOpen} onClick={() => {
      resetDetailDraft();
      setSettingsOpen((value) => !value);
      selectedIdRef.current = null;
      setSelectedAccount(null);
    }}>{labels.settings}</Button>
    <Button variant="neutral" onClick={createTimer}><Icon name="clock-hour-4" size={16} />{labels.timer}</Button>
  </div>;

  const commonPage = <CollectionPage
    title={labels.title}
    heading={header}
    toolbar={toolbar}
    list={list}
    detail={detail}
    empty={<p className="points-list-empty">{labels.noAccounts}</p>}
    detailOpen={selectedId !== null || settingsOpen}
    backLabel={labels.back}
    onCloseDetail={closeDetail}
  />;

  if (accountsQuery.isError || summaryQuery.isError) return <div className="points-error" role="alert">{labels.loadError}</div>;
  return <div className="points-page">
    {commonPage}
  </div>;
}

export default function PointsPanel(properties: ModulePanelProperties): ReactElement {
  return <PointsPanelContent key={properties.channelId} {...properties} />;
}
