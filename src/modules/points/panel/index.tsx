import { useCallback, useEffect, useState, type ReactElement } from "react";

import { useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
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
import { DEFAULT_POINTS_SETTINGS, pointsSettingsSchema } from "../contracts";
import type { PointsAccount, PointsHistoryRow } from "./service";
import { adjustPoints, loadPointsAccounts, loadPointsHistory, loadPointsRank, loadPointsSettings, loadPointsSummary, savePointsSettings } from "./service";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsEdit, setSettingsEdit] = useState<{ revision: number; settings: PointsSettings } | null>(null);
  const [settingsError, setSettingsError] = useState<string | undefined>();
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [adjustError, setAdjustError] = useState<string | undefined>();
  const [adjustStatus, setAdjustStatus] = useState<string | undefined>();
  const [adjustPending, setAdjustPending] = useState(false);
  const [pendingAdjustment, setPendingAdjustment] = useState<{ operationId: string; delta: number; reason: string } | null>(null);
  const [committedBalance, setCommittedBalance] = useState<number | null>(null);

  const accountsQuery = useModuleQuery(channelId, "points", `accounts:${sort}:${search}:${accountCursor ?? "first"}`,
    (signal) => loadPointsAccounts(channelId, sort, search, accountCursor, signal));
  const summaryQuery = useModuleQuery(channelId, "points", "summary", (signal) => loadPointsSummary(channelId, signal));
  const settingsQuery = useModuleQuery(channelId, "points", "settings", (signal) => loadPointsSettings(channelId, signal));
  const selected = accountsQuery.data?.rows.find((account) => account.accountId === selectedId) ?? null;
  const selectedBalance = selected === null ? 0 : committedBalance ?? selected.balance;
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
  const correctionValid = selected !== null && Number.isSafeInteger(deltaNumber) && delta.trim().length > 0 && deltaNumber !== 0 &&
    selected.balance + deltaNumber >= 0 && reason.trim().length > 0;
  // Once booked (audit pending), selectedBalance already includes the draft amount.
  const newBalance = committedBalance !== null || !Number.isSafeInteger(deltaNumber) ? selectedBalance : selectedBalance + deltaNumber;
  const settingsDataRevision = settingsQuery.data?.revision ?? null;
  const settingsRevision = settingsDataRevision === null
    ? settingsEdit?.revision ?? null
    : Math.max(settingsDataRevision, settingsEdit?.revision ?? settingsDataRevision);
  const settingsDraft = settingsEdit !== null && (settingsDataRevision === null || settingsEdit.revision >= settingsDataRevision)
    ? settingsEdit.settings
    : settingsQuery.data?.settings ?? DEFAULT_POINTS_SETTINGS;
  const settingsDirty = settingsQuery.data !== undefined && settingsRevision === settingsQuery.data.revision &&
    JSON.stringify(settingsDraft) !== JSON.stringify(settingsQuery.data.settings);
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
    setAdjustError(undefined);
    setAdjustStatus(undefined);
    setPendingAdjustment(null);
    setCommittedBalance(null);
  };

  const changeSearch = (value: string): void => {
    setSearch(value);
    resetAccountPage();
  };

  const changeSort = (value: "balance" | "month"): void => {
    setSort(value);
    resetAccountPage();
  };

  const selectAccount = (accountId: string): void => {
    if (selectedId !== accountId) resetDetailDraft();
    setSelectedId(accountId);
    setSettingsOpen(false);
  };

  const closeDetail = (): void => {
    resetDetailDraft();
    setSelectedId(null);
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
    if (!canManage || settingsRevision === null || settingsPending || !settingsDirty || !settingsValid) return;
    setSettingsPending(true);
    setSettingsError(undefined);
    setSettingsSaved(false);
    try {
      const result = await savePointsSettings(channelId, settingsRevision, settingsDraft);
      setSettingsEdit({ revision: result.revision, settings: result.settings });
      await queryClient.invalidateQueries({ queryKey: ["channel", channelId, "module", "points", "summary"] });
      await queryClient.invalidateQueries({ queryKey: ["channel", channelId, "module", "points", "settings"] });
      setSettingsSaved(true);
    } catch {
      setSettingsError(labels.settingsError);
    } finally {
      setSettingsPending(false);
    }
  }, [canManage, channelId, labels.settingsError, queryClient, settingsDirty, settingsDraft, settingsPending, settingsRevision, settingsValid]);

  const discardSettings = (): void => {
    if (settingsQuery.data === undefined) return;
    setSettingsEdit({ revision: settingsQuery.data.revision, settings: settingsQuery.data.settings });
    setSettingsError(undefined);
    setSettingsSaved(false);
  };

  const performAdjustment = useCallback(async (request: { operationId: string; delta: number; reason: string }): Promise<void> => {
    if (selected === null || !canManage || adjustPending) return;
    setAdjustPending(true);
    setAdjustError(undefined);
    setAdjustStatus(undefined);
    try {
      const result = await adjustPoints(channelId, selected.accountId, request.operationId, request.delta, request.reason);
      if (result.auditPending) {
        setCommittedBalance(result.balance);
        setPendingAdjustment(request);
        setAdjustStatus(labels.correctionBookedPending);
      } else {
        setCommittedBalance(null);
        await queryClient.invalidateQueries({ queryKey: ["channel", channelId, "module", "points"] });
        setPendingAdjustment(null);
        setAdjustStatus(labels.saved);
        setDelta("");
        setReason("");
      }
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      setAdjustError(code === "insufficient_balance" ? labels.negative : labels.correctionError);
    } finally {
      setAdjustPending(false);
    }
  }, [adjustPending, canManage, channelId, labels.correctionBookedPending, labels.correctionError, labels.negative, labels.saved, queryClient, selected]);

  const saveAdjustment = useCallback((): void => {
    if (!correctionValid) return;
    const request = { operationId: randomId(), delta: deltaNumber, reason: reason.trim() };
    setPendingAdjustment(request);
    void performAdjustment(request);
  }, [correctionValid, deltaNumber, performAdjustment, reason]);

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
  const correctionDirty = delta.trim().length > 0 || reason.trim().length > 0;
  const correctionWarnings = adjustStatus === undefined
    ? correctionDirty ? [labels.unsaved] : []
    : adjustStatus === labels.saved ? [] : [adjustStatus];
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
            revision: settingsRevision ?? 0,
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
          {...(adjustError === undefined ? {} : { error: adjustError })}
          saved={adjustStatus === labels.saved && !correctionDirty}
          warnings={correctionWarnings}
          warningStatusLabel={(warnings, justSaved) => justSaved ? labels.saved : warnings[0] ?? ""}
          saveDisabled={!canManage || (pendingAdjustment === null && !correctionValid)}
          discardDisabled={pendingAdjustment !== null}
          onSave={() => {
            if (pendingAdjustment === null) saveAdjustment();
            else void performAdjustment(pendingAdjustment);
          }}
          onDiscard={() => {
            if (pendingAdjustment !== null) return;
            setDelta("");
            setReason("");
            setAdjustError(undefined);
            setAdjustStatus(undefined);
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
            setSelectedId(null);
          } }]}
        />
      </div>
    </header>
    <section className="points-correction" aria-labelledby="points-correction-title">
      <h3 id="points-correction-title">{labels.correction}</h3>
      <div className="points-correction__fields">
        <Field label={labels.amount} value={delta} onChange={(value) => { setDelta(value); setAdjustError(undefined); setAdjustStatus(undefined); }} disabled={!canManage || adjustPending || pendingAdjustment !== null} mono {...(newBalance < 0 ? { error: labels.negative } : {})} />
        <Field label={labels.reason} value={reason} onChange={(value) => { setReason(value); setAdjustError(undefined); setAdjustStatus(undefined); }} disabled={!canManage || adjustPending || pendingAdjustment !== null} required />
      </div>
      <p className={`points-correction__preview${newBalance < 0 ? " is-invalid" : ""}`} role="status">
        {labels.newBalance(newBalance, settingsQuery.data?.settings.currencyName ?? DEFAULT_POINTS_SETTINGS.currencyName)}
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
      <DataTable
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
      />
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

  const list = accounts.length === 0 ? null : <>
    <div className="points-account-list" role="list">
      {accounts.map((account: PointsAccount) => <button
        type="button"
        role="listitem"
        key={account.accountId}
        className="points-account-row"
        aria-selected={selectedId === account.accountId}
        aria-current={selectedId === account.accountId ? "true" : undefined}
        onClick={() => { selectAccount(account.accountId); }}
      >
        <span className="points-account-row__login">{account.login}</span>
        <span className="points-account-row__balance mono">{formatNumber(sort === "month" ? account.monthNet ?? 0 : account.balance, locale)}</span>
        <span className="points-account-row__meta">{account.monthNet === null
          ? labels.noMonthGame(monthLabel(month, locale))
          : labels.monthNet(account.monthNet, monthLabel(month, locale), null)}</span>
      </button>)}
    </div>
    {accountsQuery.data?.cursor !== undefined || accountCursorStack.length > 0 ? <ListPaginationFooter loadedCount={accounts.length} loadedLabel={labels.accounts}>
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
      setSelectedId(null);
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
