import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  changeChannelVariableValue,
  createChannelVariable,
  deleteChannelVariable,
  fetchOverlay,
  fetchOverlays,
  fetchOverlayTokens,
  fetchChannelVariables,
  PanelApiError,
  saveOverlay,
  updateChannelVariable,
  type PanelChannelVariable,
  type PanelOverlayElement,
} from "./api";
import { apiErrorText, channelVariablesTexts, dashboardLanguage } from "./locale";
import { useRealtimeVariableUpdates } from "./realtime";
import { Button, ConfirmDialog, Field, Icon, ListDetail, NumberField, Select, SubInspector, Switch } from "./ui";
import { CHANNEL_VARIABLE_MAXIMUM_COUNT, CHANNEL_VARIABLE_MAXIMUM_VALUE, CHANNEL_VARIABLE_MINIMUM_VALUE } from "../contracts/values";

interface ChannelVariablesPageProperties {
  channelId: string;
  canManage: boolean;
  onOpenCommand: (name: string) => void;
  /** Deep-link request from Spotlight (#208), applied after variables load and then consumed by the parent. */
  initialSelection?: string;
  /** Clears the parent-owned request after this page has applied it. */
  onInitialSelectionConsumed?: (name: string) => void;
  onOpenOverlay?: (overlayId: string, initialVariableName?: string, newOverlayName?: string) => void;
}

const normalizedVariableName = (value: string): string => value.trim().toLowerCase();
const variableNamePattern = /^[a-z][a-z0-9_]{0,31}$/u;
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
  const [variables, setVariables] = useState<readonly PanelChannelVariable[]>([]);
  const [maximum, setMaximum] = useState(CHANNEL_VARIABLE_MAXIMUM_COUNT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftReset, setDraftReset] = useState(false);
  const [draftSetValue, setDraftSetValue] = useState<number | "">(0);
  const [pending, setPending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [useOverlayOpen, setUseOverlayOpen] = useState(false);
  const [legacyLinkStatus, setLegacyLinkStatus] = useState<{ channelId: string; hasLinks: boolean } | null>(null);
  const [overlayOptions, setOverlayOptions] = useState<readonly { id: string; name: string; elementCount: number }[]>([]);
  const [overlaySelection, setOverlaySelection] = useState("");
  const [creatingOverlay, setCreatingOverlay] = useState(false);
  const [newOverlayName, setNewOverlayName] = useState("");
  const [overlayPending, setOverlayPending] = useState(false);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const refreshRequest = useRef(0);
  const invalidateRefresh = useCallback((): void => { refreshRequest.current++; }, []);
  const lastInitialSelection = useRef<string | undefined>(undefined);

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++refreshRequest.current;
    try {
      const result = await fetchChannelVariables(channelId);
      if (requestId !== refreshRequest.current) return;
      setVariables(result.variables);
      setMaximum(result.maximum);
      setError(null);
    } catch (caught) {
      if (requestId !== refreshRequest.current) return;
      const loadErrorText = channelVariablesTexts(dashboardLanguage()).loadError;
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, loadErrorText) : loadErrorText);
    } finally {
      if (requestId === refreshRequest.current) setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    return () => { invalidateRefresh(); };
  }, [invalidateRefresh, refresh]);

  useEffect(() => {
    let active = true;
    void fetchOverlayTokens(channelId).then(({ tokens }) => {
      if (active) setLegacyLinkStatus({ channelId, hasLinks: tokens.length > 0 });
    }).catch(() => {
      if (active) setLegacyLinkStatus({ channelId, hasLinks: false });
    });
    return () => { active = false; };
  }, [channelId]);

  useRealtimeVariableUpdates({ channelId, refresh });

  const selected = useMemo(() => variables.find((variable) => variable.name === selectedName) ?? null, [selectedName, variables]);
  const hasLegacyLinks = legacyLinkStatus?.channelId === channelId && legacyLinkStatus.hasLinks;
  const selectedUsages = selected?.usages ?? [];
  const overlayUsageLabel = (usage: PanelChannelVariable["usages"][number]): string =>
    usage.elementLabel === undefined ? usage.itemName : `${usage.itemName} → ${usage.elementLabel}`;
  const usageNames = selectedUsages.map((usage) => usage.moduleId === "overlays"
    ? overlayUsageLabel(usage)
    : labels.usageLine(usage.moduleId, usage.itemName, usage.kind));
  const nameInvalid = !variableNamePattern.test(normalizedVariableName(draftName));
  const createDisabled = !canManageContent || variables.length >= maximum;
  const createReason = !canManageContent ? labels.managementLocked : variables.length >= maximum ? labels.count(maximum, maximum) : undefined;
  const beginCreate = (): void => {
    setCreating(true);
    setSelectedName(null);
    setDraftName("");
    setDraftDescription("");
    setDraftReset(false);
    setDraftSetValue(0);
    setUseOverlayOpen(false);
    setOverlayOptions([]);
    setOverlaySelection("");
    setCreatingOverlay(false);
    setNewOverlayName("");
    setOverlayError(null);
    setError(null);
  };
  const selectVariable = (variable: PanelChannelVariable): void => {
    setCreating(false);
    setSelectedName(variable.name);
    setDraftName(variable.name);
    setDraftDescription(variable.description);
    setDraftReset(variable.resetOnStreamStart);
    setDraftSetValue(variable.value);
    setUseOverlayOpen(false);
    setOverlayOptions([]);
    setOverlaySelection("");
    setCreatingOverlay(false);
    setNewOverlayName("");
    setOverlayError(null);
    setError(null);
  };
  // Latest-ref indirection, not a direct `selectVariable(match)` call: the
  // effect only ever reads through `.current`, so applying a deep-linked
  // selection (#208) doesn't read as "setState synchronously in an effect"
  // to the linter, the same way `text_commands`'s `initialSelection` effect
  // goes through a hook-returned setter instead of a local helper.
  const selectVariableRef = useRef(selectVariable);
  useEffect(() => { selectVariableRef.current = selectVariable; });
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
    setSelectedName(null);
    setError(null);
  };
  const save = async (): Promise<void> => {
    const name = normalizedVariableName(draftName);
    if (!canManageContent || nameInvalid || draftSetValue === "" || !Number.isInteger(draftSetValue)) return;
    setPending(true);
    setError(null);
    try {
      if (creating) {
        const response = await createChannelVariable(channelId, {
          name,
          value: draftSetValue,
          description: draftDescription,
          resetOnStreamStart: draftReset,
        });
        await refresh();
        setCreating(false);
        setSelectedName(response.variable.name);
      } else if (selected !== null) {
        const response = await updateChannelVariable(channelId, selected.name, {
          newName: name,
          description: draftDescription,
          resetOnStreamStart: draftReset,
        });
        await refresh();
        setSelectedName(response.variable.name);
        setDraftName(response.variable.name);
        if (response.variable.name !== selected.name) {
          setOverlayError(null);
        }
      }
    } catch (caught) {
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.saveError) : labels.saveError);
    } finally {
      setPending(false);
    }
  };
  const changeValue = async (operation: "add" | "subtract" | "set", amount: number): Promise<void> => {
    if (selected === null) return;
    setPending(true);
    setError(null);
    try {
      const response = await changeChannelVariableValue(channelId, selected.name, operation, amount);
      setVariables((current) => current.map((variable) => variable.name === selected.name ? { ...variable, ...response.variable } : variable));
      setDraftSetValue(response.variable.value);
    } catch (caught) {
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.saveError) : labels.saveError);
    } finally {
      setPending(false);
    }
  };
  const beginUseInOverlay = async (): Promise<void> => {
    if (selected === null || !canManageContent || overlayPending) return;
    setOverlayPending(true);
    setOverlayError(null);
    try {
      const result = await fetchOverlays(channelId);
      setOverlayOptions(result.overlays.map(({ id, name, elementCount }) => ({ id, name, elementCount })));
      setOverlaySelection(result.overlays[0]?.id ?? "");
      setCreatingOverlay(result.overlays.length === 0);
      setNewOverlayName(labels.defaultOverlayName(selected.name));
      setUseOverlayOpen(true);
    } catch (caught) {
      setOverlayError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.saveError) : labels.saveError);
    } finally {
      setOverlayPending(false);
    }
  };
  const addVariableElement = (): void => {
    if (selected === null || !canManageContent || overlayPending) return;
    if (creatingOverlay) {
      if (newOverlayName.trim().length === 0) return;
      setUseOverlayOpen(false);
      onOpenOverlay?.("new", selected.name, newOverlayName.trim());
    } else {
      if (overlaySelection.length === 0) return;
      setUseOverlayOpen(false);
      onOpenOverlay?.(overlaySelection, selected.name);
    }
  };
  const reconnectElement = async (usage: PanelChannelVariable["usages"][number]): Promise<void> => {
    if (selected === null || usage.overlayId === undefined || usage.elementId === undefined || !canManageContent || overlayPending) return;
    setOverlayPending(true);
    setOverlayError(null);
    try {
      const overlay = (await fetchOverlay(channelId, usage.overlayId)).overlay;
      const target = overlay.elements.find((element) => element.id === usage.elementId);
      if (target === undefined || target.variableName !== null || target.missingVariableName !== selected.name) {
        setOverlayError(labels.reconnectConflict);
        return;
      }
      const elements = overlay.elements.map((element) => ({
        ...saveableOverlayElement(element),
        variableName: element.id === usage.elementId ? selected.name : element.variableName,
      }));
      await saveOverlay(channelId, overlay.id, overlay.revision, {
        name: overlay.name, width: overlay.width, height: overlay.height, css: overlay.css, elements,
      }, { elementId: usage.elementId, missingVariableName: selected.name });
      await refresh();
      setOverlayError(null);
    } catch (caught) {
      setOverlayError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.saveError) : labels.saveError);
    } finally {
      setOverlayPending(false);
    }
  };
  const remove = async (): Promise<void> => {
    if (selected === null || !canManageContent || selectedUsages.some((usage) => usage.kind === "action")) return;
    setPending(true);
    setError(null);
    try {
      await deleteChannelVariable(channelId, selected.name);
      setConfirmDelete(false);
      await refresh();
      closeInspector();
    } catch (caught) {
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.deleteError) : labels.deleteError);
    } finally {
      setPending(false);
    }
  };

  const list = <section className="channel-variables-page config-section" aria-label={labels.list}>
    <div className="section-heading">
      <h1>{labels.title}</h1>
      <span className="muted">{labels.count(variables.length, maximum)}</span>
      <span title={createReason}>
        <Button icon="add" iconOnly ariaLabel={labels.create} disabled={createDisabled} onClick={beginCreate} />
      </span>
    </div>
    <p className="muted channel-variables-limit-note" role="note">{labels.limitNote(maximum)}</p>
    {canManageContent && variables.length >= maximum ? <p className="muted" role="note">{labels.limitReached}</p> : null}
    {loading ? <p className="loading-line">{labels.loading}</p> : null}
    {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    {!loading && variables.length === 0 ? <p className="empty-state">{labels.empty}</p> : null}
    {!loading && variables.length > 0 ? <div className="table-wrap channel-variables-table-wrap">
      <table className="table channel-variables-table">
        <thead><tr>
          <th scope="col">{labels.name}</th>
          <th scope="col">{labels.description}</th>
          <th scope="col" className="channel-variables-table__value-heading">{labels.value}</th>
          <th scope="col" className="channel-variables-table__reset-heading"><span className="sr-only">{labels.resetOnStreamStart}</span><Icon name="reload" size={16} /></th>
        </tr></thead>
        <tbody>{variables.map((variable) => (
          <tr key={variable.name} tabIndex={0} aria-selected={variable.name === selectedName} onClick={() => { selectVariable(variable); }} onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectVariable(variable); }
          }}>
            <th scope="row" className="mono">{`{var.${variable.name}}`}</th>
            <td className="channel-variables-table__description" title={variable.description || labels.noDescription}>{variable.description || labels.noDescription}</td>
            <td className="number channel-variables-table__value">{new Intl.NumberFormat(language).format(variable.value)}</td>
            <td className="channel-variables-table__reset">
              {variable.resetOnStreamStart ? <span role="img" aria-label={labels.resetOnStreamStart} title={labels.resetOnStreamStart}><Icon name="reload" size={16} /></span> : <span className="muted" aria-hidden="true">—</span>}
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div> : null}
    {!canManageContent ? <p className="muted" role="note">{labels.managementLocked}</p> : null}
  </section>;

  const inspector = creating || selected !== null ? (
    <SubInspector
      ariaLabel={creating ? labels.newVariable : labels.title}
      title={creating ? labels.newVariable : <span className="mono">{`{var.${selected?.name ?? ""}}`}</span>}
      identifier={creating ? undefined : selected?.name}
      closeLabel={labels.close}
      onClose={closeInspector}
    >
      <div className="channel-variable-editor">
        <Field id="channel-variable-name" label={labels.name} hint={creating ? labels.nameHint : labels.renameHint} value={draftName} normalize={normalizedVariableName} maxLength={32} countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={!canManageContent || pending} onChange={setDraftName} {...(nameInvalid ? { error: labels.nameInvalid } : {})} />
        {selected !== null && hasLegacyLinks && normalizedVariableName(draftName) !== selected.name
          ? <p className="muted" role="note">{labels.legacyRenameWarning}</p> : null}
        <Field id="channel-variable-description" label={labels.description} hint={labels.descriptionHint} value={draftDescription} maxLength={80} countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={!canManageContent || pending} onChange={setDraftDescription} />
        <Switch layout="card" label={labels.resetOnStreamStart} description={labels.resetHint} checked={draftReset} disabled={!canManageContent || pending} {...(!canManageContent ? { lockedReason: labels.managementLocked } : {})} onChange={setDraftReset} />
        {creating ? <NumberField id="channel-variable-initial-value" label={labels.value} hint={labels.valueHint} min={CHANNEL_VARIABLE_MINIMUM_VALUE} max={CHANNEL_VARIABLE_MAXIMUM_VALUE} step={1} increaseLabel={labels.increase} decreaseLabel={labels.decrease} value={draftSetValue} disabled={!canManageContent || pending} onChange={setDraftSetValue} /> : null}
        {selected === null ? null : <>
          <div className="channel-variable-value-controls">
            <strong>{labels.value}: {new Intl.NumberFormat(language).format(selected.value)}</strong>
            <Button variant="neutral" disabled={pending} title={labels.decrease} onClick={() => { void changeValue("subtract", 1); }}>{labels.decrease}</Button>
            <Button variant="neutral" disabled={pending} title={labels.increase} onClick={() => { void changeValue("add", 1); }}>{labels.increase}</Button>
          </div>
          <NumberField id="channel-variable-set-value" label={labels.setValue} hint={labels.valueHint} min={CHANNEL_VARIABLE_MINIMUM_VALUE} max={CHANNEL_VARIABLE_MAXIMUM_VALUE} step={1} increaseLabel={labels.increaseDraftValue} decreaseLabel={labels.decreaseDraftValue} value={draftSetValue} disabled={pending} onChange={setDraftSetValue} />
          <Button disabled={pending || draftSetValue === "" || !Number.isInteger(draftSetValue)} onClick={() => { if (typeof draftSetValue === "number") void changeValue("set", draftSetValue); }}>{labels.set}</Button>
          <div className="channel-variable-usages"><h3>{labels.usages}</h3>
            {usageNames.length === 0 ? <p className="muted">{labels.noUsages}</p> : <ul>{selectedUsages.map((usage, index) => (
              <li key={`${usage.moduleId}-${usage.itemName}-${usage.kind}-${String(index)}`}>
                {usage.moduleId === "text_commands"
                  ? <Button variant="subtle" onClick={() => { onOpenCommand(usage.itemName.replace(/^!/u, "")); }}>{labels.usageLine(usage.moduleId, usage.itemName, usage.kind)}</Button>
                  : usage.moduleId === "overlays" && usage.overlayId !== undefined
                    ? <><Button variant="subtle" onClick={() => { onOpenOverlay?.(usage.overlayId as string); }}>{overlayUsageLabel(usage)}</Button>
                      {usage.reconnect ? <><span className="muted"> · {labels.variableMissing}</span>
                        <Button variant="neutral" disabled={!canManageContent || overlayPending}
                          {...(!canManageContent ? { title: labels.managementLocked } : {})}
                          onClick={() => { void reconnectElement(usage); }}>{labels.reconnect}</Button></> : null}</>
                    : <span>{labels.usageLine(usage.moduleId, usage.itemName, usage.kind)}</span>}
              </li>
            ))}</ul>}
          </div>
          {selectedUsages.some((usage) => usage.kind === "action") ? <p className="muted" role="note">{labels.inUseReason(usageNames.filter((_, index) => selectedUsages[index]?.kind === "action").join(", "))}</p> : null}
        </>}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {overlayError === null ? null : <p className="form-error" role="alert">{overlayError}</p>}
        <div className="channel-variable-editor__actions">
          <Button variant="primary" disabled={!canManageContent || pending || nameInvalid || draftSetValue === ""} {...(!canManageContent ? { title: labels.managementLocked } : {})} onClick={() => { void save(); }}>{labels.save}</Button>
          <Button variant="subtle" disabled={pending} onClick={closeInspector}>{labels.discard}</Button>
        </div>
        {selected === null ? null : <section className="config-section channel-variable-use-overlay" aria-label={labels.useInOverlay}>
          <h3>{labels.useInOverlay}</h3>
          <p className="muted">{labels.useOverlayHint}</p>
          <Button variant="neutral" disabled={!canManageContent || overlayPending}
            {...(!canManageContent ? { title: labels.managementLocked } : {})}
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
        </section>}
        {selected !== null ? <Button danger="subtle" disabled={!canManageContent || pending || selectedUsages.some((usage) => usage.kind === "action")} {...(!canManageContent ? { title: labels.managementLocked } : selectedUsages.some((usage) => usage.kind === "action") ? { title: labels.inUseReason(usageNames.join(", ")) } : {})} onClick={() => { setConfirmDelete(true); }}>{labels.delete}</Button> : null}
        {!canManageContent ? <p className="muted" role="note">{labels.managementLocked}</p> : null}
      </div>
    </SubInspector>
  ) : null;

  return <>
    <ListDetail list={list} inspector={inspector} onCloseInspector={closeInspector} />
    <ConfirmDialog opened={confirmDelete} title={labels.deleteTitle(selected?.name ?? "")} description={labels.deleteDescription(selected?.name ?? "", usageNames.join(", "), selectedUsages.filter((usage) => usage.moduleId === "overlays" && usage.reconnect !== true).length)} confirmLabel={labels.deleteConfirm(selected?.name ?? "")} cancelLabel={labels.deleteCancel} onCancel={() => { setConfirmDelete(false); }} onConfirm={() => { void remove(); }} pending={pending} danger />
  </>;
}
