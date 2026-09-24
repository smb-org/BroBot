import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  changeChannelVariableValue,
  createChannelVariable,
  deleteChannelVariable,
  fetchChannelVariables,
  issueOverlayToken,
  PanelApiError,
  updateChannelVariable,
  type PanelChannelVariable,
} from "./api";
import { apiErrorText, channelVariablesTexts, dashboardLanguage } from "./locale";
import { OBS_OVERLAY_CSS_EXAMPLE, OverlayObsInstructions } from "./OverlayObsInstructions";
import { useRealtimeVariableUpdates } from "./realtime";
import { Button, ConfirmDialog, Field, Icon, ListDetail, NumberField, ReadOnlyTextArea, SubInspector, Switch } from "./ui";
import { CHANNEL_VARIABLE_MAXIMUM_COUNT, CHANNEL_VARIABLE_MAXIMUM_VALUE, CHANNEL_VARIABLE_MINIMUM_VALUE } from "../contracts/values";

interface ChannelVariablesPageProperties {
  channelId: string;
  canManage: boolean;
  onOpenCommand: (name: string) => void;
  /** Deep-link request from Spotlight (#208), applied after variables load and then consumed by the parent. */
  initialSelection?: string;
  /** Clears the parent-owned request after this page has applied it. */
  onInitialSelectionConsumed?: (name: string) => void;
}

const normalizedVariableName = (value: string): string => value.trim().toLowerCase();
const variableNamePattern = /^[a-z][a-z0-9_]{0,31}$/u;
const overlayTokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const tokenFromOverlayUrl = (value: string): string | null => {
  try {
    const url = new URL(value, window.location.href);
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
        (url.pathname !== "/overlay" && url.pathname !== "/overlay.html")) return null;
    const token = url.hash.slice(1);
    const parsed = new URLSearchParams(token).get("token");
    return parsed !== null && overlayTokenPattern.test(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const variableWidgetUrl = (token: string, name: string, text: string): string => {
  const url = new URL("/overlay", window.location.origin);
  const parameters = new URLSearchParams();
  parameters.set("token", token);
  parameters.set("var", name);
  parameters.set("text", text);
  url.hash = parameters.toString();
  return url.toString();
};

export function ChannelVariablesPage({ channelId, canManage: canManageContent, onOpenCommand, initialSelection, onInitialSelectionConsumed }: ChannelVariablesPageProperties): ReactElement {
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
  const [overlayText, setOverlayText] = useState("{value}");
  const [existingOverlayLink, setExistingOverlayLink] = useState("");
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null);
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
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

  useRealtimeVariableUpdates({ channelId, refresh });

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
    setOverlayText("{value}");
    setExistingOverlayLink("");
    setOverlayUrl(null);
    setOverlayError(null);
    setCopyNotice(null);
    setError(null);
  };
  const selectVariable = (variable: PanelChannelVariable): void => {
    setCreating(false);
    setSelectedName(variable.name);
    setDraftName(variable.name);
    setDraftDescription(variable.description);
    setDraftReset(variable.resetOnStreamStart);
    setDraftSetValue(variable.value);
    setOverlayText(`${variable.name}: {value}`);
    setExistingOverlayLink("");
    setOverlayUrl(null);
    setOverlayError(null);
    setCopyNotice(null);
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
        setOverlayText(`${response.variable.name}: {value}`);
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
          setOverlayText(`${response.variable.name}: {value}`);
          setExistingOverlayLink("");
          setOverlayUrl(null);
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
  const overlayTemplateValid = overlayText.length <= 100 && overlayText.split("{value}").length === 2;
  const generateOverlayLink = async (): Promise<void> => {
    if (selected === null || !canManageContent || !overlayTemplateValid) return;
    setPending(true);
    setOverlayError(null);
    setCopyNotice(null);
    try {
      const issued = await issueOverlayToken(channelId);
      const token = tokenFromOverlayUrl(issued.overlayUrl);
      if (token === null) throw new Error(labels.overlayLinkError);
      setExistingOverlayLink(issued.overlayUrl);
      setOverlayUrl(variableWidgetUrl(token, selected.name, overlayText));
    } catch (caught) {
      setOverlayError(caught instanceof PanelApiError
        ? apiErrorText(caught.code, labels.overlayLinkError)
        : labels.overlayLinkError);
    } finally {
      setPending(false);
    }
  };
  const useExistingOverlayLink = (): void => {
    if (selected === null || !overlayTemplateValid) return;
    const token = tokenFromOverlayUrl(existingOverlayLink.trim());
    setOverlayError(token === null ? labels.existingOverlayLinkInvalid : null);
    setCopyNotice(null);
    setOverlayUrl(token === null ? null : variableWidgetUrl(token, selected.name, overlayText));
  };
  const copyText = async (value: string): Promise<void> => {
    setCopyNotice(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopyNotice(labels.copied);
    } catch {
      setCopyNotice(labels.copyUnavailable);
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
                  : <span>{labels.usageLine(usage.moduleId, usage.itemName, usage.kind)}</span>}
              </li>
            ))}</ul>}
          </div>
          {selectedUsages.some((usage) => usage.kind === "action") ? <p className="muted" role="note">{labels.inUseReason(usageNames.filter((_, index) => selectedUsages[index]?.kind === "action").join(", "))}</p> : null}
        </>}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        <div className="channel-variable-editor__actions">
          <Button variant="primary" disabled={!canManageContent || pending || nameInvalid || draftSetValue === ""} {...(!canManageContent ? { title: labels.managementLocked } : {})} onClick={() => { void save(); }}>{labels.save}</Button>
          <Button variant="subtle" disabled={pending} onClick={closeInspector}>{labels.discard}</Button>
        </div>
        {selected !== null && canManageContent ? <section className="config-section channel-variable-overlay-link" aria-label={labels.overlayLink}>
          <hr className="channel-variable-overlay-link__divider" />
          <h3>{labels.overlayLink}</h3>
          <OverlayObsInstructions />
          <Field
            id="channel-variable-overlay-text"
            label={labels.overlayText}
            hint={overlayTemplateValid ? labels.overlayTextHint : labels.overlayTemplateInvalid}
            value={overlayText}
            maxLength={100}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            disabled={pending}
            onChange={(value) => { setOverlayText(value); setOverlayUrl(null); setCopyNotice(null); }}
            {...(!overlayTemplateValid ? { error: labels.overlayTemplateInvalid } : {})}
          />
          <Button disabled={pending || !overlayTemplateValid} onClick={() => { void generateOverlayLink(); }}>
            {labels.generateOverlayLink}
          </Button>
          <Field
            id="channel-variable-overlay-existing"
            label={labels.existingOverlayLink}
            value={existingOverlayLink}
            maxLength={2_000}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            disabled={pending}
            onChange={(value) => { setExistingOverlayLink(value); setOverlayUrl(null); setOverlayError(null); setCopyNotice(null); }}
          />
          <Button variant="neutral" disabled={pending || !overlayTemplateValid || existingOverlayLink.trim().length === 0}
            onClick={useExistingOverlayLink}>{labels.useExistingOverlayLink}</Button>
          {overlayError === null ? null : <p className="form-error" role="alert">{overlayError}</p>}
          {overlayUrl === null ? null : <>
            <ReadOnlyTextArea className="channel-variable-overlay-link__output" id="channel-variable-overlay-url" label={labels.widgetUrl} value={overlayUrl} minRows={3} />
            <Button variant="neutral" onClick={() => { void copyText(overlayUrl); }}>{labels.copyLink}</Button>
            <p className="muted" role="note">{labels.secretNotice}</p>
            <ReadOnlyTextArea className="channel-variable-overlay-link__output" id="channel-variable-overlay-css" label={labels.obsCss} value={OBS_OVERLAY_CSS_EXAMPLE} minRows={6} />
            <Button variant="neutral" onClick={() => { void copyText(OBS_OVERLAY_CSS_EXAMPLE); }}>{labels.copyCss}</Button>
            {copyNotice === null ? null : <p className="muted" role="status">{copyNotice}</p>}
          </>}
        </section> : null}
        {selected !== null ? <Button danger="subtle" disabled={!canManageContent || pending || selectedUsages.some((usage) => usage.kind === "action")} {...(!canManageContent ? { title: labels.managementLocked } : selectedUsages.some((usage) => usage.kind === "action") ? { title: labels.inUseReason(usageNames.join(", ")) } : {})} onClick={() => { setConfirmDelete(true); }}>{labels.delete}</Button> : null}
        {!canManageContent ? <p className="muted" role="note">{labels.managementLocked}</p> : null}
      </div>
    </SubInspector>
  ) : null;

  return <>
    <ListDetail list={list} inspector={inspector} onCloseInspector={closeInspector} />
    <ConfirmDialog opened={confirmDelete} title={labels.deleteTitle(selected?.name ?? "")} description={labels.deleteDescription(selected?.name ?? "", usageNames.join(", "))} confirmLabel={labels.deleteConfirm(selected?.name ?? "")} cancelLabel={labels.deleteCancel} onCancel={() => { setConfirmDelete(false); }} onConfirm={() => { void remove(); }} pending={pending} danger />
  </>;
}
