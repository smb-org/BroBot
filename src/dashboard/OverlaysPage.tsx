import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";

import {
  createOverlay,
  deleteOverlay,
  fetchOverlay,
  fetchOverlayAccesses,
  fetchOverlays,
  fetchOverlayTokens,
  issueOverlayAccess,
  PanelApiError,
  replaceOverlayAccess,
  revokeOverlayAccess,
  revokeOverlayToken,
  revealOverlayAccess,
  type PanelIssuedOverlayAccess,
  type PanelOverlay,
  type PanelOverlayAccess,
  type PanelOverlaySummary,
  type PanelOverlayToken,
} from "./api";
import { apiErrorText, dashboardLanguage, formatTimestamp, overlaysTexts } from "./locale";
import { OverlayObsInstructions } from "./OverlayObsInstructions";
import { Button, ConfirmDialog, Field, ListDetail, NumberField, Select, SubInspector } from "./ui";

interface OverlaysPageProperties {
  channelId: string;
  canManage: boolean;
  initialSelection?: string;
}

const blankOverlayName = "";
const maskOverlaySecret = (overlayUrl: string): string => overlayUrl.replace(/([#&]token=)[^&]*/u, "$1••••••");

interface ScopedOverlaySecret extends PanelIssuedOverlayAccess {
  overlayId: string;
}

export function OverlaysPage({ channelId, canManage, initialSelection }: OverlaysPageProperties): ReactElement {
  const language = dashboardLanguage();
  const labels = overlaysTexts(language);
  const [overlays, setOverlays] = useState<readonly PanelOverlaySummary[]>([]);
  const [maximum, setMaximum] = useState(20);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelection ?? null);
  const selectedIdRef = useRef<string | null>(initialSelection ?? null);
  const [selectedOverlayData, setSelectedOverlayData] = useState<{
    id: string;
    overlay: PanelOverlay;
    accesses: readonly PanelOverlayAccess[];
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState(blankOverlayName);
  const [draftSize, setDraftSize] = useState("1920x1080");
  const [draftWidth, setDraftWidth] = useState<number | "">(1920);
  const [draftHeight, setDraftHeight] = useState<number | "">(1080);
  const [accessName, setAccessName] = useState("");
  const [secret, setSecret] = useState<ScopedOverlaySecret | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PanelOverlayAccess | null>(null);
  const [legacyTokens, setLegacyTokens] = useState<readonly PanelOverlayToken[]>([]);
  const [legacyNextOffset, setLegacyNextOffset] = useState<number | null>(null);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const [legacyRevokeTarget, setLegacyRevokeTarget] = useState<PanelOverlayToken | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const requestVersion = useRef(0);
  const secretVersion = useRef(0);
  const legacyRequestVersion = useRef(0);
  const pageActiveRef = useRef(true);
  const permissionRef = useRef(canManage);
  const channelIdRef = useRef(channelId);
  const invalidateSecret = useCallback((): void => {
    secretVersion.current++;
    setSecret(null);
    setCopied(false);
  }, []);
  const changeSelection = useCallback((nextId: string | null): void => {
    invalidateSecret();
    selectedIdRef.current = nextId;
    setSelectedId(nextId);
  }, [invalidateSecret]);
  const secretContextIsCurrent = (version: number, overlayId: string, requestedChannelId: string): boolean =>
    pageActiveRef.current && secretVersion.current === version && selectedIdRef.current === overlayId &&
    channelIdRef.current === requestedChannelId && permissionRef.current;

  useLayoutEffect(() => {
    if (permissionRef.current !== canManage || channelIdRef.current !== channelId) invalidateSecret();
    if (channelIdRef.current !== channelId) {
      changeSelection(null);
      setSelectedOverlayData(null);
    }
    permissionRef.current = canManage;
    channelIdRef.current = channelId;
  }, [canManage, channelId, changeSelection, invalidateSecret]);
  const selected = useMemo(() => overlays.find((overlay) => overlay.id === selectedId) ?? null, [overlays, selectedId]);
  const selectedOverlay = selectedOverlayData?.id === selectedId ? selectedOverlayData.overlay : null;
  const accesses = selectedOverlayData?.id === selectedId ? selectedOverlayData.accesses : [];

  const load = useCallback(async (isActive: () => boolean = () => true): Promise<void> => {
    const version = ++requestVersion.current;
    try {
      const result = await fetchOverlays(channelId);
      if (!isActive() || version !== requestVersion.current) return;
      setOverlays(result.overlays);
      setMaximum(result.maximum);
      setError(null);
      if (selectedIdRef.current === null && initialSelection !== undefined && result.overlays.some((item) => item.id === initialSelection)) {
        changeSelection(initialSelection);
      }
    } catch (caught) {
      if (!isActive() || version !== requestVersion.current) return;
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.loadError) : labels.loadError);
    } finally {
      if (isActive() && version === requestVersion.current) setLoading(false);
    }
  }, [channelId, changeSelection, initialSelection, labels.loadError]);

  const loadLegacyTokens = useCallback(async (offset = 0, append = false): Promise<void> => {
    const version = ++legacyRequestVersion.current;
    try {
      const result = await fetchOverlayTokens(channelId, offset);
      if (!pageActiveRef.current || legacyRequestVersion.current !== version || channelIdRef.current !== channelId) return;
      setLegacyTokens((current) => append ? [...current, ...result.tokens] : result.tokens);
      setLegacyNextOffset(result.nextOffset);
      setLegacyError(null);
    } catch (caught) {
      if (!pageActiveRef.current || legacyRequestVersion.current !== version || channelIdRef.current !== channelId) return;
      setLegacyError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.loadError) : labels.loadError);
    }
  }, [channelId, labels.loadError]);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => load(() => active));
    return () => { active = false; };
  }, [load]);
  useEffect(() => { void Promise.resolve().then(() => loadLegacyTokens()); }, [loadLegacyTokens]);
  useEffect(() => {
    pageActiveRef.current = true;
    return () => {
      pageActiveRef.current = false;
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 30_000);
    return () => { window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (selectedId === null) return;
    let active = true;
    const requests: [Promise<{ overlay: PanelOverlay }>, Promise<{ accesses: readonly PanelOverlayAccess[] }>] = [
      fetchOverlay(channelId, selectedId),
      fetchOverlayAccesses(channelId, selectedId),
    ];
    void Promise.all(requests).then(([overlayResult, accessResult]) => {
      if (!active) return;
      setSelectedOverlayData({ id: selectedId, overlay: overlayResult.overlay, accesses: accessResult.accesses });
      setError(null);
    }).catch((caught: unknown) => {
      if (!active) return;
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.loadError) : labels.loadError);
    });
    return () => { active = false; };
  }, [canManage, channelId, labels.loadError, selectedId]);

  const refreshSelected = async (): Promise<void> => {
    const overlayId = selectedIdRef.current;
    if (overlayId === null) return;
    const [overlayResult, accessResult] = await Promise.all([
      fetchOverlay(channelId, overlayId),
      fetchOverlayAccesses(channelId, overlayId),
    ]);
    if (channelIdRef.current === channelId && selectedIdRef.current === overlayId) {
      setSelectedOverlayData({ id: overlayId, overlay: overlayResult.overlay, accesses: accessResult.accesses });
    }
  };

  const beginCreate = (): void => {
    setCreating(true);
    changeSelection(null);
    setSelectedOverlayData(null);
    setDraftName("");
    setDraftSize("1920x1080");
    setDraftWidth(1920);
    setDraftHeight(1080);
    setError(null);
  };

  const create = async (): Promise<void> => {
    if (!canManage || pending || draftName.trim().length < 1 || draftName.trim().length > 40 || draftWidth === "" || draftHeight === "") return;
    setPending(true);
    setError(null);
    try {
      const created = await createOverlay(channelId, { name: draftName.trim(), width: draftWidth, height: draftHeight });
      setCreating(false);
      changeSelection(created.overlay.id);
      await load();
    } catch (caught) {
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
    } finally {
      setPending(false);
    }
  };

  const closeInspector = (): void => {
    setCreating(false);
    changeSelection(null);
    setSelectedOverlayData(null);
    setError(null);
  };

  const removeOverlay = async (): Promise<void> => {
    if (selectedOverlay === null || !canManage || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await deleteOverlay(channelId, selectedOverlay.id, selectedOverlay.revision);
      setConfirmDelete(false);
      changeSelection(null);
      setSelectedOverlayData(null);
      await load();
      setNotice(result?.closingPending ? labels.revokedPending : null);
    } catch (caught) {
      if (caught instanceof PanelApiError && caught.code === "overlay_changed_concurrently") {
        setError(labels.conflict);
        try { await refreshSelected(); } catch { /* Keep the conflict visible if the reload also fails. */ }
      } else {
        setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
      }
    } finally {
      setPending(false);
    }
  };

  const saveIssuedSecret = (issued: PanelIssuedOverlayAccess, overlayId: string): void => {
    setSecret({ ...issued, overlayId });
    setCopied(false);
  };

  const issue = async (): Promise<void> => {
    if (selectedOverlay === null || !canManage || pending || accessName.trim().length === 0) return;
    const overlayId = selectedOverlay.id;
    invalidateSecret();
    const version = secretVersion.current;
    const requestedChannelId = channelId;
    setPending(true);
    setError(null);
    try {
      const issued = await issueOverlayAccess(channelId, overlayId, accessName.trim());
      if (secretContextIsCurrent(version, overlayId, requestedChannelId)) saveIssuedSecret(issued, overlayId);
      setAccessName("");
      await refreshSelected();
      await load();
    } catch (caught) {
      if (secretContextIsCurrent(version, overlayId, requestedChannelId)) {
        setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
      }
    } finally {
      setPending(false);
    }
  };

  const reveal = async (access: PanelOverlayAccess): Promise<void> => {
    if (selectedOverlay === null || !canManage || pending || access.revokedAt !== null) return;
    const overlayId = selectedOverlay.id;
    invalidateSecret();
    const version = secretVersion.current;
    const requestedChannelId = channelId;
    setPending(true);
    setError(null);
    try {
      const result = await revealOverlayAccess(channelId, overlayId, access.tokenId);
      if (secretContextIsCurrent(version, overlayId, requestedChannelId)) {
        saveIssuedSecret({ tokenId: access.tokenId, overlayUrl: result.overlayUrl, label: access.label, expiresAt: access.expiresAt }, overlayId);
      }
    } catch (caught) {
      if (secretContextIsCurrent(version, overlayId, requestedChannelId)) {
        setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
      }
    } finally {
      setPending(false);
    }
  };

  const replace = async (access: PanelOverlayAccess): Promise<void> => {
    if (selectedOverlay === null || !canManage || pending || access.revokedAt !== null) return;
    const overlayId = selectedOverlay.id;
    invalidateSecret();
    const version = secretVersion.current;
    const requestedChannelId = channelId;
    setPending(true);
    setError(null);
    try {
      const replacement = await replaceOverlayAccess(channelId, overlayId, access.tokenId);
      if (secretContextIsCurrent(version, overlayId, requestedChannelId)) saveIssuedSecret(replacement, overlayId);
      await refreshSelected();
      await load();
    } catch (caught) {
      if (secretContextIsCurrent(version, overlayId, requestedChannelId)) {
        setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
      }
    } finally {
      setPending(false);
    }
  };

  const revoke = async (): Promise<void> => {
    if (selectedOverlay === null || revokeTarget === null || !canManage || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await revokeOverlayAccess(channelId, selectedOverlay.id, revokeTarget.tokenId);
      setRevokeTarget(null);
      setNotice(result.closingPending ? labels.revokedPending : labels.revoked);
      invalidateSecret();
      await refreshSelected();
      await load();
    } catch (caught) {
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
    } finally {
      setPending(false);
    }
  };

  const copySecret = async (): Promise<void> => {
    if (secret === null || !canManage || secret.overlayId !== selectedIdRef.current) return;
    try {
      await navigator.clipboard.writeText(secret.overlayUrl);
      if (permissionRef.current && secret.overlayId === selectedIdRef.current) setCopied(true);
      setError(null);
    } catch {
      setError(labels.copyError);
    }
  };

  const revokeLegacy = async (): Promise<void> => {
    if (legacyRevokeTarget === null || !canManage || pending) return;
    setPending(true);
    setLegacyError(null);
    try {
      await revokeOverlayToken(channelId, legacyRevokeTarget.id, labels.legacyRevocationReason);
      setLegacyRevokeTarget(null);
      setNotice(labels.revoked);
      await loadLegacyTokens();
    } catch (caught) {
      setLegacyError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
    } finally {
      setPending(false);
    }
  };

  const isAccessActive = (access: PanelOverlayAccess): boolean => access.revokedAt === null &&
    (access.expiresAt === null || Date.parse(access.expiresAt) > now);
  const manageReason = canManage ? undefined : labels.managementLocked;
  const list = <section className="overlays-page config-section" aria-label={labels.list}>
    <div className="section-heading">
      <h1>{labels.title}</h1>
      <span className="muted">{labels.count(overlays.length, maximum)}</span>
      <span title={manageReason}>
        <Button icon="add" iconOnly ariaLabel={labels.create} disabled={!canManage || pending || overlays.length >= maximum}
          {...(manageReason === undefined ? {} : { title: manageReason })} onClick={beginCreate} />
      </span>
    </div>
    {loading ? <p className="loading-line">{labels.loading}</p> : null}
    {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    {!loading && overlays.length === 0 ? <p className="empty-state">{labels.empty}</p> : null}
    {!loading && overlays.length > 0 ? <div className="table-wrap overlays-table-wrap">
      <table className="table overlays-table">
        <thead><tr><th scope="col">{labels.name}</th><th scope="col">{labels.elements}</th><th scope="col">{labels.accesses}</th><th scope="col">{labels.lastUsedAt}</th></tr></thead>
        <tbody>{overlays.map((overlay) => <tr key={overlay.id} tabIndex={0} aria-selected={overlay.id === selectedId}
          onClick={() => { setCreating(false); setSelectedOverlayData(null); changeSelection(overlay.id); setNotice(null); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setCreating(false); setSelectedOverlayData(null); changeSelection(overlay.id); setNotice(null); } }}>
          <th scope="row">{overlay.name}</th>
          <td>{overlay.elementCount}</td>
          <td>{overlay.accessCount}</td>
          <td>{overlay.lastUsedAt === null ? labels.never : <time dateTime={overlay.lastUsedAt}>{formatTimestamp(overlay.lastUsedAt)}</time>}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
    {legacyTokens.length > 0 ? <section className="overlay-legacy-links" aria-label={labels.legacyTitle}>
      <h2>{labels.legacyTitle}</h2>
      <p className="muted">{labels.legacyDescription}</p>
      <ul className="overlay-access-list">{legacyTokens.map((token) => <li key={token.id} className="overlay-access-list__item">
        <div><strong>{labels.legacyTokenName}</strong>
          <span className="muted">{labels.legacyCreatedAt}: {formatTimestamp(token.createdAt)}</span>
          <span className="muted">{token.createdBy ?? labels.legacyCreatedByUnknown}</span>
          <span className="muted">{token.lastUsedAt === null ? labels.never : `${labels.lastUsedAt}: ${formatTimestamp(token.lastUsedAt)}`}</span>
        </div>
        <Button danger="subtle" disabled={!canManage || pending} {...(manageReason === undefined ? {} : { title: manageReason })}
          onClick={() => { setLegacyRevokeTarget(token); }}>{labels.revoke}</Button>
      </li>)}</ul>
      {legacyNextOffset === null ? null : <Button variant="subtle" disabled={pending}
        onClick={() => { void loadLegacyTokens(legacyNextOffset, true); }}>{labels.loadMore}</Button>}
    </section> : null}
    {legacyError === null ? null : <p className="form-error" role="alert">{legacyError}</p>}
    {manageReason === undefined ? null : <p className="muted" role="note">{labels.readOnly}</p>}
    {notice === null ? null : <p className="muted" role="status">{notice}</p>}
  </section>;

  const inspector = creating ? <SubInspector ariaLabel={labels.createTitle} title={labels.createTitle} closeLabel={labels.close} onClose={closeInspector}>
    <div className="overlay-create-form">
      <Field id="overlay-name" label={labels.name} value={draftName} maxLength={40} countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={pending} onChange={setDraftName} />
      <Select id="overlay-size" label={`${labels.width} × ${labels.height}`} value={draftSize} disabled={pending} options={[
        { value: "1920x1080", label: labels.standardSize }, { value: "1280x720", label: labels.compactSize }, { value: "custom", label: labels.customSize },
      ]} onChange={(value) => {
          if (value === null) return;
          setDraftSize(value);
          if (value === "1920x1080") { setDraftWidth(1920); setDraftHeight(1080); }
          else if (value === "1280x720") { setDraftWidth(1280); setDraftHeight(720); }
        }} />
      {draftSize === "custom" ? <div className="overlay-custom-size">
        <NumberField id="overlay-width" label={labels.width} value={draftWidth} min={64} max={3840} step={1} increaseLabel={`${labels.width} +1`} decreaseLabel={`${labels.width} −1`} disabled={pending} onChange={setDraftWidth} />
        <NumberField id="overlay-height" label={labels.height} value={draftHeight} min={64} max={2160} step={1} increaseLabel={`${labels.height} +1`} decreaseLabel={`${labels.height} −1`} disabled={pending} onChange={setDraftHeight} />
      </div> : null}
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
      <div className="overlay-form-actions"><Button variant="primary" disabled={!canManage || pending || draftName.trim().length === 0} onClick={() => { void create(); }}>{labels.createSubmit}</Button>
        <Button variant="subtle" disabled={pending} onClick={closeInspector}>{labels.cancel}</Button></div>
      {manageReason === undefined ? null : <p className="muted" role="note">{manageReason}</p>}
    </div>
  </SubInspector> : selectedId === null ? null : <SubInspector ariaLabel={labels.title} title={selected?.name ?? labels.title}
    identifier={selected?.id} closeLabel={labels.close} onClose={closeInspector}>
    {selectedOverlay === null ? <p className="loading-line">{labels.loading}</p> : <div className="overlay-inspector">
      <dl className="properties"><div><dt>{labels.width} × {labels.height}</dt><dd>{selectedOverlay.width} × {selectedOverlay.height}</dd></div>
        <div><dt>{labels.elements}</dt><dd>{selectedOverlay.elements.length}</dd></div></dl>
      <section className="overlay-elements-section" aria-label={labels.elements}>
        <h3>{labels.elements}</h3>
        {selectedOverlay.elements.length === 0 ? <p className="muted">{labels.elementCount(0)}</p> : <ul>{selectedOverlay.elements.map((element) => <li key={element.id}>
          {element.label || element.id}{element.variableName === null ? <span className="muted"> · {element.missingVariableName === undefined || element.missingVariableName === null ? "—" : labels.missingVariable(element.missingVariableName)}</span> : null}
        </li>)}</ul>}
      </section>
      <section className="overlay-access-section" aria-label={labels.accesses}>
        <h3>{labels.accesses}</h3>
        <Field id="overlay-access-name" label={labels.issueLabel} hint={labels.issueHint} value={accessName} maxLength={40} countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={!canManage || pending} onChange={setAccessName} />
          <Button variant="primary" disabled={!canManage || pending || accessName.trim().length === 0}
            {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { void issue(); }}>{labels.issue}</Button>
          {accesses.length === 0 ? <p className="muted">{labels.noAccesses}</p> : <ul className="overlay-access-list">{accesses.map((access) => <li key={access.tokenId} className="overlay-access-list__item">
            <div><strong>{access.label}</strong><span className="muted">{access.lastUsedAt === null ? labels.never : `${labels.lastUsedAt}: ${formatTimestamp(access.lastUsedAt)}`}</span>
              <span className="muted">{access.revokedAt !== null ? labels.revokedStatus : isAccessActive(access) ? labels.active : labels.expired}</span></div>
            <div className="overlay-access-list__actions">
              <Button variant="subtle" disabled={!canManage || pending || !isAccessActive(access)} {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { void reveal(access); }}>{labels.reveal}</Button>
              <Button variant="neutral" disabled={!canManage || pending || !isAccessActive(access)} {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { void replace(access); }}>{labels.replace}</Button>
              <Button danger="subtle" disabled={!canManage || pending || !isAccessActive(access)} {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { setRevokeTarget(access); }}>{labels.revoke}</Button>
            </div>
          </li>)}</ul>}
          {secret === null || secret.overlayId !== selectedId || !canManage ? null : <div className="overlay-access-secret" aria-label={labels.issue}>
            <p className="overlay-access-secret__masked"><code>{maskOverlaySecret(secret.overlayUrl)}</code></p>
            <Button variant="neutral" disabled={pending} onClick={() => { void copySecret(); }}>{copied ? labels.copied : labels.copy}</Button>
          </div>}
          <OverlayObsInstructions />
          {manageReason === undefined ? null : <p className="muted" role="note">{labels.readOnly}</p>}
      </section>
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
      <Button danger="subtle" disabled={!canManage || pending} {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { setConfirmDelete(true); }}>{labels.delete}</Button>
    </div>}
  </SubInspector>;

  return <>
    <ListDetail list={list} inspector={inspector} onCloseInspector={closeInspector} />
    <ConfirmDialog opened={confirmDelete} title={labels.deleteTitle(selected?.name ?? "")} description={labels.deleteDescription(selected?.name ?? "")}
      confirmLabel={labels.deleteConfirm(selected?.name ?? "")} cancelLabel={labels.cancel} onCancel={() => { setConfirmDelete(false); }}
      onConfirm={() => { void removeOverlay(); }} pending={pending} danger {...(error === null ? {} : { error })} />
    <ConfirmDialog opened={revokeTarget !== null} title={`${labels.revoke}: ${revokeTarget?.label ?? ""}`}
      description={revokeTarget?.label ?? ""} confirmLabel={`${labels.revoke}: ${revokeTarget?.label ?? ""}`} cancelLabel={labels.cancel}
      onCancel={() => { setRevokeTarget(null); }} onConfirm={() => { void revoke(); }} pending={pending} danger {...(error === null ? {} : { error })} />
    <ConfirmDialog opened={legacyRevokeTarget !== null}
      title={labels.legacyRevokeTitle(labels.legacyTokenName)}
      description={labels.legacyRevokeDescription(labels.legacyTokenName)}
      confirmLabel={labels.legacyRevokeConfirm(labels.legacyTokenName)} cancelLabel={labels.cancel}
      onCancel={() => { setLegacyRevokeTarget(null); }} onConfirm={() => { void revokeLegacy(); }} pending={pending} danger
      {...(legacyError === null ? {} : { error: legacyError })} />
  </>;
}
