import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { dashboardTexts } from "../../../dashboard/locale";
import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { Button, ChipsInput, ConfirmDialog, Dialog, Field, Icon, SaveStatus, SegmentChoice, Select, SwitchRow, UnitInput, registerDashboardNavigationGuard, useDraft, useDraftGuard } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { statisticsSettingsSchema, type StatisticsSettings, type StatisticsWordsResponse } from "../contracts";
import { loadStatisticsSettings, loadStatisticsWords, saveStatisticsSettings, statisticsSettingsErrorCode, type StatisticsSettingsState } from "./service";
import { statisticsWordsPanelTexts } from "./words-locale";
import "./words-panel.css";

const PAGE_SIZE = 100;
const SEARCH_DEBOUNCE_MILLISECONDS = 250;

const numberFormatter = (language: "de" | "en"): Intl.NumberFormat => new Intl.NumberFormat(
  language === "de" ? "de-DE" : "en-US",
  { maximumFractionDigits: 0 },
);

const formatRelativeTime = (date: string, language: "de" | "en"): string => {
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) return date;
  const elapsedSeconds = (timestamp - Date.now()) / 1_000;
  const absoluteSeconds = Math.abs(elapsedSeconds);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = absoluteSeconds < 60
    ? [Math.round(elapsedSeconds), "second"]
    : absoluteSeconds < 3_600
      ? [Math.round(elapsedSeconds / 60), "minute"]
      : absoluteSeconds < 86_400
        ? [Math.round(elapsedSeconds / 3_600), "hour"]
        : [Math.round(elapsedSeconds / 86_400), "day"];
  return new Intl.RelativeTimeFormat(language === "de" ? "de" : "en", { numeric: "auto", style: "short" }).format(value, unit);
};

const shareFormatter = (language: "de" | "en"): Intl.NumberFormat => new Intl.NumberFormat(
  language === "de" ? "de-DE" : "en-US",
  { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 },
);

/** Chips keep the typed spelling; the server and the list filter fold it only when matching. */
const typedStatisticsWord = (word: string): string => word.normalize("NFKC").toLowerCase();

const skeletonRows = Array.from({ length: 12 }, (_unused, index) => index);

export function StatisticsWordsPanel({ channelId, language = "de", canManage = false, headerActionsTarget }: ModulePanelProperties): ReactElement {
  const labels = statisticsWordsPanelTexts(language);
  const [settingsDialog, setSettingsDialog] = useState<"ignoredWords" | "wordCommand" | null>(null);
  const queryClient = useDashboardQueryClient();
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [hideFillers, setHideFillers] = useState(true);
  const [scope, setScope] = useState<"stream" | "total">("total");
  const [page, setPage] = useState(1);
  const settingsDraft = useDraft<StatisticsSettings>(statisticsSettingsSchema.parse({}));
  const settingsRevision = useRef<number | undefined>(undefined);
  const [settingsPending, setSettingsPending] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string>();
  const settingsQuery = useModuleQuery<StatisticsSettingsState>(
    channelId,
    "statistics",
    "words-settings",
    (signal) => loadStatisticsSettings(channelId, signal),
  );

  useEffect(() => {
    if (settingsQuery.data === undefined || settingsDraft.dirty) return;
    settingsDraft.accept(settingsQuery.data.settings);
    settingsRevision.current = settingsQuery.data.revision;
  }, [settingsDraft.accept, settingsDraft.dirty, settingsQuery.data]);

  useEffect(() => {
    // An unchanged search must not reset the page: on mount the first run would otherwise jump back to page 1.
    if (searchDraft === search) return undefined;
    const timer = window.setTimeout(() => {
      setSearch(searchDraft);
      setPage(1);
    }, SEARCH_DEBOUNCE_MILLISECONDS);
    return () => window.clearTimeout(timer);
  }, [searchDraft, search]);

  const queryPart = `words:${JSON.stringify([page, search, hideFillers, scope])}`;
  const wordsQuery = useModuleQuery<StatisticsWordsResponse>(
    channelId,
    "statistics",
    queryPart,
    (signal) => loadStatisticsWords(channelId, page, search, hideFillers, signal, scope),
  );
  const data = wordsQuery.data;
  const rows = data?.words ?? [];
  const maxCount = data?.maxCount ?? 0;
  const formatNumber = numberFormatter(language);
  const formatShare = shareFormatter(language);
  const start = data === undefined || data.total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = data === undefined ? 0 : Math.min(page * PAGE_SIZE, data.total);
  const pageSummary = data === undefined
    ? ""
    : labels.pageSummary(formatNumber.format(start), formatNumber.format(end), formatNumber.format(data.total));
  const emptyTitle = data?.totalCount === 0 ? labels.emptyTitle : labels.noMatchesTitle;
  const emptyDescription = data?.totalCount === 0 ? labels.emptyDescription : labels.noMatchesDescription;
  const updateIgnoredWords = (values: string[]): void => {
    setSettingsSaved(false);
    setSettingsSaveError(undefined);
    settingsDraft.setValue((current) => ({ ...current, ignoredWords: values }));
  };
  const discardSettings = useCallback((): void => {
    settingsDraft.reset();
    setSettingsSaved(false);
    setSettingsSaveError(undefined);
  }, [settingsDraft.reset]);
  const saveSettings = async (): Promise<string | null> => {
    const baselineRevision = settingsRevision.current;
    if (!canManage || !settingsDraft.dirty || settingsPending || baselineRevision === undefined) return null;
    setSettingsPending(true);
    setSettingsSaved(false);
    setSettingsSaveError(undefined);
    try {
      const result = await runModuleQueryWrite(
        queryClient,
        channelId,
        "statistics",
        "words-settings",
        (revision) => saveStatisticsSettings(channelId, revision ?? baselineRevision, settingsDraft.value),
        {
          baselineRevision,
          updateCache: (_current, saved) => saved,
          relatedParts: [{ moduleId: "statistics", part: queryPart }],
        },
      );
      settingsDraft.accept(result.settings);
      settingsRevision.current = result.revision;
      setSettingsSaved(true);
      return null;
    } catch (error: unknown) {
      const message = statisticsSettingsErrorCode(error) === "conflict" ? labels.settingsConflict : labels.settingsSaveError;
      setSettingsSaveError(message);
      return message;
    } finally {
      setSettingsPending(false);
    }
  };
  const draftGuard = useDraftGuard(settingsDraft.dirty, saveSettings, discardSettings);
  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);
  const navigationLabels = dashboardTexts(language).module;
  const closeSettingsDialog = (): void => { draftGuard.guardSwitch(() => { setSettingsDialog(null); }); };
  const hiddenCount = settingsQuery.data?.settings.ignoredWords.length ?? 0;
  const hiddenButton = <Button variant="neutral" icon="eye-off" ariaHasPopup="dialog" ariaExpanded={settingsDialog === "ignoredWords"} onClick={() => { setSettingsDialog("ignoredWords"); }}>
    {labels.hiddenWordsButton(formatNumber.format(hiddenCount))}
  </Button>;
  const wordCommandButton = <Button variant="neutral" icon="tabMessages" ariaHasPopup="dialog" ariaExpanded={settingsDialog === "wordCommand"} onClick={() => { setSettingsDialog("wordCommand"); }}>
    {labels.wordCommandSettingsButton}
  </Button>;
  const headerButtons = <div className="statistics-words__header-buttons">{hiddenButton}{wordCommandButton}</div>;
  const wordCommand = settingsDraft.value.wordCommand;
  const validCommandToken = /^![a-z0-9_]{2,24}$/u.test(wordCommand.command);
  const settingsDisabled = !canManage || settingsPending || settingsQuery.data === undefined;
  const statusOptions = [
    ["everyone", labels.chatStatusEveryone],
    ["subscriber", labels.chatStatusSubscriber],
    ["vip", labels.chatStatusVip],
    ["moderator", labels.chatStatusModerator],
    ["broadcaster", labels.chatStatusBroadcaster],
  ] as const;

  return <section className="statistics-words" aria-label={labels.title}>
    {headerActionsTarget === undefined ? headerButtons : headerActionsTarget === null ? null : createPortal(headerButtons, headerActionsTarget)}
    <Dialog
      opened={settingsDialog !== null}
      title={settingsDialog === "wordCommand" ? labels.wordCommandSettingsTitle : labels.ignoredWordsTitle}
      onClose={closeSettingsDialog}
      pending={settingsPending}
      className="statistics-words__dialog"
    >
      <div className="statistics-words__dialog-body">
        <p className="statistics-words__dialog-description">
          {settingsDialog === "wordCommand" ? labels.wordCommandSettingsDescription : labels.ignoredWordsDescription}
        </p>
        <div className="statistics-words__settings-error-slot">
          {settingsQuery.isError ? <div className="statistics-words__settings-error" role="alert">
            <span>{labels.settingsLoadError}</span>
            <Button variant="subtle" onClick={() => { void settingsQuery.refetch(); }}>{labels.retrySettings}</Button>
          </div> : null}
        </div>
        {settingsDialog === "wordCommand" ? <div className="statistics-words__word-command-fields" aria-busy={settingsQuery.isLoading}>
          <SwitchRow
            label={labels.wordCommandEnabled}
            description={labels.wordCommandEnabledDescription}
            checked={wordCommand.enabled}
            disabled={settingsDisabled}
            onChange={(enabled) => {
              setSettingsSaved(false);
              settingsDraft.setValue((current) => ({ ...current, wordCommand: { ...current.wordCommand, enabled } }));
            }}
          />
          <Field
            label={labels.wordCommandToken}
            hint={labels.wordCommandTokenHint}
            {...(validCommandToken ? {} : { error: labels.wordCommandTokenError })}
            value={wordCommand.command}
            onChange={(command) => {
              setSettingsSaved(false);
              settingsDraft.setValue((current) => ({
                ...current,
                wordCommand: { ...current.wordCommand, command: command.toLowerCase() },
              }));
            }}
            disabled={settingsDisabled}
            spellCheck={false}
            mono
          />
          <div className="statistics-words__number-fields">
            <UnitInput
              label={labels.wordCommandCooldown}
              unit="s"
              min={0}
              max={3_600}
              value={wordCommand.cooldownSeconds}
              disabled={settingsDisabled}
              onChange={(value) => {
                setSettingsSaved(false);
                const cooldownSeconds = value === "" ? 0 : value;
                settingsDraft.setValue((current) => ({ ...current, wordCommand: { ...current.wordCommand, cooldownSeconds } }));
              }}
            />
            <UnitInput
              label={labels.wordCommandUserCooldown}
              unit="s"
              min={0}
              max={3_600}
              value={wordCommand.userCooldownSeconds}
              disabled={settingsDisabled}
              onChange={(value) => {
                setSettingsSaved(false);
                const userCooldownSeconds = value === "" ? 0 : value;
                settingsDraft.setValue((current) => ({ ...current, wordCommand: { ...current.wordCommand, userCooldownSeconds } }));
              }}
            />
          </div>
          <Select
            label={labels.wordCommandMinimumStatus}
            value={wordCommand.minimumChatStatus}
            disabled={settingsDisabled}
            options={statusOptions.map(([value, label]) => ({ value, label }))}
            onChange={(value) => {
              const minimumChatStatus = statusOptions.find(([option]) => option === value)?.[0];
              if (minimumChatStatus === undefined) return;
              setSettingsSaved(false);
              settingsDraft.setValue((current) => ({ ...current, wordCommand: { ...current.wordCommand, minimumChatStatus } }));
            }}
          />
        </div> : <div aria-busy={settingsQuery.isLoading} className="statistics-words__ignored-input">
          <ChipsInput
            label={labels.ignoredWordsLabel}
            values={settingsDraft.value.ignoredWords}
            onChange={updateIgnoredWords}
            placeholder={labels.ignoredWordsPlaceholder}
            normalize={typedStatisticsWord}
            validate={(word) => Array.from(word).length <= 40 ? null : labels.ignoredWordsLimit}
            removeLabel={labels.removeIgnoredWord}
            disabled={settingsDisabled}
            messages={labels.ignoredWordsMessages}
            listLabel={labels.ignoredWordsList}
            max={200}
          />
        </div>}
        <div className="statistics-words__save">
          <SaveStatus
            persistent
            dirty={settingsDraft.dirty}
            pending={settingsPending}
            saved={settingsSaved}
            {...(settingsSaveError === undefined ? {} : { error: settingsSaveError })}
            invalid={!validCommandToken && settingsDialog === "wordCommand"}
            invalidMessage={labels.wordCommandTokenError}
            saveDisabled={settingsDisabled || settingsDialog === "wordCommand" && !validCommandToken}
            discardDisabled={settingsQuery.data === undefined}
            onSave={() => { void saveSettings(); }}
            onDiscard={discardSettings}
            saveLabel={labels.save}
            discardLabel={labels.discard}
            savedLabel={labels.saved}
            pendingLabel={labels.saving}
          />
        </div>
      </div>
    </Dialog>
    <div className="statistics-words__controls">
      <Field
        className="statistics-words__search"
        label={labels.search}
        ariaLabel={labels.search}
        clearLabel={labels.clearSearch}
        variant="search"
        value={searchDraft}
        placeholder={labels.searchPlaceholder}
        onChange={(value) => setSearchDraft(value.slice(0, 80))}
      />
      <div className="statistics-words__scope">
        <SegmentChoice
          label={labels.scope}
          size="compact"
          value={scope}
          options={[
            { value: "stream", label: labels.thisStream },
            { value: "total", label: labels.totalScope },
          ]}
          onChange={(next) => {
            setScope(next);
            setPage(1);
          }}
        />
      </div>
      <div className="statistics-words__filler-toggle">
        <SwitchRow
          label={labels.hideFillers}
          checked={hideFillers}
          onChange={(checked) => {
            setHideFillers(checked);
            setPage(1);
          }}
        />
      </div>
      <div className="statistics-words__privacy-note" role="note">
        <Icon name="info" />
        <span>{labels.privacyNote}</span>
      </div>
      <div className="statistics-words__paging">
        <span className="statistics-words__range" aria-live="polite">{pageSummary}</span>
        <button
          type="button"
          aria-label={labels.previousPage}
          disabled={page <= 1 || wordsQuery.isFetching}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          <Icon name="chevron-left" size={20} />
        </button>
        <button
          type="button"
          aria-label={labels.nextPage}
          disabled={data === undefined || page >= data.totalPages || wordsQuery.isFetching}
          onClick={() => setPage((current) => current + 1)}
        >
          <Icon name="chevron-right" size={20} />
        </button>
      </div>
    </div>
    <div className="statistics-words__table-scroll" aria-busy={wordsQuery.isLoading}>
      <table className="statistics-words__table" aria-label={labels.title} aria-describedby="statistics-words-rank-context">
        <colgroup>
          <col className="statistics-words__column--rank" />
          <col className="statistics-words__column--word" />
          <col className="statistics-words__column--count" />
          <col className="statistics-words__column--share" />
          <col className="statistics-words__column--last-seen" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="statistics-words__heading--number">{labels.rank}</th>
            <th scope="col">{labels.word}</th>
            <th scope="col" className="statistics-words__heading--number">{labels.count}</th>
            <th scope="col">{labels.share}</th>
            <th scope="col" className="statistics-words__last-seen-heading">{labels.lastSeen}</th>
          </tr>
        </thead>
        <tbody>
          {wordsQuery.isLoading ? skeletonRows.map((row) => <tr key={row} aria-hidden="true">
            <td><span className="statistics-words__skeleton statistics-words__skeleton--short" /></td>
            <td><span className="statistics-words__skeleton" /></td>
            <td><span className="statistics-words__skeleton statistics-words__skeleton--short" /></td>
            <td><span className="statistics-words__skeleton statistics-words__skeleton--bar" /></td>
            <td className="statistics-words__last-seen"><span className="statistics-words__skeleton statistics-words__skeleton--short" /></td>
          </tr>) : wordsQuery.isError ? <tr>
            <td colSpan={5} className="statistics-words__empty-cell">
              <div className="statistics-words__empty" role="alert">
                <strong>{labels.loadError}</strong>
                <button type="button" onClick={() => { void wordsQuery.refetch(); }}>{labels.retry}</button>
              </div>
            </td>
          </tr> : rows.length === 0 ? <tr>
            <td colSpan={5} className="statistics-words__empty-cell">
              <div className="statistics-words__empty">
                <strong>{emptyTitle}</strong>
                <p>{emptyDescription}</p>
              </div>
            </td>
          </tr> : rows.map((word) => {
            const percentage = formatShare.format(word.share);
            const relativeCount = maxCount === 0 ? 0 : Math.min(100, word.count / maxCount * 100);
            const relativeLastSeen = formatRelativeTime(word.lastSeenAt, language);
            return <tr key={word.word}>
              <td className="statistics-words__rank">{formatNumber.format(word.rank)}</td>
              <td className="statistics-words__word-cell">
                <span className="statistics-words__word">{word.word}</span>
                <time className="statistics-words__word-last-seen" dateTime={word.lastSeenAt} aria-label={`${labels.lastSeen}: ${relativeLastSeen}`}>
                  {relativeLastSeen}
                </time>
              </td>
              <td className="statistics-words__count">{formatNumber.format(word.count)}</td>
              <td className="statistics-words__share-cell">
                <span className="statistics-words__share" role="img" aria-label={labels.shareBar(percentage)}>
                  <span className="statistics-words__share-track" aria-hidden="true">
                  <span className="statistics-words__share-fill" style={{ width: `${relativeCount.toString()}%` }} />
                  </span>
                  <span className="statistics-words__share-value">{percentage}</span>
                </span>
              </td>
              <td className="statistics-words__last-seen">
                <time dateTime={word.lastSeenAt}>{relativeLastSeen}</time>
              </td>
            </tr>;
          })}
        </tbody>
      </table>
    </div>
    <span className="sr-only" id="statistics-words-rank-context">{labels.rankContext}</span>
    <ConfirmDialog
      opened={draftGuard.confirmOpen}
      title={navigationLabels.unsavedChangesTitle}
      description={navigationLabels.unsavedChangesDescription}
      confirmLabel={navigationLabels.discardAndSwitch}
      cancelLabel={navigationLabels.continueEditing}
      onConfirm={draftGuard.discardAndSwitch}
      onCancel={draftGuard.continueEditing}
      {...(canManage ? { alternative: { label: navigationLabels.saveAndSwitch, onClick: () => { void draftGuard.saveAndSwitch(); } } } : {})}
      pending={draftGuard.saving || settingsPending}
      {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
      danger
    />
  </section>;
}
