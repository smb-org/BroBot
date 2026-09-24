import { useEffect, useMemo, useState, type ReactElement } from "react";

import {
  changeChannelVariableValue,
  createChannelVariable,
  deleteChannelVariable,
  fetchChannelVariables,
  PanelApiError,
  updateChannelVariable,
  type PanelChannelVariable,
} from "./api";
import { apiErrorText, channelVariablesTexts, dashboardLanguage } from "./locale";
import { Button, ConfirmDialog, Field, ListDetail, NumberField, SubInspector, Switch } from "./ui";
import { CHANNEL_VARIABLE_MAXIMUM_COUNT, CHANNEL_VARIABLE_MAXIMUM_VALUE, CHANNEL_VARIABLE_MINIMUM_VALUE } from "../contracts/values";

interface ChannelVariablesPageProperties {
  channelId: string;
  canManage: boolean;
  onOpenCommand: (name: string) => void;
}

const normalizedVariableName = (value: string): string => value.trim().toLowerCase();
const variableNamePattern = /^[a-z][a-z0-9_]{0,31}$/u;

export function ChannelVariablesPage({ channelId, canManage: canManageContent, onOpenCommand }: ChannelVariablesPageProperties): ReactElement {
  const language = dashboardLanguage();
  const labels = channelVariablesTexts(language);
  const loadErrorText = labels.loadError;
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

  const refresh = async (): Promise<void> => {
    try {
      const result = await fetchChannelVariables(channelId);
      setVariables(result.variables);
      setMaximum(result.maximum);
      setError(null);
    } catch (caught) {
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, loadErrorText) : loadErrorText);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    const load = (): void => {
      void fetchChannelVariables(channelId).then((result) => {
        if (!active) return;
        setVariables(result.variables);
        setMaximum(result.maximum);
        setError(null);
      }).catch((caught: unknown) => {
        if (!active) return;
        setError(caught instanceof PanelApiError ? apiErrorText(caught.code, loadErrorText) : loadErrorText);
      }).finally(() => { if (active) setLoading(false); });
    };
    const reload = (): void => { if (document.visibilityState === "visible") load(); };
    load();
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      active = false;
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [channelId, loadErrorText]);

  const selected = useMemo(() => variables.find((variable) => variable.name === selectedName) ?? null, [selectedName, variables]);
  const selectedUsages = selected?.usages ?? [];
  const usageNames = selectedUsages.map((usage) => labels.usageLine(usage.moduleId, usage.itemName, usage.kind));
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
    setError(null);
  };
  const selectVariable = (variable: PanelChannelVariable): void => {
    setCreating(false);
    setSelectedName(variable.name);
    setDraftName(variable.name);
    setDraftDescription(variable.description);
    setDraftReset(variable.resetOnStreamStart);
    setDraftSetValue(variable.value);
    setError(null);
  };
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
    {canManageContent && variables.length >= maximum ? <p className="muted" role="note">{labels.limitReached}</p> : null}
    {loading ? <p className="loading-line">{labels.loading}</p> : null}
    {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    {!loading && variables.length === 0 ? <p className="empty-state">{labels.empty}</p> : null}
    <ul className="channel-variables-list">
      {variables.map((variable) => (
        <li key={variable.name}>
          <button type="button" className="channel-variable-row" aria-current={variable.name === selectedName ? "true" : undefined} onClick={() => { selectVariable(variable); }}>
            <span><strong className="mono">{`{var.${variable.name}}`}</strong><small>{variable.description || labels.noDescription}</small></span>
            <strong className="channel-variable-row__value">{new Intl.NumberFormat(language).format(variable.value)}</strong>
          </button>
        </li>
      ))}
    </ul>
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
        <Field id="channel-variable-description" label={labels.description} hint={labels.descriptionHint} value={draftDescription} maxLength={80} countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={!canManageContent || pending} onChange={setDraftDescription} />
        <Switch label={labels.resetOnStreamStart} hint={labels.resetHint} checked={draftReset} disabled={!canManageContent || pending} {...(!canManageContent ? { lockedReason: labels.managementLocked } : {})} onChange={setDraftReset} />
        {creating ? <NumberField id="channel-variable-initial-value" label={labels.value} hint={labels.valueHint} min={CHANNEL_VARIABLE_MINIMUM_VALUE} max={CHANNEL_VARIABLE_MAXIMUM_VALUE} step={1} increaseLabel={labels.increase} decreaseLabel={labels.decrease} value={draftSetValue} disabled={!canManageContent || pending} onChange={setDraftSetValue} /> : null}
        {selected === null ? null : <>
          <div className="channel-variable-value-controls">
            <strong>{labels.value}: {new Intl.NumberFormat(language).format(selected.value)}</strong>
            <Button variant="neutral" disabled={pending} title={labels.decrease} onClick={() => { void changeValue("subtract", 1); }}>{labels.decrease}</Button>
            <Button variant="neutral" disabled={pending} title={labels.increase} onClick={() => { void changeValue("add", 1); }}>{labels.increase}</Button>
          </div>
          <NumberField id="channel-variable-set-value" label={labels.setValue} hint={labels.valueHint} min={CHANNEL_VARIABLE_MINIMUM_VALUE} max={CHANNEL_VARIABLE_MAXIMUM_VALUE} step={1} increaseLabel={labels.increase} decreaseLabel={labels.decrease} value={draftSetValue} disabled={pending} onChange={setDraftSetValue} />
          <Button disabled={pending || draftSetValue === "" || !Number.isInteger(draftSetValue)} onClick={() => { if (typeof draftSetValue === "number") void changeValue("set", draftSetValue); }}>{labels.set}</Button>
          <div className="channel-variable-usages"><h3>{labels.usages}</h3>
            {usageNames.length === 0 ? <p className="muted">{labels.noUsages}</p> : <ul>{selectedUsages.map((usage, index) => (
              <li key={`${usage.moduleId}-${usage.itemName}-${usage.kind}-${String(index)}`}>
                {usage.moduleId === "text_commands"
                  ? <Button variant="subtle" onClick={() => { onOpenCommand(usage.itemName.replace(/^!/u, "")); }}>{labels.usageLine(usage.moduleId, usage.itemName, usage.kind)}</Button>
                  : <span>{labels.usageLine(usage.moduleId, usage.itemName, usage.kind)}</span>}
              </li>
            ))}</ul>}
          </div>
          {selectedUsages.some((usage) => usage.kind === "action") ? <p className="muted" role="note">{labels.inUseReason(usageNames.filter((_, index) => selectedUsages[index]?.kind === "action").join(", "))}</p> : null}
          <Button danger="subtle" disabled={!canManageContent || pending || selectedUsages.some((usage) => usage.kind === "action")} {...(!canManageContent ? { title: labels.managementLocked } : selectedUsages.some((usage) => usage.kind === "action") ? { title: labels.inUseReason(usageNames.join(", ")) } : {})} onClick={() => { setConfirmDelete(true); }}>{labels.delete}</Button>
        </>}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {canManageContent ? <div className="channel-variable-editor__actions"><Button variant="primary" disabled={pending || nameInvalid || draftSetValue === ""} onClick={() => { void save(); }}>{labels.save}</Button><Button variant="subtle" disabled={pending} onClick={closeInspector}>{labels.discard}</Button></div> : <p className="muted" role="note">{labels.managementLocked}</p>}
      </div>
    </SubInspector>
  ) : null;

  return <>
    <ListDetail list={list} inspector={inspector} onCloseInspector={closeInspector} />
    <ConfirmDialog opened={confirmDelete} title={labels.deleteTitle(selected?.name ?? "")} description={labels.deleteDescription(selected?.name ?? "", usageNames.join(", "))} confirmLabel={labels.deleteConfirm(selected?.name ?? "")} cancelLabel={labels.deleteCancel} onCancel={() => { setConfirmDelete(false); }} onConfirm={() => { void remove(); }} pending={pending} danger />
  </>;
}
