import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement, type ReactNode } from "react";

import { MODULES } from "../modules/registry";
import type { ModulePanelProperties } from "../modules/contract";
import type { BelaboxSettings } from "../modules/belabox/contracts";
import type { BelaboxStatusResponse } from "../modules/belabox/contracts";
import { textCommandListChatCommand } from "../modules/text_commands/contracts/chat-commands";
import type { TextCommandPanelData } from "../modules/text_commands/panel/service";
import { loadModulePanel, loadModuleSettingsEditor, ModuleChunkLoadError, retryModuleChunkLoad } from "./module-panel-loaders";
import { RetryableLazy } from "./RetryableLazy";
import { canManage, type ChannelRole } from "../contracts/values";
import type { PanelActiveModule, PanelModuleState, PanelTemplateWarning } from "../panel-contract";
import { PanelApiError, getChannelModuleSettings, saveChannelModuleSettings, setChannelModuleEnabled } from "./api";
import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "./data";
import { apiErrorText, dashboardCommonTexts, dashboardLanguage, dashboardTexts, formatNumber, serverFieldErrorText, type DashboardLanguage } from "./locale";
import { moduleDescription, moduleName, moduleScopePurpose, moduleWorkspaceTexts, statusWord } from "./module-labels";
import { templateTextLength } from "../template";
import { modulePermissionsAreMissing } from "./channel-health";
import { dashboardRoutePath, type DashboardRoute } from "./router";
import { effectivePanelTemplateVariables, panelTemplateOptions, type PanelChannelVariable } from "./ui/template-variable-options";
import { ChatCommandsHelp, ConfirmDialog, EditorShell, Icon, ListRow, LoadState, LoadStateLines, NavigationIcon, notify, PageHeader, registerDashboardNavigationGuard, SettingsEditor, SettingsPage, StatusLed, LockedReason, mapServerFieldErrors, textFieldLength, useDraftGuard, type EditorInvalidField, type EditorSection, type SettingsEditorDefinition, type SettingsEditorSpec, type TemplateTextFieldVariable, type StatusLedState } from "./ui";
import { useDraft } from "./ui/useDraft";
import { useChannelSettings } from "./data/channel-settings";
import { Switch as SwitchPrimitive } from "./ui/primitives/switch";
import { worstCaseTemplateLength } from "../template";
import type { TemplateVariable } from "../template";

const workspaceTexts = moduleWorkspaceTexts;

type BelaboxSettingsPanelProperties = ModulePanelProperties & Pick<BelaboxSettings, "lowBitrateKbps" | "recoverBitrateKbps"> & {
  statsUrlDraft: string;
  onStatsUrlDraftChange: (value: string) => void;
  settingsRevision: number;
  onSettingsRevisionChange: (revision: number) => void;
  onRemovePendingChange: (pending: boolean) => void;
  savingSettings: boolean;
};

const moduleDetails = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): { name: string; description: string } => ({
  name: moduleName(moduleId, language),
  description: moduleDescription(moduleId, language) ?? workspaceTexts(language).noDescription,
});

export type StateTone = "healthy" | "warning" | "error" | "neutral";

export { NavigationIcon } from "./ui/NavigationIcon";

const iconFor = (moduleId: string, className = "module-glyph"): ReactElement => {
  const paths = MODULES.find((module) => module.id === moduleId)?.panelIcon?.paths ?? ["M5 5h14v14H5z", "M9 12h6", "M12 9v6"];
  const glyphClassName = className === "module-glyph" ? className : `module-glyph ${className}`;
  return (
    <svg className={glyphClassName} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {paths.map((path, index) => <path key={`${moduleId}-${String(index)}`} d={path} />)}
    </svg>
  );
};

export const ModuleIcon = ({ moduleId, className }: { moduleId: string; className?: string }): ReactElement => iconFor(moduleId, className);

const TextCommandChatCommandHelp = ({ channelId }: { channelId: string }): ReactElement | null => {
  const language = dashboardLanguage();
  const commandsQuery = useModuleQuery<TextCommandPanelData>(
    channelId,
    "text_commands",
    "commands",
    (signal) => import("../modules/text_commands/panel/service").then(({ loadTextCommandData }) => loadTextCommandData(channelId, signal)),
  );
  const listCommand = commandsQuery.data?.commands.find(({ kind }) => kind === "list");
  if (listCommand === undefined) {
    return commandsQuery.data === undefined
      ? <ChatCommandsHelp
        commands={[]}
        language={language}
        loadingLabel={dashboardTexts(language).module.chatCommandsButtonLabel(formatNumber(1, language))}
      />
      : null;
  }
  return <ChatCommandsHelp commands={[textCommandListChatCommand(listCommand.name)]} language={language} />;
};

export const StateRow = ({ label, tone, word, detail, action, icon }: {
  label: string;
  tone: StateTone;
  word: string;
  detail?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}): ReactElement => {
  const state: StatusLedState = tone === "healthy" ? "ok" : tone === "warning" ? "warn" : tone === "error" ? "error" : "off";
  return (
    <article className="state-row" data-status={tone} aria-label={label}>
      <strong className="state-row__label">{icon}{label}</strong>
      <StatusLed state={state} label={word} />
      {detail === undefined ? null : <span className="state-row__detail">{detail}</span>}
      {action === undefined ? null : <div className="state-row__action">{action}</div>}
    </article>
  );
};

const LockedModuleStatus = ({ status, reason }: { status: string; reason: string }): ReactElement => (
  <span className="module-locked-status" aria-label={`${status}: ${reason}`} aria-description={reason} title={reason}>
    <Icon name="lock" size={16} className="module-locked-status__icon" />
    <span>{status}</span>
  </span>
);

export const ModuleHeading = ({ kind, title, subtitle, actions }: {
  kind: string;
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
}): ReactElement => <PageHeader kind={kind} title={title} subtitle={subtitle} actions={actions} />;

export const ModuleCount = ({ count, label }: { count: number; label: (formattedCount: string) => string }): ReactElement => {
  const formattedCount = formatNumber(count);
  return <>{<span className="number">{formattedCount}</span>}{label(formattedCount).slice(formattedCount.length)}</>;
};

export const ModuleTile = ({ channelId, moduleId, enabled, onNavigate, name, icon, route, ledStatus, ledLabel }: {
  channelId: string;
  moduleId: string;
  enabled: boolean;
  onNavigate: (route: DashboardRoute) => void;
  name?: string;
  icon?: ReactElement;
  route?: DashboardRoute;
  ledStatus?: StatusLedState;
  ledLabel?: string;
}): ReactElement => {
  const details = moduleDetails(moduleId);
  const tileRoute: DashboardRoute = route ?? { kind: "module", channelId, moduleId };
  const tileName = name ?? details.name;
  const tileStatus = ledStatus ?? (enabled ? "ok" : "off");
  const tileLabel = ledLabel ?? statusWord(enabled);
  const label = `${tileName} · ${tileLabel}`;
  return (
    <a
      className="module-tile"
      href={dashboardRoutePath(tileRoute)}
      aria-label={label}
      data-enabled={enabled ? "true" : "false"}
      data-status={tileStatus}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(tileRoute);
      }}
    >
      <span className="module-tile__icon" aria-hidden="true">{icon ?? iconFor(moduleId)}</span>
      <strong>{tileName}</strong>
      <StatusLed state={tileStatus} label={tileLabel} />
    </a>
  );
};

/** Compatibility navigation component for older module tests; the pages use the tile grid. */
export const ModuleNavigation = ({ channelId, activeModules, onNavigate }: {
  channelId: string;
  activeModules: PanelActiveModule[];
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => (
  <nav className="module-navigation" aria-label={dashboardTexts().module.module}>
    {activeModules.map(({ moduleId }) => {
      const route: DashboardRoute = { kind: "module", channelId, moduleId };
      return <a className="nav-link" href={dashboardRoutePath(route)} key={moduleId} onClick={(event) => { event.preventDefault(); onNavigate(route); }}>{moduleName(moduleId)}</a>;
    })}
  </nav>
);

interface ModulePanelMountProperties {
  channelId: string;
  activeModules: PanelActiveModule[];
  streamSessionIdentity?: string;
  suspendModuleId?: string;
  canManage?: boolean;
  canOperate?: boolean;
  botIsModerator?: boolean | null;
  /** Deep-link target from the command palette (#164); passed through to the panel unchanged. */
  initialSelection?: string;
}

interface ModuleSettingsPageOptions {
  title: string;
  subtitle: string;
  icon: ReactNode;
  active: boolean;
  onToggle: (active: boolean) => void;
  switchDisabled: boolean;
  switchBusy: boolean;
  lockHint?: string;
  onNavigate: (route: DashboardRoute) => void;
}

const ModuleSettingsEditor = ({ module, channelId, canManageContent, language, page }: {
  module: (typeof MODULES)[number];
  channelId: string;
  canManageContent: boolean;
  language: DashboardLanguage;
  page?: ModuleSettingsPageOptions;
}): ReactElement | null => module.settingsEditor === undefined ? null : <ModuleSettingsEditorQuery
  key={`${channelId}:${module.id}`}
  module={module}
  channelId={channelId}
  canManageContent={canManageContent}
  language={language}
  {...(page === undefined ? {} : { page })}
/>;

const withModuleDraftFields = (moduleId: string, settings: Record<string, unknown>): Record<string, unknown> =>
  moduleId === "belabox" ? { ...settings, belaboxStatsUrl: "" } : settings;

const persistedSettings = (moduleId: string, settings: Record<string, unknown>): Record<string, unknown> => {
  if (moduleId !== "belabox") return settings;
  const persisted = { ...settings };
  delete persisted.belaboxStatsUrl;
  return persisted;
};

const ModuleSettingsEditorQuery = ({ module, channelId, canManageContent, language, page }: {
  module: (typeof MODULES)[number];
  channelId: string;
  canManageContent: boolean;
  language: DashboardLanguage;
  page?: ModuleSettingsPageOptions;
}): ReactElement => {
  const [generation, setGeneration] = useState(0);
  const queryClient = useDashboardQueryClient();
  const settingsQuery = useModuleQuery(channelId, module.id, "settings", async (signal) => {
    if (module.settingsEditor === undefined) throw new Error("Module settings editor is unavailable.");
    const definitionPromise = loadModuleSettingsEditor(module.id);
    if (definitionPromise === null) throw new Error("Module settings editor is unavailable.");
    const [definition, response] = await Promise.all([
      definitionPromise,
      getChannelModuleSettings(channelId, module.id, signal),
    ]);
    return { definition: definition.default, settings: response.settings, revision: response.revision, variables: response.variables };
  });
  const loaded = settingsQuery.data;
  const loadError = settingsQuery.error instanceof PanelApiError
    ? apiErrorText(settingsQuery.error.code, dashboardTexts().module.settingsLoadError)
    : dashboardTexts().module.settingsLoadError;
  const retrySettingsQuery = (): void => {
    if (settingsQuery.error instanceof ModuleChunkLoadError) retryModuleChunkLoad();
    else void settingsQuery.refetch();
  };
  if (loaded === undefined) {
    const state = <LoadState
      variant="panel-320"
      status={settingsQuery.isPending || settingsQuery.isFetching ? "loading" : "error"}
      loading={<LoadStateLines rows={3} height={34} />}
      empty={null}
      error={null}
      queryError={{ title: dashboardTexts().errors.dataLoadFailed, message: loadError, onRetry: retrySettingsQuery }}
      refreshError={false}
    >{null}</LoadState>;
    return page === undefined ? state : <SettingsPage
      kind="modules"
      title={page.title}
      subtitle={page.subtitle}
      icon={page.icon}
      {...(module.id === "belabox" ? { className: "settings-page--belabox" } : {})}
      active={page.active}
      onToggle={page.onToggle}
      switchDisabled={page.switchDisabled}
      switchBusy={page.switchBusy}
      {...(page.lockHint === undefined ? {} : { lockHint: page.lockHint })}
      overflow={<ModuleListLink channelId={channelId} onNavigate={page.onNavigate} />}
      columns={[state]}
    />;
  }
  const copy = loaded.definition.locales[language];
  return <LoadState
    variant="panel-320"
    status="success"
    loading={<LoadStateLines rows={3} height={34} />}
    empty={null}
    error={<p className="muted" role="alert">{dashboardTexts().module.settingsLoadError}</p>}
    queryError={{ title: dashboardTexts().errors.dataLoadFailed, message: loadError, onRetry: retrySettingsQuery }}
    refreshError={settingsQuery.isRefetchError}
  >
    <LoadedModuleSettingsEditor
      key={`${module.id}-${String(generation)}`}
      module={module}
      channelId={channelId}
      canManageContent={canManageContent}
      language={language}
      definition={loaded.definition}
      copy={copy}
      retryLabel={dashboardCommonTexts(language).retry}
      channelVariables={loaded.variables}
      initial={loaded.settings}
      initialRevision={loaded.revision}
      {...(page === undefined ? {} : { page })}
      onReload={async () => {
        try {
          await refetchModuleQueryData(queryClient, channelId, module.id, "settings");
          setGeneration((current) => current + 1);
          return true;
        } catch {
          return false;
        }
      }}
    />
  </LoadState>;
};

const AdsSettingsPanelMount = ({ module, channelId, language, canManageContent, moduleActive }: {
  module: (typeof MODULES)[number];
  channelId: string;
  language: DashboardLanguage;
  canManageContent: boolean;
  moduleActive: boolean;
}): ReactElement => {
  const loadPanel = useCallback(() => loadModulePanel(module) as Promise<{ default: ComponentType<ModulePanelProperties> }>, [module]);
  return <RetryableLazy
    instanceKey="ads:settings-panel"
    load={loadPanel}
    properties={{ channelId, language, canManage: canManageContent, canOperate: true, moduleActive }}
    loadingFallback={<LoadStateLines rows={5} height={34} />}
    renderError={(retry) => <LoadState
      variant="panel-320"
      status="error"
      loading={null}
      empty={null}
      error={null}
      queryError={{ title: dashboardTexts().errors.dataLoadFailed, message: dashboardTexts().module.componentLoadError, onRetry: retry }}
    >{null}</LoadState>}
    onRetry={retryModuleChunkLoad}
  />;
};

const BelaboxSettingsPanelMount = ({ module, channelId, language, canManageContent, lowBitrateKbps, recoverBitrateKbps,
  statsUrlDraft, onStatsUrlDraftChange, settingsRevision, onSettingsRevisionChange, onRemovePendingChange, savingSettings }: {
  module: (typeof MODULES)[number];
  channelId: string;
  language: DashboardLanguage;
  canManageContent: boolean;
  lowBitrateKbps: number;
  recoverBitrateKbps: number;
  statsUrlDraft: string;
  onStatsUrlDraftChange: (value: string) => void;
  settingsRevision: number;
  onSettingsRevisionChange: (revision: number) => void;
  onRemovePendingChange: (pending: boolean) => void;
  savingSettings: boolean;
}): ReactElement => {
  const loadPanel = useCallback(() => loadModulePanel(module) as Promise<{ default: ComponentType<BelaboxSettingsPanelProperties> }>, [module]);
  return <RetryableLazy
    instanceKey="belabox:settings-panel"
    load={loadPanel}
    properties={{ channelId, language, canManage: canManageContent, canOperate: true, lowBitrateKbps, recoverBitrateKbps,
      statsUrlDraft, onStatsUrlDraftChange, settingsRevision, onSettingsRevisionChange, onRemovePendingChange, savingSettings }}
    loadingFallback={<LoadStateLines rows={5} height={34} />}
    renderError={(retry) => <LoadState
      variant="panel-320"
      status="error"
      loading={null}
      empty={null}
      error={null}
      queryError={{ title: dashboardTexts().errors.dataLoadFailed, message: dashboardTexts().module.componentLoadError, onRetry: retry }}
    >{null}</LoadState>}
    onRetry={retryModuleChunkLoad}
  />;
};

const LoadedModuleSettingsEditor = ({ module, channelId, canManageContent, language, definition, copy, retryLabel, channelVariables, initial, initialRevision, onReload, page }: {
  module: (typeof MODULES)[number];
  channelId: string;
  canManageContent: boolean;
  language: DashboardLanguage;
  definition: SettingsEditorDefinition<Record<string, unknown>>;
  copy: SettingsEditorDefinition<Record<string, unknown>>["locales"]["de"];
  retryLabel: string;
  channelVariables: readonly PanelChannelVariable[];
  initial: Record<string, unknown>;
  initialRevision: number;
  onReload: () => Promise<boolean>;
  page?: ModuleSettingsPageOptions;
}): ReactElement => {
  const queryClient = useDashboardQueryClient();
  const channelSettings = useChannelSettings(channelId);
  const initialDraft = useMemo(() => withModuleDraftFields(module.id, initial), [initial, module.id]);
  const { value: currentValue, setValue, dirty, reset, accept } = useDraft(initialDraft);
  const baselineRevision = useRef(initialRevision);
  const [latestSettingsRevision, setLatestSettingsRevision] = useState(initialRevision);
  const settingsRevision = Math.max(initialRevision, latestSettingsRevision);
  const baselineSettings = useRef(initialDraft);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [urlRemovalPending, setUrlRemovalPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const saveInFlight = useRef<Promise<string | null> | null>(null);
  const [serverFieldErrors, setServerFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [conflict, setConflict] = useState(false);
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(() => new Set());
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [serverWarnings, setServerWarnings] = useState<readonly PanelTemplateWarning[]>([]);
  const [localIssues, setLocalIssues] = useState<Readonly<Record<string, { unknown: readonly string[]; worstCaseExceeded: boolean }>>>({});
  useEffect(() => {
    if (initialRevision <= baselineRevision.current) return;
    if (!dirty) {
      baselineRevision.current = initialRevision;
      baselineSettings.current = initialDraft;
      accept(initialDraft);
    } else if (JSON.stringify(initialDraft) === JSON.stringify(baselineSettings.current)) {
      baselineRevision.current = initialRevision;
    }
  }, [accept, dirty, initialDraft, initialRevision]);
  const effectiveDefaultChatTarget = channelSettings.data?.defaultChatTarget;
  const reportTemplateIssues = useCallback((key: string, issues: { unknown: readonly string[]; worstCaseExceeded: boolean }): void => {
    setLocalIssues((current) => {
      const previous = current[key];
      if (previous !== undefined && previous.worstCaseExceeded === issues.worstCaseExceeded && previous.unknown.length === issues.unknown.length && previous.unknown.every((name, index) => name === issues.unknown[index])) return current;
      return { ...current, [key]: issues };
    });
  }, []);
  const spec = definition.spec;
  const templateFields = (module.templateFields ?? {}) as Readonly<Record<string, readonly TemplateVariable[] | undefined>>;
  const templateMetadata = Object.fromEntries(Object.entries(templateFields).map(([key, variables]) => {
    const context = module.templateContext ?? "event";
    const declared = effectivePanelTemplateVariables(context, variables ?? [], channelVariables);
    const localized = panelTemplateOptions(
      context,
      variables ?? [],
      channelVariables,
      dashboardLanguage(),
      copy.fields[key]?.variables ?? [],
      module.templateVariableGroup === undefined ? undefined : { id: module.id, definition: module.templateVariableGroup },
    );
    const byName = new Map(declared.map((variable) => [variable.name, variable]));
    return [key, localized.flatMap((option) => {
      const variable = byName.get(option.name);
      return variable === undefined ? [] : [{
        ...option,
        maxLength: variable.maxLength,
        ...(variable.fallbackWhenAbsent === undefined ? {} : { fallbackWhenAbsent: variable.fallbackWhenAbsent }),
      }];
    })];
  })) as Readonly<Partial<Record<string, readonly (TemplateTextFieldVariable & { maxLength: number; fallbackWhenAbsent?: number })[]>>>;
  const templateVariableOptions: Readonly<Partial<Record<string, readonly TemplateTextFieldVariable[]>>> = templateMetadata;
  const settingsEditor = (sectionId: string, fieldErrors: Readonly<Record<string, string>>): ReactElement => (
    <SettingsEditor
      spec={spec}
      sectionId={sectionId}
      settings={currentValue}
      onChange={(key, next) => {
        setValue((current) => ({ ...current, [key]: next }));
        setTouchedFields((current) => new Set(current).add(key));
        setSaved(false); setConflict(false); setError(undefined);
        setServerFieldErrors((current) => Object.fromEntries(Object.entries(current).filter(([field]) => field !== key)));
      }}
      texts={copy}
      variables={templateVariableOptions}
      templateMetadata={templateMetadata}
      templateMessages={copy.templateMessages}
      messagePreviewLayout={page === undefined ? "stacked" : "side-by-side"}
      fieldErrors={fieldErrors}
      disabled={pending}
      readOnly={page !== undefined && !canManageContent}
      readOnlySectionOnly={page !== undefined}
      enabledLabel={copy.enabledLabel}
      disabledLabel={copy.disabledLabel}
      {...(effectiveDefaultChatTarget === undefined ? {} : { effectiveDefaultChatTarget })}
      onIssuesChange={reportTemplateIssues}
    />
  );
  const readOnly = page === undefined && !canManageContent ? {
    reason: copy.readOnlyReason,
    content: <SettingsEditor
      spec={spec}
      sectionId={spec.sections[0]?.id ?? ""}
      settings={currentValue}
      onChange={() => undefined}
      texts={copy}
      variables={templateVariableOptions}
      templateMetadata={templateMetadata}
      templateMessages={copy.templateMessages}
      readOnly
      enabledLabel={copy.enabledLabel}
      disabledLabel={copy.disabledLabel}
      {...(effectiveDefaultChatTarget === undefined ? {} : { effectiveDefaultChatTarget })}
    />,
  } : undefined;
  const collectErrors = (includeUntouched = false): Record<string, string> => {
    const errors: Record<string, string> = {};
    const collect = (fields: SettingsEditorSpec<Record<string, unknown>>["sections"][number]["fields"]): void => {
      for (const field of fields) {
        const current = currentValue[field.key];
        if (field.kind === "number" && (typeof current !== "number" || !Number.isInteger(current) || current < field.min || current > field.max)) {
          errors[field.key] = typeof current !== "number" ? copy.numberMissing : copy.invalidMessage;
        } else if (field.kind === "number" && field.validate !== undefined &&
            (includeUntouched || validationAttempted || touchedFields.has(field.key)) &&
            !field.validate(current as number, currentValue)) {
          errors[field.key] = copy.fields[field.key]?.invalidError ?? copy.invalidMessage;
        } else if (field.kind === "timeoutDurationRange") {
          const range = current !== null && typeof current === "object" ? current as { minSeconds?: unknown; maxSeconds?: unknown } : null;
          if (range === null || !Number.isInteger(range.minSeconds) || !Number.isInteger(range.maxSeconds) ||
              (range.minSeconds as number) < field.min || (range.minSeconds as number) > (range.maxSeconds as number) ||
              (range.maxSeconds as number) > field.max) errors[field.key] = copy.invalidMessage;
        } else if (field.kind === "text" || field.kind === "template" || field.kind === "message") {
          if (typeof current !== "string" || (field.kind !== "message" && !field.optional && current.trim().length === 0)) {
            errors[field.key] = copy.fields[field.key]?.requiredError ?? copy.invalidMessage;
          } else if (field.kind === "text" && field.maxLength !== undefined && textFieldLength(field, current) > field.maxLength) {
            errors[field.key] = copy.invalidMessage;
          } else if (field.kind === "text" && field.validate !== undefined &&
              (includeUntouched || validationAttempted || touchedFields.has(field.key)) && !field.validate(current)) {
            errors[field.key] = copy.fields[field.key]?.invalidError ?? copy.invalidMessage;
          } else if ((field.kind === "template" || field.kind === "message") && templateTextLength(current) > 500) {
            errors[field.key] = copy.invalidMessage;
          }
        }
        if (field.kind === "switchCard" && field.children !== undefined) collect(field.children);
      }
    };
    collect(spec.sections.flatMap((section) => section.fields));
    return errors;
  };
  const fieldPathMap = Object.fromEntries(Object.keys(copy.fields).flatMap((field) => [
    [field, field],
    [`settings.${field}`, field],
  ]));
  const fieldErrors = { ...collectErrors(validationAttempted), ...serverFieldErrors };
  const invalid = Object.keys(fieldErrors).length > 0;
  const warnings = [
    ...serverWarnings.map(copy.warningLabel),
    ...Object.entries(localIssues).flatMap(([field, issue]) => [
      ...(issue.unknown.length === 0 ? [] : [copy.warningLabel({ field, code: "unknown_template_variables", unknownVariables: issue.unknown })]),
      ...(issue.worstCaseExceeded ? [copy.warningLabel({
        field,
        code: "template_worst_case_too_long",
        worstCaseLength: worstCaseTemplateLength(typeof currentValue[field] === "string" ? currentValue[field] : "", templateFields[field] ?? []),
      })] : []),
    ]),
  ];
  const invalidFields: EditorInvalidField[] = [];
  const sections: EditorSection[] = spec.sections.map((section) => {
    const sectionKeys = new Set<string>();
    const sectionInvalidFields: EditorInvalidField[] = [];
    const visit = (
      fields: SettingsEditorSpec<Record<string, unknown>>["sections"][number]["fields"],
      disabledBySwitch?: string,
    ): void => {
      for (const field of fields) {
        sectionKeys.add(field.key);
        const fieldError = fieldErrors[field.key];
        if (fieldError !== undefined) {
          sectionInvalidFields.push({
            id: `settings-${field.key}${field.kind === "timeoutDurationRange" ? "-minimum" : ""}`,
            ...(disabledBySwitch === undefined ? {} : { focusId: disabledBySwitch }),
            label: copy.fields[field.key]?.label ?? field.key,
            message: fieldError,
            sectionId: section.id,
          });
        }
        if (field.kind === "switchCard" && field.children !== undefined) {
          const childFocusId = disabledBySwitch ?? (currentValue[field.key] === true ? undefined : `settings-${field.key}`);
          visit(field.children, childFocusId);
        }
      }
    };
    visit(section.fields);
    invalidFields.push(...sectionInvalidFields);
    const hasError = sectionInvalidFields.length > 0;
    const hasWarning = [...sectionKeys].some((key) => {
      const issues = localIssues[key];
      return (issues !== undefined && issues.unknown.length > 0) || serverWarnings.some((warning) => warning.field === key);
    });
    return {
      id: section.id,
      label: copy.sections[section.id] ?? section.id,
      icon: section.icon,
      content: settingsEditor(section.id, fieldErrors),
      ...(hasError ? { issue: "error" as const } : hasWarning ? { issue: "warning" as const } : {}),
    };
  });
  const save = (): Promise<string | null> => {
    if (saveInFlight.current !== null) return saveInFlight.current;
    const operation = (async (): Promise<string | null> => {
    if (Object.keys(collectErrors(true)).length > 0) {
      setValidationAttempted(true);
      return copy.invalidMessage;
    }
    if (pending || urlRemovalPending || conflict || !canManageContent) return copy.saveError;
    setPending(true); setError(undefined); setSaved(false); setServerFieldErrors({});
    const settingsToSave = persistedSettings(module.id, currentValue);
    const baselineToSave = persistedSettings(module.id, baselineSettings.current);
    const settingsChanged = JSON.stringify(settingsToSave) !== JSON.stringify(baselineToSave);
    const statsUrlDraft = module.id === "belabox" && typeof currentValue.belaboxStatsUrl === "string"
      ? currentValue.belaboxStatsUrl
      : "";
    const shouldReplaceStatsUrl = statsUrlDraft.trim().length > 0;
    try {
      let acceptedSettings = settingsToSave;
      if (settingsChanged || shouldReplaceStatsUrl) {
        const response = await runModuleQueryWrite(
          queryClient,
          channelId,
          module.id,
          "settings",
          (revision) => {
            if (revision === null) throw new Error("Module settings require a baseline revision.");
            return saveChannelModuleSettings(channelId, module.id, revision, settingsToSave,
              shouldReplaceStatsUrl ? { statsUrl: statsUrlDraft } : undefined);
          },
          {
            baselineRevision: baselineRevision.current,
            updateCache: (current, result) => typeof current === "object" && current !== null
              ? { ...current, ...result }
              : current,
            relatedParts: (module.settingsEditorRelatedParts ?? []).map((part) => ({ moduleId: module.id, part })),
          },
        );
        acceptedSettings = response.settings;
        baselineRevision.current = response.revision;
        setLatestSettingsRevision(response.revision);
        setServerWarnings(response.warnings);
        if (shouldReplaceStatsUrl) {
          void refetchModuleQueryData<BelaboxStatusResponse>(queryClient, channelId, "belabox", "status").catch(() => undefined);
        }
      }
      const acceptedDraft = withModuleDraftFields(module.id, acceptedSettings);
      baselineSettings.current = acceptedDraft;
      accept(acceptedDraft);
      setSaved(true);
      setValidationAttempted(false);
      return null;
    } catch (caught) {
      if (caught instanceof PanelApiError && caught.status === 409 && caught.code === "module_settings_changed_concurrently") {
        setConflict(true);
        notify({ tone: "error", message: copy.conflictMessage });
        return copy.conflictMessage;
      }
      const message = shouldReplaceStatsUrl
        ? copy.urlSaveError ?? copy.saveError
        : caught instanceof PanelApiError ? apiErrorText(caught.code, copy.saveError) : copy.saveError;
      setServerFieldErrors(shouldReplaceStatsUrl
        ? {}
        : mapServerFieldErrors(caught, fieldPathMap, (reasonCode) => serverFieldErrorText(reasonCode, language)));
      setError(message);
      return message;
    } finally { setPending(false); }
    })();
    const tracked = operation.finally(() => {
      if (saveInFlight.current === tracked) saveInFlight.current = null;
    });
    saveInFlight.current = tracked;
    return tracked;
  };
  const discard = (): void => {
    reset(); setTouchedFields(new Set()); setValidationAttempted(false);
    setSaved(false); setConflict(false); setError(undefined); setServerWarnings([]); setLocalIssues({}); setServerFieldErrors({});
  };
  const navigationGuard = useDraftGuard(dirty, save, discard);
  useEffect(() => registerDashboardNavigationGuard(navigationGuard.guardSwitch), [navigationGuard.guardSwitch]);
  const notifyPageSaveError = page !== undefined;
  useEffect(() => {
    if (notifyPageSaveError && error !== undefined && error.length < 80) notify({ tone: "error", message: error });
  }, [error, notifyPageSaveError]);
  const pageSave = page === undefined || !canManageContent ? undefined : {
    persistent: true,
    dirty,
    pending: pending || urlRemovalPending,
    saveDisabled: pending || urlRemovalPending,
    saved,
    ...(error === undefined ? {} : { error }),
    invalid,
    invalidMessage: copy.invalidMessage,
    invalidStatus: `× ${copy.invalidMessage}`,
    warnings,
    warningStatusLabel: (items: readonly string[], justSaved: boolean) => justSaved ? `✓ ${copy.savedLabel} ${items.join(" ")}` : items.join(" "),
    ...(conflict ? { conflict: {
      message: error === undefined ? copy.conflictMessage : `${copy.conflictMessage} ${dashboardTexts().module.settingsLoadError}`,
      reloadLabel: error === undefined ? copy.reloadLabel : retryLabel,
      onReload: () => {
        setError(undefined);
        void onReload().then((succeeded) => { if (!succeeded) setError(dashboardTexts().module.settingsLoadError); });
      },
    } } : {}),
    onSave: () => { void save(); },
    onInvalidSave: () => { setValidationAttempted(true); },
    onDiscard: discard,
    saveLabel: copy.saveLabel,
    discardLabel: copy.discardLabel,
    savedLabel: copy.savedLabel,
    pendingLabel: copy.pendingLabel,
  };
  const pageContent = page === undefined ? null : <SettingsPage
    kind="modules"
    title={page.title}
    subtitle={page.subtitle}
    icon={page.icon}
    {...(module.id === "belabox" ? { className: "settings-page--belabox" } : {})}
    active={page.active}
    onToggle={page.onToggle}
    switchDisabled={page.switchDisabled || pending || urlRemovalPending}
    switchBusy={page.switchBusy}
    {...(page.lockHint === undefined ? {} : { lockHint: page.lockHint })}
    {...(pageSave === undefined ? {} : { save: pageSave })}
    overflow={<ModuleListLink channelId={channelId} onNavigate={page.onNavigate} />}
    {...(module.id === "belabox" ? { topContent: <BelaboxSettingsPanelMount key="belabox-panel" module={module} channelId={channelId}
      language={language} canManageContent={canManageContent}
      lowBitrateKbps={typeof currentValue.lowBitrateKbps === "number" ? currentValue.lowBitrateKbps : 1_000}
      recoverBitrateKbps={typeof currentValue.recoverBitrateKbps === "number" ? currentValue.recoverBitrateKbps : 2_000}
      statsUrlDraft={typeof currentValue.belaboxStatsUrl === "string" ? currentValue.belaboxStatsUrl : ""}
      onStatsUrlDraftChange={(value) => {
        setValue((current) => ({ ...current, belaboxStatsUrl: value }));
        setSaved(false); setConflict(false); setError(undefined);
      }}
      settingsRevision={settingsRevision}
      onSettingsRevisionChange={setLatestSettingsRevision}
      onRemovePendingChange={setUrlRemovalPending}
      savingSettings={pending || urlRemovalPending} /> } : {})}
    columns={module.id === "ads"
      ? [
        <AdsSettingsPanelMount key="ads-panel" module={module} channelId={channelId} language={language} canManageContent={canManageContent} moduleActive={page.active} />,
        settingsEditor("announcements", fieldErrors),
        settingsEditor("prewarning", fieldErrors),
      ]
      : module.id === "belabox"
        ? [
          settingsEditor("polling", fieldErrors),
          settingsEditor("alerts", fieldErrors),
        ]
      : sections.map(({ id }) => settingsEditor(id, fieldErrors))}
  />;
  return <>
    {pageContent}
    {page === undefined ? <EditorShell
    ariaLabel={copy.ariaLabel}
    title={copy.title}
    sections={sections}
    {...(readOnly === undefined ? {} : { readOnly })}
    dirty={dirty}
    pending={pending}
    saved={saved}
    {...(error === undefined ? {} : { error })}
    invalid={invalid}
    invalidMessage={copy.invalidMessage}
    invalidFields={invalidFields}
    onInvalidSave={() => { setValidationAttempted(true); }}
    warnings={warnings}
    warningStatusLabel={(items, justSaved) => justSaved ? `✓ ${copy.savedLabel} ${items.join(" ")}` : items.join(" ")}
    {...(conflict ? { conflict: {
      message: error === undefined
        ? copy.conflictMessage
        : `${copy.conflictMessage} ${dashboardTexts().module.settingsLoadError}`,
      reloadLabel: error === undefined ? copy.reloadLabel : retryLabel,
      onReload: () => {
        setError(undefined);
        void onReload().then((succeeded) => {
          if (!succeeded) setError(dashboardTexts().module.settingsLoadError);
        });
      },
    } } : {})}
    onSave={() => { void save(); }}
    onDiscard={discard}
    saveLabel={copy.saveLabel}
    discardLabel={copy.discardLabel}
    savedLabel={copy.savedLabel}
    pendingLabel={copy.pendingLabel}
    issueLabels={copy.issueLabels}
  /> : null}
    <ConfirmDialog
      opened={navigationGuard.confirmOpen}
      title={dashboardTexts().module.unsavedChangesTitle}
      description={navigationGuard.saveError === undefined
        ? dashboardTexts().module.unsavedChangesDescription
        : `${dashboardTexts().module.unsavedChangesDescription} ${navigationGuard.saveError}`}
      cancelLabel={dashboardTexts().module.continueEditing}
      confirmLabel={dashboardTexts().module.discardAndSwitch}
      onCancel={navigationGuard.continueEditing}
      onConfirm={navigationGuard.discardAndSwitch}
      {...(invalid || conflict || !canManageContent ? {} : {
        alternative: {
          label: dashboardTexts().module.saveAndSwitch,
          onClick: () => { void navigationGuard.saveAndSwitch(); },
        },
      })}
      pending={pending || navigationGuard.saving}
      danger
    />
  </>;
};

export const ModulePanelMount = ({ channelId, activeModules, streamSessionIdentity, suspendModuleId, canManage = true, canOperate = true, botIsModerator = null, initialSelection }: ModulePanelMountProperties): ReactElement => {
  const registeredViews = activeModules.flatMap((activeModule) => {
    const module = MODULES.find((candidate) => candidate.id === activeModule.moduleId);
    if (module === undefined) return [];
    if (module.panel === undefined && module.settingsEditor === undefined) return [];
    return [{ id: activeModule.moduleId, module }];
  });

  if (registeredViews.length === 0) {
    const texts = dashboardTexts();
    return (
      <section className="module-empty" aria-label={texts.module.module}>
        <p>{activeModules.length === 0 ? texts.module.noneActive : texts.module.noView}</p>
      </section>
    );
  }

  return (
    <section className="module-stack" aria-label={dashboardTexts().module.views}>
      {registeredViews.map(({ id, module }) => <MountedModuleView
          key={`${channelId}:${id}`}
          module={module}
          channelId={channelId}
          {...(streamSessionIdentity === undefined ? {} : { streamSessionIdentity })}
          canManage={canManage}
          canOperate={canOperate}
          botIsModerator={botIsModerator}
          suspendToParent={module.id === suspendModuleId}
          {...(initialSelection === undefined ? {} : { initialSelection })}
        />)}
    </section>
  );
};

const MountedModuleView = ({ module, channelId, streamSessionIdentity, canManage, canOperate, botIsModerator, suspendToParent, initialSelection }: {
  module: (typeof MODULES)[number];
  channelId: string;
  streamSessionIdentity?: string;
  canManage: boolean;
  canOperate: boolean;
  botIsModerator: boolean | null;
  suspendToParent: boolean;
  initialSelection?: string;
}): ReactElement => {
  const loadPanel = useCallback(() => loadModulePanel(module) as Promise<{ default: ComponentType<ModulePanelProperties> }>, [module]);
  const settingsEditor = <ModuleSettingsEditor
    module={module}
    channelId={channelId}
    canManageContent={canManage}
    language={dashboardLanguage()}
  />;
  return <div className="module-view">
    {module.settingsEditorPlacement === "before-panel" ? settingsEditor : null}
    {module.panel === undefined ? null : <RetryableLazy
      instanceKey={`${module.id}:panel`}
      load={loadPanel}
      suspendToParent={suspendToParent}
      onRetry={retryModuleChunkLoad}
      properties={{
        channelId,
        ...(streamSessionIdentity === undefined ? {} : { streamSessionIdentity }),
        language: dashboardLanguage(),
        canManage,
        canOperate,
        botIsModerator,
        textBlockConditions: MODULES.flatMap((candidate) => candidate.textBlockConditions ?? []),
        ...(initialSelection === undefined ? {} : { initialSelection }),
      }}
      loadingFallback={<div className="module-view-fallback module-view-fallback--rows" aria-hidden="true">
        <span className="module-view-fallback__row" />
        <span className="module-view-fallback__row" />
        <span className="module-view-fallback__row" />
      </div>}
      renderError={(retry) => <LoadState
        variant="panel-320"
        status="error"
        loading={null}
        empty={null}
        error={null}
        queryError={{ title: dashboardTexts().errors.dataLoadFailed, message: dashboardTexts().module.componentLoadError, onRetry: retry }}
      >{null}</LoadState>}
    />}
    {module.settingsEditorPlacement === "before-panel" ? null : settingsEditor}
  </div>;
};

const canManageModules = canManage;

interface ModuleWorkspaceProperties {
  channelId: string;
  ownRole: ChannelRole;
  modules: PanelModuleState[];
  loading?: boolean;
  error?: string | null;
  onNavigate: (route: DashboardRoute) => void;
  /** Reloads `modules` after a successful toggle. */
  onChanged: () => Promise<void>;
}

const ModuleWorkspaceRow = ({
  channelId,
  moduleId,
  rawEnabled,
  missingScopes,
  manageable,
  busy,
  onToggle,
  onNavigate,
}: {
  channelId: string;
  moduleId: string;
  rawEnabled: boolean;
  missingScopes: string[];
  manageable: boolean;
  busy: boolean;
  onToggle: (nextEnabled: boolean) => void;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => {
  const labels = workspaceTexts();
  const texts = dashboardTexts();
  const details = moduleDetails(moduleId);
  const definition = MODULES.find((module) => module.id === moduleId);
  const mandatory = definition?.mandatory === true;
  const mandatoryReason = definition?.mandatoryReason?.[dashboardLanguage()] ?? labels.mandatoryReason;
  const permissionsMissing = modulePermissionsAreMissing({ missingBroadcasterScopes: missingScopes });
  const effectiveEnabled = (rawEnabled || mandatory) && !permissionsMissing;
  const state = permissionsMissing ? labels.disabled : statusWord(effectiveEnabled);
  const route: DashboardRoute = { kind: "module", channelId, moduleId };
  const lockedReason = mandatory ? mandatoryReason : manageable ? undefined : texts.module.managementLocked;

  return (
    <ListRow
      href={dashboardRoutePath(route)}
      onNavigate={() => { onNavigate(route); }}
      icon={<ModuleIcon moduleId={moduleId} className="scope-row__icon" />}
      title={details.name}
      description={details.description}
      status={mandatory
        ? <LockedModuleStatus status={labels.alwaysActiveStatus} reason={mandatoryReason} />
        : <StatusLed state={permissionsMissing ? "warn" : effectiveEnabled ? "ok" : "off"} label={state} />}
      action={mandatory ? null : <div className="module-switch-control">
        <SwitchPrimitive aria-label={`${details.name}: ${statusWord(rawEnabled)}`} aria-describedby={lockedReason === undefined ? undefined : `module-lock-${moduleId}`} aria-busy={busy} checked={rawEnabled} disabled={!manageable || busy} onCheckedChange={onToggle} />
        <LockedReason id={`module-lock-${moduleId}`} {...(lockedReason === undefined ? {} : { reason: lockedReason })} />
      </div>}
    />
  );
};

interface ModuleToggleListProperties {
  channelId: string;
  ownRole: ChannelRole;
  modules: PanelModuleState[];
  onNavigate: (route: DashboardRoute) => void;
  /** Reloads `modules` after a successful toggle. */
  onChanged: () => Promise<void>;
}

/**
 * Just the switchable rows -- no page heading, so a dashboard surface can
 * embed it beside other channel content. `ModuleWorkspace` below wraps this
 * with the full "Module" page's own heading and error line.
 */
const ModuleToggleList = ({ channelId, ownRole, modules, onNavigate, onChanged }: ModuleToggleListProperties): ReactElement => {
  const texts = dashboardTexts();
  const manageable = canManageModules(ownRole);
  // Holds the clicked value only while the request is in flight; afterwards
  // the caller reloads `modules`, so the list, sidebar and overview agree.
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  const [busyModuleId, setBusyModuleId] = useState<string | null>(null);

  const toggle = async (moduleId: string, nextEnabled: boolean): Promise<void> => {
    // The seam `Switch` already disables itself while `pending`, but that
    // guard lives in a prop the caller could ignore -- ignore an in-flight
    // click here too, so two toggles for the same module never race.
    if (busyModuleId === moduleId) return;
    setBusyModuleId(moduleId);
    setPendingEnabled((current) => ({ ...current, [moduleId]: nextEnabled }));
    try {
      await setChannelModuleEnabled(channelId, moduleId, nextEnabled);
      await onChanged();
    } catch (toggleFailure: unknown) {
      if (toggleFailure instanceof PanelApiError && toggleFailure.status === 401) {
        notify({ tone: "error", message: texts.errors.sessionInvalid });
      } else {
        notify({ tone: "error", message: toggleFailure instanceof PanelApiError
          ? apiErrorText(toggleFailure.code, texts.errors.changeFailed)
          : texts.errors.changeFailed });
      }
    } finally {
      setPendingEnabled((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== moduleId)));
      setBusyModuleId(null);
    }
  };

  return (
    <>
      <div className="state-list">
        {MODULES.map((module) => {
          const state = modules.find((candidate) => candidate.id === module.id);
          const mandatory = state?.mandatory === true || module.mandatory === true;
          const rawEnabled = mandatory || (pendingEnabled[module.id] ?? state?.enabled === true);
          return (
            <ModuleWorkspaceRow
              key={module.id}
              channelId={channelId}
              moduleId={module.id}
              rawEnabled={rawEnabled}
              missingScopes={state?.missingBroadcasterScopes ?? []}
              manageable={manageable}
              busy={busyModuleId === module.id}
              onToggle={(nextEnabled) => { void toggle(module.id, nextEnabled); }}
              onNavigate={onNavigate}
            />
          );
        })}
      </div>
    </>
  );
};

export const ModuleWorkspace = ({ channelId, ownRole, modules, loading = false, error = null, onNavigate, onChanged }: ModuleWorkspaceProperties): ReactElement => {
  useEffect(() => {
    if (error !== null) notify({ tone: "error", message: error });
  }, [error]);

  return (
    <section className="module-workspace" aria-label={dashboardTexts().navigation.module}>
      <div className="module-workspace__main">
        <SettingsPage
          kind="modules"
          title={dashboardTexts().navigation.module}
          subtitle={loading ? dashboardTexts().module.load : dashboardTexts().module.available}
          columns={[<ModuleToggleList key={channelId} channelId={channelId} ownRole={ownRole} modules={modules} onNavigate={onNavigate} onChanged={onChanged} />]}
        />
      </div>
    </section>
  );
};

const ModuleListLink = ({ channelId, onNavigate }: { channelId: string; onNavigate: (route: DashboardRoute) => void }): ReactElement => {
  const route: DashboardRoute = { kind: "channel", channelId, section: "modules" };
  return (
    <a
      className="module-list-link"
      href={dashboardRoutePath(route)}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(route);
      }}
    >
      {dashboardTexts().navigation.module}
    </a>
  );
};

interface ModulePageProperties {
  channelId: string;
  moduleId: string;
  streamSessionIdentity?: string;
  ownRole: ChannelRole;
  modules: PanelModuleState[];
  activeModules: PanelActiveModule[];
  loading?: boolean;
  error?: string | null;
  busy?: boolean;
  botIsModerator?: boolean | null;
  onNavigate: (route: DashboardRoute) => void;
  onToggle: () => void;
  /** Deep-link target from the command palette (#164), e.g. a text command name. */
  initialSelection?: string;
  /** Lets route transitions retain the previous page until the target panel chunk is ready. */
  suspendPanelUntilReady?: boolean;
}

export const ModulePage = ({ channelId, moduleId, ownRole, modules, activeModules, streamSessionIdentity, loading = false, error = null, busy = false, botIsModerator = null, onNavigate, onToggle, initialSelection, suspendPanelUntilReady = false }: ModulePageProperties): ReactElement => {
  const texts = dashboardTexts();
  const labels = workspaceTexts();
  const details = moduleDetails(moduleId);
  const registered = MODULES.find((candidate) => candidate.id === moduleId);
  const navigationPage = registered?.navigationEntries?.find((entry) => entry.showMainSwitch === false);
  const moduleState = modules.find((candidate) => candidate.id === moduleId);
  const activeModule = activeModules.find((candidate) => candidate.moduleId === moduleId);
  const chatCommands = registered?.chatCommands ?? [];
  const mandatory = moduleState?.mandatory === true || registered?.mandatory === true;
  const mandatoryReason = registered?.mandatoryReason?.[dashboardLanguage()] ?? labels.mandatoryReason;
  const enabled = mandatory || moduleState?.enabled === true;
  const manageable = canManageModules(ownRole);
  const disabledReason = mandatory ? mandatoryReason : manageable ? null : texts.module.managementLocked;
  const switchDisabled = mandatory || registered === undefined || moduleState === undefined;
  const missingScopes = moduleState?.missingBroadcasterScopes ?? [];
  const permissionsMissing = modulePermissionsAreMissing(moduleState);
  const requiredScopes = moduleState?.requiredBroadcasterScopes ?? registered?.broadcasterScopes ?? [];
  const missingScopeSet = new Set(missingScopes);
  const effectiveEnabled = enabled && !permissionsMissing;
  const viewLoading = loading || moduleState === undefined || ((registered?.panel !== undefined || registered?.settingsEditor !== undefined) && enabled && activeModule === undefined);
  const showActiveView = activeModule !== undefined && (enabled || moduleState === undefined);

  const stateMessage = registered === undefined
    ? labels.unknown(details.name)
    : permissionsMissing
      ? texts.module.scopesMissing(details.name)
      : moduleState?.enabled === false
        ? labels.switchedOff(details.name)
        : null;
  const stateTone = registered === undefined || permissionsMissing ? "notice" : "neutral";

  useEffect(() => {
    if (error !== null) notify({ tone: "error", message: error });
  }, [error]);

  if ((moduleId === "ads" || moduleId === "raid" || moduleId === "belabox") && registered?.settingsEditor !== undefined && !permissionsMissing) {
    return <section className="module-detail module-detail--settings-page" aria-label={details.name}>
      <ModuleSettingsEditor
        module={registered}
        channelId={channelId}
        canManageContent={ownRole !== "operator"}
        language={dashboardLanguage()}
        page={{
          title: details.name,
          subtitle: details.description,
          icon: iconFor(moduleId, "module-heading-glyph"),
          active: enabled,
          onToggle: (nextEnabled) => { if (nextEnabled !== enabled) onToggle(); },
          switchDisabled: !manageable || switchDisabled || busy || mandatory,
          switchBusy: busy,
          ...(disabledReason === null ? {} : { lockHint: disabledReason }),
          onNavigate,
        }}
      />
    </section>;
  }

  return (
    <>
      <section className="module-detail" aria-label={details.name}>
        <PageHeader
          kind="modules"
          icon={navigationPage === undefined
            ? iconFor(moduleId, "module-heading-glyph")
            : <NavigationIcon kind={navigationPage.iconKind} className="module-heading-glyph module-glyph" />}
          title={details.name}
          subtitle={details.description}
          {...(navigationPage?.showMainSwitch === false ? {} : {
            active: effectiveEnabled,
            onToggle: (nextEnabled: boolean) => { if (nextEnabled !== effectiveEnabled) onToggle(); },
            switchTitle: `${details.name}: ${statusWord(effectiveEnabled)}`,
            switchDisabled: !manageable || switchDisabled || busy || mandatory,
            switchBusy: busy,
            ...(mandatory ? { moduleSwitch: <LockedModuleStatus status={labels.alwaysActiveStatus} reason={mandatoryReason} /> } : {}),
            ...(disabledReason === null || (registered?.panelManagesSettings && moduleState?.enabled !== false && moduleId !== "clips") ? {} : { lockHint: disabledReason }),
          })}
          {...(moduleId === "text_commands" ? {
            pageActions: <TextCommandChatCommandHelp channelId={channelId} />,
          } : chatCommands.length === 0 ? {} : {
            pageActions: <ChatCommandsHelp commands={chatCommands} language={dashboardLanguage()} />,
          })}
        />
        {!permissionsMissing ? null : <section className="module-detail__authorization" aria-label={texts.module.scopeList}>
          <div className="section-heading"><h2>{texts.module.scopeList}</h2></div>
          <div className="state-list module-scope-list">
            {requiredScopes.map((scope) => {
              const missing = missingScopeSet.has(scope);
              return <StateRow
                key={scope}
                label={moduleScopePurpose(moduleId, scope)}
                tone={missing ? "warning" : "healthy"}
                word={missing ? texts.module.scopeMissing : texts.module.scopeGranted}
                detail={<span className="mono">{scope}</span>}
                icon={<NavigationIcon kind="permission" className="scope-row__icon" />}
              />;
            })}
          </div>
          {ownRole === "broadcaster"
            ? <a className="button button--primary" href={`/auth/channels/${encodeURIComponent(channelId)}/broadcaster-scopes/${encodeURIComponent(moduleId)}`}>{texts.module.requestScopeConsent}</a>
            : <button className="button button--primary" type="button" disabled>{texts.module.requestScopeConsent}</button>}
          {ownRole === "broadcaster" ? null : <p className="lock-reason">{texts.module.scopeConsentLocked}</p>}
        </section>}
        {viewLoading ? <p className="muted">{texts.module.load}</p> : null}
        {stateMessage === null ? (
          registered?.panel === undefined && registered?.settingsEditor === undefined ? (showActiveView ? <p className="module-state">{texts.module.noView}</p> : null) : !showActiveView ? null : (
            <section className={`module-detail__content${viewLoading ? " stale" : ""}`} aria-label={labels.content}>
              <ModulePanelMount key={`${channelId}:${moduleId}`} channelId={channelId} activeModules={[activeModule]} {...(streamSessionIdentity === undefined ? {} : { streamSessionIdentity })} {...(suspendPanelUntilReady ? { suspendModuleId: moduleId } : {})} canManage={ownRole !== "operator"} canOperate={true} botIsModerator={botIsModerator} {...(initialSelection === undefined ? {} : { initialSelection })} />
            </section>
          )
        ) : (
          <section className={`module-state module-state--${stateTone}`} aria-label={texts.module.module}>
            <div className="module-state__summary">
              <NavigationIcon kind="permission" className="module-state__icon" />
              <p>{stateMessage}</p>
            </div>
            <ModuleListLink channelId={channelId} onNavigate={onNavigate} />
          </section>
        )}
      </section>
    </>
  );
};
