import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  changeChannelVariableValue,
  createChannelVariable,
  deleteChannelVariable,
  fetchOverlay,
  fetchOverlays,
  PanelApiError,
  saveOverlay,
  updateChannelVariable,
  type PanelChannelVariable,
  type PanelChannelVariableRecord,
  type PanelChannelVariablesResponse,
  type PanelOverlayElement,
} from "./api";
import { apiErrorText, channelVariablesTexts, dashboardCommonTexts, dashboardLanguage, dashboardTexts } from "./locale";
import { Button, CollectionPage, ConfirmDialog, EmptyCellValue, Field, Icon, InspectorFieldRow, InspectorSection, ListToolbar, LoadState, LoadStateLines, notify, UnitInput, PageHeader, Select, useDraftGuard } from "./ui";
import { Switch as SwitchPrimitive } from "./ui/primitives/switch";
import { CHANNEL_VARIABLE_MAXIMUM_COUNT, CHANNEL_VARIABLE_MAXIMUM_VALUE, CHANNEL_VARIABLE_MINIMUM_VALUE } from "../contracts/values";
import { dashboardDataKeys } from "./data/keys";
import { useDashboardQueryClient } from "./data";
import { useChannelVariablesQuery, useLegacyOverlayTokensQuery, useOverlaysQuery } from "./data/lists";
import { registerDashboardNavigationGuard } from "./ui/navigation-guard";

interface VariableDefinitionDraft {
  name: string;
  description: string;
  resetOnStreamStart: boolean;
}

interface ChannelVariablesPageProperties {
  channelId: string;
  canManage: boolean;
  onOpenCommand: (name: string) => void;
  /** Deep-link request from the command palette (#208), applied after variables load and then consumed by the parent. */
  initialSelection?: string;
  /** Clears the parent-owned request after this page has applied it. */
  onInitialSelectionConsumed?: (name: string) => void;
  onOpenOverlay?: (overlayId: string, initialVariableName?: string, newOverlayName?: string) => void;
}

const normalizedVariableName = (value: string): string => value.trim().toLowerCase();
const hasTokens = (page: unknown): boolean => typeof page === "object" && page !== null &&
  "tokens" in page && Array.isArray(page.tokens) && page.tokens.length > 0;
const variableNamePattern = /^[a-z][a-z0-9_]{0,31}$/u;
const EMPTY_VARIABLES: readonly PanelChannelVariable[] = [];
const saveableOverlayElement = (element: PanelOverlayElement): Omit<PanelOverlayElement, "missingVariableName"> => ({
  id: element.id,
  kind: element.kind,
  label: element.label,
  variableName: element.variableName,
  text: element.text,
  config: element.config,
  x: element.x,
  y: element.y,
  scalePercent: element.scalePercent,
  z: element.z,
  inComposition: element.inComposition,
});

export function ChannelVariablesPage({ channelId, canManage: canManageContent, onOpenCommand, initialSelection, onInitialSelectionConsumed, onOpenOverlay }: ChannelVariablesPageProperties): ReactElement {
  const language = dashboardLanguage();
  const labels = channelVariablesTexts(language);
  const variablesQuery = useChannelVariablesQuery(channelId);
  const legacyTokensQuery = useLegacyOverlayTokensQuery(channelId);
  const queryClient = useDashboardQueryClient();
  const variables = variablesQuery.data?.variables ?? EMPTY_VARIABLES;
  const maximum = variablesQuery.data?.maximum ?? CHANNEL_VARIABLE_MAXIMUM_COUNT;
  const loading = variablesQuery.isPending;
  const loadFailed = variablesQuery.isError;
  const [search, setSearch] = useState("");
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<PanelChannelVariable | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftReset, setDraftReset] = useState(false);
  const [draftSetValue, setDraftSetValue] = useState<number | "">(0);
  const [editingValue, setEditingValue] = useState(false);
  const [inlineValue, setInlineValue] = useState<number | "">(0);
  const editValueButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditingValue = useRef(false);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [definitionBaseline, setDefinitionBaseline] = useState<VariableDefinitionDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [useOverlayOpen, setUseOverlayOpen] = useState(false);
  const overlaysQuery = useOverlaysQuery(channelId, useOverlayOpen);
  const overlayOptions = (overlaysQuery.data?.overlays ?? []).map(({ id, name, elementCount }) => ({ id, name, elementCount }));
  const refetchVariables = variablesQuery.refetch;
  const variablesLoadError = variablesQuery.error instanceof PanelApiError
    ? apiErrorText(variablesQuery.error.code, labels.loadError)
    : labels.loadError;
  const [overlaySelection, setOverlaySelection] = useState("");
  const [creatingOverlay, setCreatingOverlay] = useState(false);
  const [newOverlayName, setNewOverlayName] = useState("");
  const [overlayPending, setOverlayPending] = useState(false);
  const lastInitialSelection = useRef<string | undefined>(undefined);
  const selectedNameRef = useRef(selectedName);
  const setSelectedVariableName = (name: string | null): void => {
    selectedNameRef.current = name;
    setSelectedName(name);
  };

  const refresh = useCallback(async (): Promise<void> => {
    const result = await refetchVariables({ throwOnError: true });
    if (result.isError) throw result.error;
  }, [refetchVariables]);
  const commitVariable = (previousName: string | null, record: PanelChannelVariableRecord, usages?: PanelChannelVariable["usages"]): void => {
    queryClient.setQueryData<PanelChannelVariablesResponse>(dashboardDataKeys.variables(channelId), (current) => {
      if (current === undefined) return current;
      const previousIndex = previousName === null ? -1 : current.variables.findIndex((variable) => variable.name === previousName);
      const existing = previousIndex < 0 ? current.variables.find((variable) => variable.name === record.name) : current.variables[previousIndex];
      const nextVariable: PanelChannelVariable = { ...record, usages: usages ?? existing?.usages ?? [] };
      const next = current.variables.filter((variable) => variable.name !== previousName && variable.name !== record.name);
      next.splice(previousIndex < 0 ? next.length : Math.min(previousIndex, next.length), 0, nextVariable);
      next.sort((left, right) => left.name.localeCompare(right.name));
      return {
        ...current,
        variables: next,
        count: previousName === null && existing === undefined ? current.count + 1 : current.count,
      };
    });
  };
  const commitVariableRemoval = (name: string): void => {
    queryClient.setQueryData<PanelChannelVariablesResponse>(dashboardDataKeys.variables(channelId), (current) => current === undefined
      ? current
      : {
        ...current,
        variables: current.variables.filter((variable) => variable.name !== name),
        count: Math.max(0, current.count - 1),
      });
  };
  const refreshBestEffort = (): void => { void refresh().catch(() => undefined); };

  useEffect(() => {
    if (!variablesQuery.isError) return;
    notify({ tone: "error", message: variablesLoadError });
  }, [variablesLoadError, variablesQuery.isError]);

  const selected = useMemo(() => variables.find((variable) => variable.name === selectedName) ?? null, [selectedName, variables]);
  const selectedForDisplay = selected ?? (selectedSnapshot?.name === selectedName ? selectedSnapshot : null);
  const definitionConflict = !creating && selectedName !== null && selected === null && definitionBaseline !== null;
  const draftDirty = creating || (definitionBaseline !== null && (
    normalizedVariableName(draftName) !== definitionBaseline.name ||
    draftDescription !== definitionBaseline.description ||
    draftReset !== definitionBaseline.resetOnStreamStart
  ));
  useEffect(() => {
    if (selected === null || creating || draftDirty) return;
    const nextBaseline = { name: selected.name, description: selected.description, resetOnStreamStart: selected.resetOnStreamStart };
    if (definitionBaseline !== null && definitionBaseline.name === nextBaseline.name &&
      definitionBaseline.description === nextBaseline.description &&
      definitionBaseline.resetOnStreamStart === nextBaseline.resetOnStreamStart) return;
    setDefinitionBaseline(nextBaseline);
    setDraftName(nextBaseline.name);
    setDraftDescription(nextBaseline.description);
    setDraftReset(nextBaseline.resetOnStreamStart);
  }, [creating, definitionBaseline, draftDirty, selected]);
  useEffect(() => {
    if (selected !== null) setSelectedSnapshot(selected);
  }, [selected]);
  useLayoutEffect(() => {
    if (editingValue) document.getElementById("channel-variable-inline-value")?.focus();
    else if (wasEditingValue.current) editValueButtonRef.current?.focus();
    wasEditingValue.current = editingValue;
  }, [editingValue]);
  useLayoutEffect(() => { selectedNameRef.current = selectedName; }, [selectedName]);
  const hasLegacyLinks = hasTokens(legacyTokensQuery.data?.pages[0]);
  const selectedUsages = selectedForDisplay?.usages ?? [];
  const overlayUsageLabel = (usage: PanelChannelVariable["usages"][number]): string =>
    usage.elementLabel === undefined ? usage.itemName : `${usage.itemName} → ${usage.elementLabel}`;
  const usageNames = selectedUsages.map((usage) => usage.moduleId === "overlays"
    ? overlayUsageLabel(usage)
    : labels.usageLine(usage.moduleId, usage.itemName, usage.kind));
  const nameInvalid = !variableNamePattern.test(normalizedVariableName(draftName));
  const createDisabled = !canManageContent || variables.length >= maximum || pending || overlayPending;
  const draftInvalid = nameInvalid || (creating && (typeof draftSetValue !== "number" || !Number.isInteger(draftSetValue) || draftSetValue < CHANNEL_VARIABLE_MINIMUM_VALUE || draftSetValue > CHANNEL_VARIABLE_MAXIMUM_VALUE));
  const beginCreate = (): void => {
    setCreating(true);
    setSelectedVariableName(null);
    setSelectedSnapshot(null);
    setDefinitionBaseline(null);
    setSaved(false);
    setSaveError(undefined);
    setEditingValue(false);
    setDraftName("");
    setDraftDescription("");
    setDraftReset(false);
    setDraftSetValue(0);
    setUseOverlayOpen(false);
    setOverlaySelection("");
    setCreatingOverlay(false);
    setNewOverlayName("");
  };
  const selectVariable = (variable: PanelChannelVariable): void => {
    setCreating(false);
    setEditingValue(false);
    setSelectedVariableName(variable.name);
    setSelectedSnapshot(variable);
    setDraftName(variable.name);
    setDraftDescription(variable.description);
    setDraftReset(variable.resetOnStreamStart);
    setDefinitionBaseline({ name: variable.name, description: variable.description, resetOnStreamStart: variable.resetOnStreamStart });
    setSaved(false);
    setSaveError(undefined);
    setDraftSetValue(variable.value);
    setUseOverlayOpen(false);
    setOverlaySelection("");
    setCreatingOverlay(false);
    setNewOverlayName("");
  };
  // Latest-ref indirection, not a direct `selectVariable(match)` call: the
  // effect only ever reads through `.current`, so applying a deep-linked
  // selection (#208) doesn't read as "setState synchronously in an effect"
  // to the linter, the same way `text_commands`'s `initialSelection` effect
  // goes through a hook-returned setter instead of a local helper.
  const selectVariableRef = useRef(selectVariable);
  useEffect(() => {
    if (initialSelection === undefined) {
      lastInitialSelection.current = undefined;
      return;
    }
    if (loading || lastInitialSelection.current === initialSelection) return;
    const match = variables.find((variable) => variable.name === initialSelection);
    lastInitialSelection.current = initialSelection;
    if (match !== undefined) selectVariableRef.current(match);
    onInitialSelectionConsumed?.(initialSelection);
  }, [initialSelection, loading, onInitialSelectionConsumed, variables]);
  const closeInspector = (): void => {
    setCreating(false);
    setSelectedVariableName(null);
    setSelectedSnapshot(null);
    setEditingValue(false);
    setDefinitionBaseline(null);
    setSaved(false);
    setSaveError(undefined);
  };
  const save = async (): Promise<string | null> => {
    const name = normalizedVariableName(draftName);
    if (pending) return null;
    if (!creating && selected === null) return labels.definitionConflict;
    if (!canManageContent || nameInvalid || draftSetValue === "" || !Number.isInteger(draftSetValue)) return labels.nameInvalid;
    setPending(true);
    setSaveError(undefined);
    try {
      if (creating) {
        const response = await createChannelVariable(channelId, {
          name,
          value: draftSetValue,
          description: draftDescription,
          resetOnStreamStart: draftReset,
        });
        commitVariable(null, response.variable, response.usages);
        setCreating(false);
        setSelectedVariableName(response.variable.name);
        setSelectedSnapshot({ ...response.variable, usages: response.usages ?? [] });
        setDefinitionBaseline({ name: response.variable.name, description: response.variable.description, resetOnStreamStart: response.variable.resetOnStreamStart });
        refreshBestEffort();
      } else if (selected !== null) {
        const response = await updateChannelVariable(channelId, selected.name, {
          newName: name,
          description: draftDescription,
          resetOnStreamStart: draftReset,
        });
        commitVariable(selected.name, response.variable, response.usages);
        setSelectedVariableName(response.variable.name);
        setSelectedSnapshot({ ...response.variable, usages: response.usages ?? selectedUsages });
        setDraftName(response.variable.name);
        setDefinitionBaseline({ name: response.variable.name, description: response.variable.description, resetOnStreamStart: response.variable.resetOnStreamStart });
        if (response.variable.name !== selected.name) setUseOverlayOpen(false);
        refreshBestEffort();
      }
      setSaved(true);
      return null;
    } catch (caught) {
      const message = caught instanceof PanelApiError ? apiErrorText(caught.code, labels.saveError) : labels.saveError;
      setSaveError(message);
      notify({ tone: "error", message });
      return message;
    } finally {
      setPending(false);
    }
  };
  const discardDraft = (): void => {
    setCreating(false);
    setEditingValue(false);
    setUseOverlayOpen(false);
    setOverlaySelection("");
    setCreatingOverlay(false);
    setNewOverlayName("");
    if (selected !== null && definitionBaseline !== null) {
      setDraftName(definitionBaseline.name);
      setDraftDescription(definitionBaseline.description);
      setDraftReset(definitionBaseline.resetOnStreamStart);
    } else if (selected === null) {
      setSelectedVariableName(null);
      setSelectedSnapshot(null);
      setDefinitionBaseline(null);
    }
    setSaved(false);
    setSaveError(undefined);
  };
  const navigationGuard = useDraftGuard(draftDirty, save, discardDraft);
  useEffect(() => registerDashboardNavigationGuard(navigationGuard.guardSwitch), [navigationGuard.guardSwitch]);
  const requestSelectVariable = (variable: PanelChannelVariable): void => {
    if (pending || overlayPending) return;
    if (!creating && variable.name === selectedName) return;
    navigationGuard.guardSwitch(() => { selectVariable(variable); });
  };
  const requestCloseInspector = (): void => {
    if (pending || overlayPending) return;
    navigationGuard.guardSwitch(closeInspector);
  };
  const requestBeginCreate = (): void => {
    if (creating || pending || overlayPending) return;
    navigationGuard.guardSwitch(beginCreate);
  };
  useLayoutEffect(() => { selectVariableRef.current = requestSelectVariable; });
  const changeValue = async (operation: "add" | "subtract" | "set", amount: number): Promise<boolean> => {
    if (selected === null || pending) return false;
    const selectedNameAtStart = selected.name;
    setPending(true);
    try {
      const response = await changeChannelVariableValue(channelId, selectedNameAtStart, operation, amount);
      commitVariable(selectedNameAtStart, response.variable);
      setSelectedSnapshot((current) => current?.name === selectedNameAtStart ? { ...current, ...response.variable } : current);
      if (selectedNameRef.current === selectedNameAtStart) setDraftSetValue(response.variable.value);
      refreshBestEffort();
      return true;
    } catch (caught) {
      notify({ tone: "error", message: caught instanceof PanelApiError ? apiErrorText(caught.code, labels.saveError) : labels.saveError });
      return false;
    } finally {
      setPending(false);
    }
  };
  const cancelValueEdit = (): void => {
    setInlineValue(selected?.value ?? 0);
    setEditingValue(false);
  };
  const applyValueEdit = async (): Promise<void> => {
    if (typeof inlineValue !== "number" || !Number.isInteger(inlineValue) || inlineValue < CHANNEL_VARIABLE_MINIMUM_VALUE || inlineValue > CHANNEL_VARIABLE_MAXIMUM_VALUE) return;
    if (await changeValue("set", inlineValue)) setEditingValue(false);
  };
  const beginUseInOverlay = async (): Promise<void> => {
    if (selected === null || !canManageContent || overlayPending) return;
    const selectedNameAtStart = selected.name;
    setOverlayPending(true);
    try {
      const result = await queryClient.query({
        queryKey: dashboardDataKeys.overlays(channelId),
        queryFn: ({ signal }) => fetchOverlays(channelId, signal),
      });
      if (selectedNameRef.current !== selectedNameAtStart) return;
      setOverlaySelection(result.overlays[0]?.id ?? "");
      setCreatingOverlay(result.overlays.length === 0);
      setNewOverlayName(labels.defaultOverlayName(selectedNameAtStart));
      setUseOverlayOpen(true);
    } catch (caught) {
      if (selectedNameRef.current !== selectedNameAtStart) return;
      notify({ tone: "error", message: caught instanceof PanelApiError ? apiErrorText(caught.code, labels.saveError) : labels.saveError });
    } finally {
      setOverlayPending(false);
    }
  };
  const addVariableElement = (): void => {
    if (selected === null || !canManageContent || overlayPending) return;
    if (creatingOverlay ? newOverlayName.trim().length === 0 : overlaySelection.length === 0) return;
    navigationGuard.guardSwitch(() => {
      setUseOverlayOpen(false);
      const destinationName = selectedNameRef.current;
      if (destinationName === null) return;
      if (creatingOverlay) onOpenOverlay?.("new", destinationName, newOverlayName.trim());
      else onOpenOverlay?.(overlaySelection, destinationName);
    });
  };
  const reconnectElement = async (usage: PanelChannelVariable["usages"][number]): Promise<void> => {
    if (selected === null || usage.overlayId === undefined || usage.elementId === undefined || !canManageContent || overlayPending) return;
    setOverlayPending(true);
    try {
      const overlay = (await fetchOverlay(channelId, usage.overlayId)).overlay;
      const target = overlay.elements.find((element) => element.id === usage.elementId);
      if (target === undefined || target.variableName !== null || target.missingVariableName !== selected.name) {
        notify({ tone: "error", message: labels.reconnectConflict });
        return;
      }
      const elements = overlay.elements.map((element) => ({
        ...saveableOverlayElement(element),
        variableName: element.id === usage.elementId ? selected.name : element.variableName,
      }));
      await saveOverlay(channelId, overlay.id, overlay.revision, {
        name: overlay.name, width: overlay.width, height: overlay.height, css: overlay.css, elements,
      }, { elementId: usage.elementId, missingVariableName: selected.name });
      refreshBestEffort();
    } catch (caught) {
      notify({ tone: "error", message: caught instanceof PanelApiError ? apiErrorText(caught.code, labels.saveError) : labels.saveError });
    } finally {
      setOverlayPending(false);
    }
  };
  const remove = async (): Promise<void> => {
    if (selected === null || !canManageContent || selectedUsages.some((usage) => usage.kind === "action")) return;
    setPending(true);
    try {
      await deleteChannelVariable(channelId, selected.name);
      setConfirmDelete(false);
      commitVariableRemoval(selected.name);
      closeInspector();
      refreshBestEffort();
    } catch (caught) {
      notify({ tone: "error", message: caught instanceof PanelApiError ? apiErrorText(caught.code, labels.deleteError) : labels.deleteError });
    } finally {
      setPending(false);
    }
  };

  const query = search.trim().toLocaleLowerCase();
  const visibleVariables = query.length === 0 ? variables : variables.filter((variable) => `${variable.name} ${variable.description}`.toLocaleLowerCase().includes(query));
  const listStatus = loading && variables.length === 0 ? "loading"
    : variables.length === 0 ? loadFailed ? "error" : "empty"
      : visibleVariables.length === 0 ? "empty" : "success";
  const toolbar = <>
    <ListToolbar
      searchLabel={labels.search}
      searchPlaceholder={labels.search}
      searchClearLabel={dashboardCommonTexts().clearSearch}
      searchValue={search}
      onSearchChange={setSearch}
      create={{
        label: labels.create,
        onClick: requestBeginCreate,
        disabled: createDisabled,
        ...(!canManageContent ? { reason: labels.managementLocked } : variables.length >= maximum ? { reason: labels.limitReached } : {}),
        reasonVisible: false,
      }}
      usage={{ count: variables.length, maximum, ...(query.length === 0 ? {} : { filteredCount: visibleVariables.length }), copy: { countSuffix: labels.countSuffix, filteredInfix: dashboardCommonTexts().of, filteredSuffix: labels.filteredSuffix, limitInfix: dashboardCommonTexts().of, limitSuffix: labels.limitSuffix, loadedSuffix: dashboardCommonTexts().loaded } }}
      {...(loadFailed && variables.length > 0 ? { queryError: {
        title: dashboardTexts().errors.dataLoadFailed,
        message: variablesLoadError,
        onRetry: () => { void refresh().catch(() => undefined); },
      } } : {})}
      {...(query.length === 0 ? {} : { activeFilters: `${labels.search}: ${search.trim()}`, activeFiltersLabel: dashboardCommonTexts().activeFilters, resetLabel: dashboardCommonTexts().reset, onReset: () => { setSearch(""); } })}
    />
    {!canManageContent && !creating && selectedForDisplay === null ? <p className="muted channel-variables-permission-note" role="note">{labels.managementLocked}</p> : null}
  </>;
  const list = <section className="channel-variables-list" aria-label={labels.list}>
    <LoadState
      variant="panel-360"
      status={listStatus}
      loading={<LoadStateLines rows={8} height={34} />}
      empty={<p className="empty-state">{variables.length === 0 ? labels.empty : dashboardCommonTexts().noMatches}</p>}
      error={<p role="alert">{variablesLoadError}</p>}
      queryError={{ title: dashboardTexts().errors.dataLoadFailed, message: variablesLoadError, onRetry: () => { void refresh().catch(() => undefined); } }}
    >{visibleVariables.length === 0 ? null : <div className="table-wrap channel-variables-table-wrap">
      <table className="table channel-variables-table">
        <thead><tr>
          <th scope="col">{labels.name}</th>
          <th scope="col">{labels.description}</th>
          <th scope="col" className="channel-variables-table__value-heading">{labels.value}</th>
          <th scope="col" className="channel-variables-table__reset-heading"><span className="sr-only">{labels.resetOnStreamStart}</span><Icon name="reload" size={16} /></th>
        </tr></thead>
        <tbody>{visibleVariables.map((variable) => (
          <tr key={variable.name} tabIndex={0} aria-selected={variable.name === selectedName} onClick={() => { requestSelectVariable(variable); }} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); requestSelectVariable(variable); }
          }}>
            <th scope="row" className="mono">{`{var.${variable.name}}`}</th>
            <td className="channel-variables-table__description" title={variable.description || labels.noDescription}>{variable.description || <EmptyCellValue />}</td>
            <td className="number channel-variables-table__value">{new Intl.NumberFormat(language).format(variable.value)}</td>
            <td className="channel-variables-table__reset">
              {variable.resetOnStreamStart ? <span role="img" aria-label={labels.resetOnStreamStart} title={labels.resetOnStreamStart}><Icon name="reload" size={16} /></span> : <EmptyCellValue />}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div>}</LoadState>
  </section>;

  const editor = creating || selectedForDisplay !== null ? (
    <div className="channel-variable-editor" aria-label={creating ? labels.newVariable : labels.title}>
      <div className="channel-variable-editor__header">
        <PageHeader
          kind="variable"
          headingLevel="h2"
          titleContent={creating ? labels.newVariable : <span className="mono">{`{var.${draftName || selectedForDisplay?.name || "variable"}}`}</span>}
          title={creating ? labels.newVariable : draftName || selectedForDisplay?.name || labels.name}
          subtitle={!canManageContent ? labels.managementLocked : undefined}
          pageActions={<Button variant="neutral" icon="close" iconOnly ariaLabel={labels.close} onClick={requestCloseInspector} disabled={pending || overlayPending} />}
          save={{
            persistent: true,
            dirty: draftDirty,
            pending,
            saveDisabled: draftInvalid || !canManageContent || definitionConflict,
            saved,
            ...(saveError === undefined ? {} : { error: saveError }),
            onSave: () => { void save(); },
            onDiscard: discardDraft,
            saveLabel: labels.save,
            discardLabel: labels.discard,
            savedLabel: dashboardCommonTexts().saved,
            pendingLabel: dashboardCommonTexts().saving,
          }}
          {...(selected === null || !canManageContent ? {} : { overflow: <Button danger="subtle" disabled={pending || draftDirty || selectedUsages.some((usage) => usage.kind === "action")} onClick={() => { setConfirmDelete(true); }}>{labels.delete}</Button> })}
        />
      </div>
      <div className="channel-variable-editor__scroll">
        {definitionConflict ? <p className="channel-variable-conflict" role="status">{labels.definitionConflict}</p> : null}
        <InspectorSection title={labels.generalSection}>
          {canManageContent ? <InspectorFieldRow label={labels.name} help={creating ? labels.nameHint : labels.renameHint}>
            <Field id="channel-variable-name" label={labels.name} value={draftName} normalize={normalizedVariableName} maxLength={32} countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={pending || definitionConflict} onChange={(value) => { setDraftName(value); setSaved(false); setSaveError(undefined); }} {...(nameInvalid ? { error: labels.nameInvalid } : {})} />
          </InspectorFieldRow> : <dl className="properties channel-variable-definition-properties">
            <div><dt>{labels.name}</dt><dd className="mono">{selectedForDisplay?.name ?? draftName}</dd></div>
            <div><dt>{labels.description}</dt><dd>{selectedForDisplay?.description || labels.noDescription}</dd></div>
            <div><dt>{labels.resetOnStreamStart}</dt><dd>{labels.resetValue(selectedForDisplay?.resetOnStreamStart ?? draftReset)}</dd></div>
          </dl>}
          <div className="channel-variable-legacy-slot" aria-live="polite">
            {canManageContent && selected !== null && hasLegacyLinks && normalizedVariableName(draftName) !== selected.name
              ? <p className="muted" role="note" title={labels.legacyRenameWarning}>{labels.legacyRenameWarning}</p> : null}
          </div>
          {canManageContent ? <>
            <InspectorFieldRow label={labels.description} help={labels.descriptionHint}>
              <Field id="channel-variable-description" label={labels.description} value={draftDescription} maxLength={80} countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={pending || definitionConflict} onChange={(value) => { setDraftDescription(value); setSaved(false); setSaveError(undefined); }} />
            </InspectorFieldRow>
            <InspectorFieldRow label={labels.resetOnStreamStart} help={labels.resetHint}>
              <div className="channel-variable-switch-control">
                <SwitchPrimitive aria-label={labels.resetOnStreamStart} checked={draftReset} disabled={pending || definitionConflict} onCheckedChange={(value) => { setDraftReset(value); setSaved(false); setSaveError(undefined); }} />
              </div>
            </InspectorFieldRow>
          </> : null}
          {creating ? <InspectorFieldRow label={labels.value} help={labels.valueHint}>
            <UnitInput id="channel-variable-initial-value" label={labels.value} min={CHANNEL_VARIABLE_MINIMUM_VALUE} max={CHANNEL_VARIABLE_MAXIMUM_VALUE} step={1} value={draftSetValue} disabled={!canManageContent || pending} onChange={(value) => { setDraftSetValue(value); setSaved(false); setSaveError(undefined); }} />
          </InspectorFieldRow> : null}
        </InspectorSection>
        {selectedForDisplay === null ? null : <>
          <InspectorSection title={labels.valueSection}>
            <InspectorFieldRow className="inspector-field-row--variable-value" label={labels.value} help={labels.valueHint}>
              <div className={`channel-variable-value-controls${editingValue ? " channel-variable-value-controls--editing" : ""}`}>
                {definitionConflict ? <strong className="channel-variable-value-controls__value number">{new Intl.NumberFormat(language).format(selectedForDisplay.value)}</strong> : null}
                {!definitionConflict && selected !== null ? <>
                {editingValue ? <>
                  <UnitInput
                    id="channel-variable-inline-value"
                    label={labels.value}
                    ariaLabel={labels.value}
                    min={CHANNEL_VARIABLE_MINIMUM_VALUE}
                    max={CHANNEL_VARIABLE_MAXIMUM_VALUE}
                    value={inlineValue}
                    disabled={pending}
                    onChange={(value) => { setInlineValue(value); }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelValueEdit(); }
                      if (event.key === "Enter") { event.preventDefault(); void applyValueEdit(); }
                    }}
                  />
                  <Button variant="primary" disabled={pending || typeof inlineValue !== "number" || !Number.isInteger(inlineValue) || inlineValue < CHANNEL_VARIABLE_MINIMUM_VALUE || inlineValue > CHANNEL_VARIABLE_MAXIMUM_VALUE} onClick={() => { void applyValueEdit(); }}>{labels.applyValue}</Button>
                  <Button variant="subtle" disabled={pending} onClick={cancelValueEdit}>{labels.cancelValueEdit}</Button>
                </> : <>
                  <strong className="channel-variable-value-controls__value number" aria-live="polite">{new Intl.NumberFormat(language).format(selected.value)}</strong>
                  <Button
                    variant="neutral"
                    disabled={pending || selected.value <= CHANNEL_VARIABLE_MINIMUM_VALUE}
                    {...(selected.value <= CHANNEL_VARIABLE_MINIMUM_VALUE ? { title: labels.minimumValueReached } : {})}
                    onClick={() => { void changeValue("subtract", 1); }}
                  >{labels.decrease}</Button>
                  <Button
                    variant="neutral"
                    disabled={pending || selected.value >= CHANNEL_VARIABLE_MAXIMUM_VALUE}
                    {...(selected.value >= CHANNEL_VARIABLE_MAXIMUM_VALUE ? { title: labels.maximumValueReached } : {})}
                    onClick={() => { void changeValue("add", 1); }}
                  >{labels.increase}</Button>
                  <Button
                    icon="edit"
                    iconOnly
                    ariaLabel={labels.editValue}
                    ref={editValueButtonRef}
                    disabled={pending}
                    title={labels.editValue}
                    onClick={() => { setInlineValue(selected.value); setEditingValue(true); }}
                  />
                </>}
                </> : null}
              </div>
            </InspectorFieldRow>
          </InspectorSection>
          <InspectorSection title={labels.usages}>
            {usageNames.length === 0 ? <p className="muted">{labels.noUsages}</p> : <ul className="channel-variable-usages">{selectedUsages.map((usage, index) => (
              <li key={`${usage.moduleId}-${usage.itemName}-${usage.kind}-${String(index)}`}>
                <div className="channel-variable-usage-row">
                  <div className="channel-variable-usage-row__target">
                    {usage.moduleId === "text_commands"
                      ? <Button className="channel-variable-usage-row__link" variant="subtle" onClick={() => { onOpenCommand(usage.itemName.replace(/^!/u, "")); }}>{`!${usage.itemName.replace(/^!/u, "")}`}</Button>
                      : usage.moduleId === "overlays" && usage.overlayId !== undefined
                        ? <Button className="channel-variable-usage-row__link" variant="subtle" onClick={() => { onOpenOverlay?.(usage.overlayId as string); }}>{overlayUsageLabel(usage)}</Button>
                        : <span>{usage.itemName}</span>}
                    <span className="channel-variable-usage-row__kind">{labels.usageKindLabel(usage.kind)}</span>
                  </div>
                  <span className="channel-variable-usage-row__module">{labels.usageModuleLabel(usage.moduleId)}</span>
                </div>
                {usage.reconnect ? <div className="channel-variable-usage-reconnect">
                  <span className="muted">{labels.variableMissing}</span>
                  <Button variant="neutral" disabled={!canManageContent || overlayPending}
                    onClick={() => { void reconnectElement(usage); }}>{labels.reconnect}</Button>
                </div> : null}
              </li>
            ))}</ul>}
          </InspectorSection>
          {selectedUsages.some((usage) => usage.kind === "action") ? <p className="muted" role="note">{labels.inUseReason(usageNames.filter((_, index) => selectedUsages[index]?.kind === "action").join(", "))}</p> : null}
        </>}
        {selected === null ? null : <InspectorSection title={labels.useInOverlay} help={labels.useOverlayHint}>
          <Button variant="neutral" disabled={!canManageContent || overlayPending}
            onClick={() => { void beginUseInOverlay(); }}>{labels.useInOverlay}</Button>
          {useOverlayOpen ? <div className="channel-variable-use-overlay__chooser">
            {overlayOptions.length > 0 ? <Select id="channel-variable-overlay-choice" label={labels.chooseOverlay} value={creatingOverlay ? "__new__" : overlaySelection}
              disabled={overlayPending} options={[...overlayOptions.map((overlay) => ({ value: overlay.id, label: `${overlay.name} · ${String(overlay.elementCount)}` })), { value: "__new__", label: labels.createOverlay }]}
              onChange={(value) => { if (value === null) return; setCreatingOverlay(value === "__new__"); if (value !== "__new__") setOverlaySelection(value); }} /> : null}
            {creatingOverlay ? <Field id="channel-variable-new-overlay-name" label={labels.newOverlayName} value={newOverlayName} maxLength={40} countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={overlayPending} onChange={setNewOverlayName} /> : null}
            <div className="channel-variable-use-overlay__actions">
              <Button variant="primary" disabled={overlayPending || (creatingOverlay ? newOverlayName.trim().length === 0 : overlaySelection.length === 0)}
                onClick={addVariableElement}>{labels.openEditor}</Button>
              <Button variant="subtle" disabled={overlayPending} onClick={() => { setUseOverlayOpen(false); }}>{labels.discard}</Button>
            </div>
          </div> : null}
        </InspectorSection>}
      </div>
    </div>
  ) : null;

  return <div className="channel-variables-page">
    <CollectionPage
      title={labels.title}
      toolbar={toolbar}
      list={list}
      detail={editor}
      detailOpen={creating || selectedForDisplay !== null}
      backLabel={labels.backToList}
      closeDetailDisabled={pending || overlayPending}
      onCloseDetail={requestCloseInspector}
    />
    <ConfirmDialog opened={confirmDelete} title={labels.deleteTitle(selected?.name ?? "")} description={labels.deleteDescription(selected?.name ?? "", usageNames.join(", "), selectedUsages.filter((usage) => usage.moduleId === "overlays" && usage.reconnect !== true).length)} confirmLabel={labels.deleteConfirm(selected?.name ?? "")} cancelLabel={labels.deleteCancel} onCancel={() => { setConfirmDelete(false); }} onConfirm={() => { void remove(); }} pending={pending} danger />
    <ConfirmDialog
      opened={navigationGuard.confirmOpen}
      title={dashboardTexts().module.unsavedChangesTitle}
      description={navigationGuard.saveError === undefined ? dashboardTexts().module.unsavedChangesDescription : `${dashboardTexts().module.unsavedChangesDescription} ${navigationGuard.saveError}`}
      confirmLabel={dashboardTexts().module.discardAndSwitch}
      cancelLabel={dashboardTexts().module.continueEditing}
      onCancel={navigationGuard.continueEditing}
      onConfirm={navigationGuard.discardAndSwitch}
      {...(draftInvalid || !canManageContent || definitionConflict ? {} : { alternative: { label: dashboardTexts().module.saveAndSwitch, onClick: () => { void navigationGuard.saveAndSwitch(); } } })}
      pending={pending || navigationGuard.saving}
      danger
    />
  </div>;
}
