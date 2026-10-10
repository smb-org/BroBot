import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType, type LazyExoticComponent, type ReactElement, type ReactNode } from "react";

import { MODULES } from "../modules/registry";
import type { ModulePanelProperties } from "../modules/contract";
import { canManage, type ChannelRole } from "../contracts/values";
import type { PanelActiveModule, PanelModuleState, PanelTemplateWarning } from "../panel-contract";
import { PanelApiError, getChannelModuleSettings, saveChannelModuleSettings, setChannelModuleEnabled } from "./api";
import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "./data";
import { apiErrorText, dashboardCommonTexts, dashboardLanguage, dashboardTexts, formatNumber, type DashboardLanguage } from "./locale";
import { moduleDescription, moduleName, moduleScopePurpose, moduleWorkspaceTexts, statusWord } from "./module-labels";
import { ChatCommands } from "./chat-commands";
import { modulePermissionsAreMissing } from "./channel-health";
import { dashboardRoutePath, type DashboardRoute } from "./router";
import { effectivePanelTemplateVariables, panelTemplateOptions, type PanelChannelVariable } from "./ui/template-variable-options";
import { ConfirmDialog, EditorShell, Icon, ListRow, LoadState, NavigationIcon, notify, PageHeader, registerDashboardNavigationGuard, SettingsEditor, Skeleton, Switch, textFieldLength, useDraftGuard, type EditorInvalidField, type EditorSection, type SettingsEditorDefinition, type SettingsEditorSpec, type TemplateVariableOption } from "./ui";
import { worstCaseTemplateLength } from "../template";
import type { TemplateVariable } from "../template";

const lazyPanels = new Map<string, LazyExoticComponent<ComponentType<ModulePanelProperties>>>();
const workspaceTexts = moduleWorkspaceTexts;

const moduleDetails = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): { name: string; description: string } => ({
  name: moduleName(moduleId, language),
  description: moduleDescription(moduleId, language) ?? workspaceTexts(language).noDescription,
});

export type StateTone = "healthy" | "warning" | "error" | "neutral";
export type LedStatus = "green" | "amber" | "red" | "off";

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

export const Led = ({ status, label }: { status: LedStatus; label: string }): ReactElement => (
  <span className="led" data-status={status}>
    <span className="led__dot" aria-hidden="true" />
    <span>{label}</span>
  </span>
);

export const StateRow = ({ label, tone, word, detail, action, icon }: {
  label: string;
  tone: StateTone;
  word: string;
  detail?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}): ReactElement => {
  const status: LedStatus = tone === "healthy" ? "green" : tone === "warning" ? "amber" : tone === "error" ? "red" : "off";
  return (
    <article className="state-row" data-status={tone} aria-label={label}>
      <strong className="state-row__label">{icon}{label}</strong>
      <Led status={status} label={word} />
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
  ledStatus?: LedStatus;
  ledLabel?: string;
}): ReactElement => {
  const details = moduleDetails(moduleId);
  const tileRoute: DashboardRoute = route ?? { kind: "module", channelId, moduleId };
  const tileName = name ?? details.name;
  const tileStatus = ledStatus ?? (enabled ? "green" : "off");
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
      <Led status={tileStatus} label={tileLabel} />
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

const ModuleSwitch = ({ moduleId, enabled, disabled, busy, onToggle }: {
  moduleId: string;
  enabled: boolean;
  disabled: boolean;
  busy: boolean;
  onToggle: () => void;
}): ReactElement => (
  <button
    className="switch"
    type="button"
    role="switch"
    aria-label={`${moduleDetails(moduleId).name}: ${statusWord(enabled)}`}
    aria-checked={enabled}
    aria-busy={busy}
    disabled={disabled || busy}
    onClick={onToggle}
  >
        <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
  </button>
);

const getLazyPanel = (module: (typeof MODULES)[number]): LazyExoticComponent<ComponentType<ModulePanelProperties>> | null => {
  if (module.panel === undefined) return null;
  const existing = lazyPanels.get(module.id);
  if (existing !== undefined) return existing;
  const panel = lazy(module.panel);
  lazyPanels.set(module.id, panel);
  return panel;
};

interface ModulePanelMountProperties {
  channelId: string;
  activeModules: PanelActiveModule[];
  canManage?: boolean;
  canOperate?: boolean;
  botIsModerator?: boolean | null;
  /** Deep-link target from Spotlight (#164); passed through to the panel unchanged. */
  initialSelection?: string;
}

const ModuleSettingsEditor = ({ module, channelId, canManageContent, language }: {
  module: (typeof MODULES)[number];
  channelId: string;
  canManageContent: boolean;
  language: DashboardLanguage;
}): ReactElement | null => module.settingsEditor === undefined ? null : <ModuleSettingsEditorQuery
  key={`${channelId}:${module.id}`}
  module={module}
  channelId={channelId}
  canManageContent={canManageContent}
  language={language}
/>;

const ModuleSettingsEditorQuery = ({ module, channelId, canManageContent, language }: {
  module: (typeof MODULES)[number];
  channelId: string;
  canManageContent: boolean;
  language: DashboardLanguage;
}): ReactElement => {
  const [generation, setGeneration] = useState(0);
  const queryClient = useDashboardQueryClient();
  const settingsQuery = useModuleQuery(channelId, module.id, "settings", async (signal) => {
    if (module.settingsEditor === undefined) throw new Error("Module settings editor is unavailable.");
    const [definition, response] = await Promise.all([
      module.settingsEditor(),
      getChannelModuleSettings(channelId, module.id, signal),
    ]);
    return { definition: definition.default, settings: response.settings, revision: response.revision, variables: response.variables };
  });
  const loaded = settingsQuery.data;
  const loadError = settingsQuery.error instanceof PanelApiError
    ? apiErrorText(settingsQuery.error.code, dashboardTexts().module.settingsLoadError)
    : dashboardTexts().module.settingsLoadError;
  if (loaded === undefined) {
    return <LoadState
      status={settingsQuery.isPending || settingsQuery.isFetching ? "loading" : "error"}
      minHeight="calc(var(--s10) * 8)"
      loading={<Skeleton rows={3} height={34} />}
      empty={null}
      error={<p className="muted" role="alert">{loadError}</p>}
      queryError={{ title: dashboardTexts().errors.dataLoadFailed, message: loadError, onRetry: () => { void settingsQuery.refetch(); } }}
    >{null}</LoadState>;
  }
  const copy = loaded.definition.locales[language];
  return <LoadState
    status="success"
    minHeight="calc(var(--s10) * 8)"
    loading={<Skeleton rows={3} height={34} />}
    empty={null}
    error={<p className="muted" role="alert">{dashboardTexts().module.settingsLoadError}</p>}
    queryError={{ title: dashboardTexts().errors.dataLoadFailed, message: loadError, onRetry: () => { void settingsQuery.refetch(); } }}
    refreshError={settingsQuery.isRefetchError}
  >
    <LoadedModuleSettingsEditor
      key={`${module.id}-${String(generation)}`}
      module={module}
      channelId={channelId}
      canManageContent={canManageContent}
      definition={loaded.definition}
      copy={copy}
      retryLabel={dashboardCommonTexts(language).retry}
      channelVariables={loaded.variables}
      initial={loaded.settings}
      initialRevision={loaded.revision}
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

const LoadedModuleSettingsEditor = ({ module, channelId, canManageContent, definition, copy, retryLabel, channelVariables, initial, initialRevision, onReload }: {
  module: (typeof MODULES)[number];
  channelId: string;
  canManageContent: boolean;
  definition: SettingsEditorDefinition<Record<string, unknown>>;
  copy: SettingsEditorDefinition<Record<string, unknown>>["locales"]["de"];
  retryLabel: string;
  channelVariables: readonly PanelChannelVariable[];
  initial: Record<string, unknown>;
  initialRevision: number;
  onReload: () => Promise<boolean>;
}): ReactElement => {
  const queryClient = useDashboardQueryClient();
  const [value, setValue] = useState(initial);
  const [baseline, setBaseline] = useState({ settings: initial, revision: initialRevision });
  const [dirty, setDirty] = useState(false);
  const currentValue = dirty ? value : initial;
  const currentBaseline = dirty ? baseline : { settings: initial, revision: initialRevision };
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [conflict, setConflict] = useState(false);
  const [touchedFields, setTouchedFields] = useState<ReadonlySet<string>>(() => new Set());
  const [validationAttempted, setValidationAttempted] = useState(false);
  const [serverWarnings, setServerWarnings] = useState<readonly PanelTemplateWarning[]>([]);
  const [localIssues, setLocalIssues] = useState<Readonly<Record<string, { unknown: readonly string[]; worstCaseExceeded: boolean }>>>({});
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
  })) as Readonly<Partial<Record<string, readonly (TemplateVariableOption & { maxLength: number; fallbackWhenAbsent?: number })[]>>>;
  const templateVariableOptions: Readonly<Partial<Record<string, readonly TemplateVariableOption[]>>> = templateMetadata;
  const settingsEditor = (sectionId: string, fieldErrors: Readonly<Record<string, string>>): ReactElement => (
    <SettingsEditor
      spec={spec}
      sectionId={sectionId}
      settings={currentValue}
      onChange={(key, next) => {
        if (!dirty) setBaseline(currentBaseline);
        setValue({ ...currentValue, [key]: next });
        setTouchedFields((current) => new Set(current).add(key));
        setDirty(true); setSaved(false); setConflict(false); setError(undefined);
      }}
      texts={copy}
      variables={templateVariableOptions}
      templateMetadata={templateMetadata}
      createVariableHref={`/channels/${encodeURIComponent(channelId)}/variables`}
      templateMessages={copy.templateMessages}
      fieldErrors={fieldErrors}
      disabled={pending}
      enabledLabel={copy.enabledLabel}
      disabledLabel={copy.disabledLabel}
      onIssuesChange={reportTemplateIssues}
    />
  );
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
        } else if (field.kind === "text" || field.kind === "template") {
          if (typeof current !== "string" || (!field.optional && current.trim().length === 0)) {
            errors[field.key] = copy.fields[field.key]?.requiredError ?? copy.invalidMessage;
          } else if (field.kind === "text" && field.maxLength !== undefined && textFieldLength(field, current) > field.maxLength) {
            errors[field.key] = copy.invalidMessage;
          } else if (field.kind === "text" && field.validate !== undefined &&
              (includeUntouched || validationAttempted || touchedFields.has(field.key)) && !field.validate(current)) {
            errors[field.key] = copy.fields[field.key]?.invalidError ?? copy.invalidMessage;
          } else if (field.kind === "template" && current.length > 500) {
            errors[field.key] = copy.invalidMessage;
          }
        }
        if (field.kind === "switchCard" && field.children !== undefined) collect(field.children);
      }
    };
    collect(spec.sections.flatMap((section) => section.fields));
    return errors;
  };
  const fieldErrors = collectErrors(validationAttempted);
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
  const save = async (): Promise<string | null> => {
    if (Object.keys(collectErrors(true)).length > 0) {
      setValidationAttempted(true);
      return copy.invalidMessage;
    }
    if (pending || conflict || !canManageContent) return copy.saveError;
    setPending(true); setError(undefined); setSaved(false);
    try {
      const response = await runModuleQueryWrite(
        queryClient,
        channelId,
        module.id,
        "settings",
        (baselineRevision) => {
          if (baselineRevision === null) throw new Error("Module settings require a baseline revision.");
          return saveChannelModuleSettings(channelId, module.id, baselineRevision, currentValue);
        },
        {
          baselineRevision: currentBaseline.revision,
          updateCache: (current, result) => typeof current === "object" && current !== null
            ? { ...current, ...result }
            : current,
          relatedParts: (module.settingsEditorRelatedParts ?? []).map((part) => ({ moduleId: module.id, part })),
        },
      );
      setValue(response.settings);
      setBaseline({ settings: response.settings, revision: response.revision });
      setDirty(false);
      setSaved(true);
      setValidationAttempted(false);
      setServerWarnings(response.warnings);
      return null;
    } catch (caught) {
      if (caught instanceof PanelApiError && caught.status === 409 && caught.code === "module_settings_changed_concurrently") {
        setConflict(true);
        return copy.conflictMessage;
      }
      const message = caught instanceof PanelApiError ? apiErrorText(caught.code, copy.saveError) : copy.saveError;
      setError(message);
      return message;
    } finally { setPending(false); }
  };
  const discard = (): void => {
    setValue(currentBaseline.settings); setBaseline(currentBaseline); setTouchedFields(new Set()); setValidationAttempted(false);
    setDirty(false); setSaved(false); setConflict(false); setError(undefined); setServerWarnings([]); setLocalIssues({});
  };
  const navigationGuard = useDraftGuard(dirty, save, discard);
  useEffect(() => registerDashboardNavigationGuard(navigationGuard.guardSwitch), [navigationGuard.guardSwitch]);
  const readOnly = !canManageContent ? { reason: copy.readOnlyReason, content: <SettingsEditor spec={spec} sectionId={spec.sections[0]?.id ?? ""} settings={currentValue} onChange={() => undefined} texts={copy} variables={templateVariableOptions} templateMetadata={templateMetadata} templateMessages={copy.templateMessages} createVariableHref={`/channels/${encodeURIComponent(channelId)}/variables`} readOnly enabledLabel={copy.enabledLabel} disabledLabel={copy.disabledLabel} /> } : undefined;
  return <>
    <EditorShell
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
    />
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
      pending={navigationGuard.saving}
      danger
    />
  </>;
};

export const ModulePanelMount = ({ channelId, activeModules, canManage = true, canOperate = true, botIsModerator = null, initialSelection }: ModulePanelMountProperties): ReactElement => {
  const registeredViews = activeModules.flatMap((activeModule) => {
    const module = MODULES.find((candidate) => candidate.id === activeModule.moduleId);
    if (module === undefined) return [];
    const panel = getLazyPanel(module);
    if (panel === null && module.settingsEditor === undefined) return [];
    return [{ id: activeModule.moduleId, Panel: panel, module }];
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
      <Suspense fallback={<p className="muted">{dashboardTexts().module.loadingViews}</p>}>
        {registeredViews.map(({ id, Panel, module }) => <MountedModuleView
          key={`${channelId}:${id}`}
          module={module}
          Panel={Panel}
          channelId={channelId}
          canManage={canManage}
          canOperate={canOperate}
          botIsModerator={botIsModerator}
          {...(initialSelection === undefined ? {} : { initialSelection })}
        />)}
      </Suspense>
    </section>
  );
};

const MountedModuleView = ({ module, Panel, channelId, canManage, canOperate, botIsModerator, initialSelection }: {
  module: (typeof MODULES)[number];
  Panel: LazyExoticComponent<ComponentType<ModulePanelProperties>> | null;
  channelId: string;
  canManage: boolean;
  canOperate: boolean;
  botIsModerator: boolean | null;
  initialSelection?: string;
}): ReactElement => {
  const settingsEditor = <ModuleSettingsEditor
    module={module}
    channelId={channelId}
    canManageContent={canManage}
    language={dashboardLanguage()}
  />;
  return <div className="module-view">
    {module.settingsEditorPlacement === "before-panel" ? settingsEditor : null}
    {Panel === null ? null : <Panel
      channelId={channelId}
      language={dashboardLanguage()}
      canManage={canManage}
      canOperate={canOperate}
      botIsModerator={botIsModerator}
      textBlockConditions={MODULES.flatMap((candidate) => candidate.textBlockConditions ?? [])}
      {...(initialSelection === undefined ? {} : { initialSelection })}
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
  const mandatory = moduleId === "channel_events";
  const permissionsMissing = modulePermissionsAreMissing({ missingBroadcasterScopes: missingScopes });
  const effectiveEnabled = (rawEnabled || mandatory) && !permissionsMissing;
  const state = permissionsMissing ? labels.disabled : statusWord(effectiveEnabled);
  const route: DashboardRoute = { kind: "module", channelId, moduleId };
  const lockedReason = mandatory ? labels.mandatoryReason : manageable ? undefined : texts.module.managementLocked;

  return (
    <ListRow
      href={dashboardRoutePath(route)}
      onNavigate={() => { onNavigate(route); }}
      icon={<ModuleIcon moduleId={moduleId} className="scope-row__icon" />}
      title={details.name}
      description={details.description}
      status={mandatory
        ? <LockedModuleStatus status={labels.alwaysActiveStatus} reason={labels.mandatoryReason} />
        : <Led status={permissionsMissing ? "amber" : effectiveEnabled ? "green" : "off"} label={state} />}
      action={mandatory ? null : <Switch
        checked={rawEnabled}
        ariaLabel={details.name}
        pending={busy}
        disabled={!manageable}
        onChange={onToggle}
        {...(lockedReason === undefined ? {} : { lockedReason })}
      />}
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
 * Just the switchable rows -- no page heading, so the Stream Manager can
 * embed it next to the immediate actions and the event feed. `ModuleWorkspace`
 * below wraps this with the full "Module" page's own heading and error line.
 */
export const ModuleToggleList = ({ channelId, ownRole, modules, onNavigate, onChanged }: ModuleToggleListProperties): ReactElement => {
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
          const mandatory = state?.mandatory === true || module.id === "channel_events";
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
        <PageHeader kind="modules" title={dashboardTexts().navigation.module} subtitle={loading ? dashboardTexts().module.load : dashboardTexts().module.available} />
        <ModuleToggleList key={channelId} channelId={channelId} ownRole={ownRole} modules={modules} onNavigate={onNavigate} onChanged={onChanged} />
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
  ownRole: ChannelRole;
  modules: PanelModuleState[];
  activeModules: PanelActiveModule[];
  loading?: boolean;
  error?: string | null;
  busy?: boolean;
  botIsModerator?: boolean | null;
  onNavigate: (route: DashboardRoute) => void;
  onToggle: () => void;
  /** Deep-link target from Spotlight (#164), e.g. a text command name. */
  initialSelection?: string;
}

export const ModulePage = ({ channelId, moduleId, ownRole, modules, activeModules, loading = false, error = null, busy = false, botIsModerator = null, onNavigate, onToggle, initialSelection }: ModulePageProperties): ReactElement => {
  const texts = dashboardTexts();
  const labels = workspaceTexts();
  const details = moduleDetails(moduleId);
  const registered = MODULES.find((candidate) => candidate.id === moduleId);
  const navigationPage = registered?.navigationEntries?.find((entry) => entry.showMainSwitch === false);
  const moduleState = modules.find((candidate) => candidate.id === moduleId);
  const activeModule = activeModules.find((candidate) => candidate.moduleId === moduleId);
  const mandatory = moduleState?.mandatory === true || moduleId === "channel_events";
  const enabled = mandatory || moduleState?.enabled === true;
  const manageable = canManageModules(ownRole);
  const disabledReason = mandatory ? labels.mandatoryReason : manageable ? null : texts.module.managementLocked;
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
        />
        {registered?.chatCommands === undefined ? null : <ChatCommands commands={registered.chatCommands} />}
        {navigationPage?.showMainSwitch === false ? null : <section className="module-detail__switch inspector-section--switch" aria-label={labels.status}>
          <div>
            <strong>{labels.mainSwitch}</strong>
            {mandatory
              ? <LockedModuleStatus status={labels.alwaysActiveStatus} reason={labels.mandatoryReason} />
              : <Led status={effectiveEnabled ? "green" : "off"} label={statusWord(effectiveEnabled)} />}
          </div>
          {mandatory ? null : <ModuleSwitch moduleId={moduleId} enabled={effectiveEnabled} disabled={!manageable || switchDisabled} busy={busy} onToggle={onToggle} />}
            {disabledReason === null ? null : <p className="lock-reason lock-reason--with-icon"><Icon name="lock" size={16} />{disabledReason}</p>}
        </section>}
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
              <ModulePanelMount key={`${channelId}:${moduleId}`} channelId={channelId} activeModules={[activeModule]} canManage={ownRole !== "operator"} canOperate={true} botIsModerator={botIsModerator} {...(initialSelection === undefined ? {} : { initialSelection })} />
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
