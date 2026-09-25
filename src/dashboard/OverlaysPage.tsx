import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import streamElementsFields from "../../docs/embedding/streamelements/fields.json?raw";
import streamElementsHtml from "../../docs/embedding/streamelements/widget.html?raw";
import streamElementsJs from "../../docs/embedding/streamelements/widget.js?raw";

import {
  createOverlay,
  deleteOverlay,
  fetchOverlay,
  fetchOverlayAccesses,
  fetchOverlays,
  fetchOverlayTokens,
  importLegacyOverlay,
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
import { Button, ConfirmDialog, Field, FormDialog, ListDetail, NumberField, Select, SubInspector } from "./ui";

interface OverlaysPageProperties {
  channelId: string;
  canManage: boolean;
  initialSelection?: string;
  onOpenEditor?: (overlayId: string) => void;
}

const blankOverlayName = "";
const maskOverlaySecret = (overlayUrl: string): string => overlayUrl.replace(/([#&]token=)[^&]*/u, "$1••••••");
const VARIABLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
type SetupTarget = "obs" | "streamelements" | "soundalerts";
type SetupSnippetKind = "html" | "js" | "fields";
const setupTargets: readonly SetupTarget[] = ["obs", "streamelements", "soundalerts"];
const setupSnippets: readonly { kind: SetupSnippetKind; content: string }[] = [
  { kind: "html", content: streamElementsHtml },
  { kind: "js", content: streamElementsJs },
  { kind: "fields", content: streamElementsFields },
];

const elementOutputUrl = (overlayUrl: string, elementId: string | null): string => elementId === null
  ? overlayUrl
  : `${overlayUrl}${overlayUrl.includes("#") ? "&" : "#"}element=${encodeURIComponent(elementId)}`;

const selectedOutputElementId = (elements: PanelOverlay["elements"], output: string): string | null => {
  if (!output.startsWith("element:")) return null;
  const requestedId = output.slice("element:".length);
  return elements.find((element) => element.id === requestedId)?.id ?? null;
};

const parseLegacyOverlayLink = (value: string): { token: string; variableName: string; text: string } | null => {
  try {
    const url = new URL(value.trim(), window.location.origin);
    if (url.hash.length <= 1) return null;
    const fragment = new URLSearchParams(url.hash.slice(1));
    const token = fragment.get("token");
    const variableName = fragment.get("var");
    const text = variableName === null ? null : fragment.get("text") ?? `${variableName}: {value}`;
    if (token === null || !/^[A-Za-z0-9_-]{43}$/u.test(token) || variableName === null ||
        !VARIABLE_NAME_PATTERN.test(variableName) || text === null || text.length > 100) return null;
    return { token, variableName, text };
  } catch {
    return null;
  }
};

interface ScopedOverlaySecret extends PanelIssuedOverlayAccess {
  overlayId: string;
}

interface OverlaySetupAssistantProperties {
  labels: ReturnType<typeof overlaysTexts>;
  overlay: PanelOverlay;
  access: PanelOverlayAccess;
  target: SetupTarget;
  onTargetChange: (target: SetupTarget) => void;
  output: string;
  onOutputChange: (output: string) => void;
  visibleUrl: string;
  canCopyUrl: boolean;
  copyUrlReason: string | null;
  copiedUrl: boolean;
  urlActionLabel: string;
  pending: boolean;
  onCopyUrl: () => void;
  copiedSnippet: string | null;
  onCopySnippet: (target: SetupTarget, kind: SetupSnippetKind, content: string) => void;
}

function OverlaySetupAssistant({
  labels,
  overlay,
  access,
  target,
  onTargetChange,
  output,
  onOutputChange,
  visibleUrl,
  canCopyUrl,
  copyUrlReason,
  copiedUrl,
  urlActionLabel,
  pending,
  onCopyUrl,
  copiedSnippet,
  onCopySnippet,
}: OverlaySetupAssistantProperties): ReactElement {
  const instanceId = useId();
  const targetTabRefs = useRef<Record<SetupTarget, HTMLButtonElement | null>>({ obs: null, streamelements: null, soundalerts: null });
  const outputElementId = selectedOutputElementId(overlay.elements, output);
  const selectedElement = outputElementId === null
    ? null
    : overlay.elements.find((element) => element.id === outputElementId) ?? null;
  const effectiveOutput = selectedElement === null ? "whole" : output;
  const visibleOutputUrl = elementOutputUrl(visibleUrl, outputElementId);
  const outputOptions = [
    { value: "whole", label: labels.setupWholeOverlay },
    ...overlay.elements.map((element) => ({ value: `element:${element.id}`, label: `${labels.setupSingleElement}: ${element.label || element.id}` })),
  ];
  const targetLabels: Record<SetupTarget, string> = {
    obs: labels.setupObs,
    streamelements: labels.setupStreamElements,
    soundalerts: labels.setupSoundAlerts,
  };
  const tabId = (item: SetupTarget): string => `${instanceId}-setup-tab-${item}`;
  const panelId = (item: SetupTarget): string => `${instanceId}-setup-panel-${item}`;
  const onTargetTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const currentIndex = setupTargets.indexOf(target);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % setupTargets.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex + setupTargets.length - 1) % setupTargets.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = setupTargets.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTarget = setupTargets[nextIndex];
    if (nextTarget === undefined) return;
    onTargetChange(nextTarget);
    targetTabRefs.current[nextTarget]?.focus();
  };
  const snippetCards = (snippetTarget: SetupTarget): ReactElement[] => setupSnippets.map((snippet) => {
    const label = snippet.kind === "html" ? labels.setupHtml : snippet.kind === "js" ? labels.setupJs : labels.setupFields;
    const copyKey = `${snippetTarget}:${snippet.kind}`;
    const wasCopied = copiedSnippet === copyKey;
    return <article className="overlay-setup__snippet" key={snippet.kind}>
      <div className="overlay-setup__snippet-heading">
        <h4>{label}</h4>
        <Button variant="neutral" disabled={pending} onClick={() => { onCopySnippet(snippetTarget, snippet.kind, snippet.content); }}>
          {wasCopied ? labels.setupSnippetCopied(label) : labels.setupCopySnippet(label)}
        </Button>
      </div>
      <details>
        <summary>{labels.setupViewSnippet}</summary>
        <pre><code>{snippet.content}</code></pre>
      </details>
    </article>;
  });

  return <section className="overlay-setup" aria-label={labels.setupAssistant}>
    <div className="overlay-setup__heading">
      <h3>{labels.setupAssistant}</h3>
      <span className="muted">{labels.setupAccessSelected(access.label)}</span>
    </div>
    <Select id={`${instanceId}-setup-output`} label={labels.setupOutput} value={effectiveOutput} onChange={(value) => { if (value !== null) onOutputChange(value); }}
      options={outputOptions} />
    {outputElementId === null
      ? <p className="muted">{labels.setupDimensions(overlay.width, overlay.height)}</p>
      : <p className="muted">{labels.setupElementDimensions}</p>}
    <div className="overlay-setup__link">
      <h4>{labels.setupOverlayUrl}</h4>
      <p className="overlay-setup__masked-url"><code>{visibleOutputUrl}</code></p>
      <Button variant="neutral" disabled={!canCopyUrl || pending}
        {...(copyUrlReason === null ? {} : { describedBy: `${instanceId}-setup-copy-reason`, title: copyUrlReason })}
        onClick={onCopyUrl}>{copiedUrl ? labels.setupCopiedUrl : urlActionLabel}</Button>
      {copyUrlReason === null ? null : <p id={`${instanceId}-setup-copy-reason`} className="muted" role="note">{copyUrlReason}</p>}
    </div>
    <div className="overlay-setup__tabs" role="tablist" aria-label={labels.setupTarget}>
      {setupTargets.map((item) => <button key={item} ref={(element) => { targetTabRefs.current[item] = element; }}
        type="button" role="tab" id={tabId(item)} aria-controls={panelId(item)} aria-selected={target === item}
        tabIndex={target === item ? 0 : -1} className="overlay-setup__tab" onClick={() => { onTargetChange(item); }}
        onKeyDown={onTargetTabKeyDown}>{targetLabels[item]}</button>)}
    </div>
    {setupTargets.map((item) => <div key={item} id={panelId(item)} role="tabpanel" aria-labelledby={tabId(item)} tabIndex={0}
      hidden={target !== item} className="overlay-setup__panel">
      {item === "obs" ? <>
        <ol>
          <li>{labels.setupObsAddSource}</li>
          <li>{labels.setupObsBrowser}</li>
          <li>{labels.setupObsPasteUrl}</li>
          <li>{labels.setupObsSetSize}</li>
          <li>{labels.setupObsClearCss}</li>
        </ol>
        <p className="muted" role="note">{labels.setupObsCssNote}</p>
      </> : item === "streamelements" ? <>
        <p>{labels.setupStreamElementsPath}</p>
        <p>{labels.setupStreamElementsPaste}</p>
        <div className="overlay-setup__snippets">{snippetCards(item)}</div>
        <p className="muted">{outputElementId === null
          ? labels.setupStreamElementsWholePlacement(overlay.width, overlay.height)
          : labels.setupStreamElementsElementPlacement}</p>
      </> : <>
        <p>{labels.setupSoundAlertsPath}</p>
        <p className="muted" role="note">{labels.setupSoundAlertsUnverified}</p>
        <p>{labels.setupSoundAlertsFallback}</p>
        <div className="overlay-setup__snippets">{snippetCards(item)}</div>
      </>}
    </div>)}
  </section>;
}

export function OverlaysPage({ channelId, canManage, initialSelection, onOpenEditor }: OverlaysPageProperties): ReactElement {
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
  const [showSecret, setShowSecret] = useState(false);
  const [setupAccessId, setSetupAccessId] = useState<string | null>(null);
  const [setupTarget, setSetupTarget] = useState<SetupTarget>("obs");
  const [setupOutput, setSetupOutput] = useState("whole");
  const [setupCopiedUrl, setSetupCopiedUrl] = useState(false);
  const [setupCopiedSnippet, setSetupCopiedSnippet] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PanelOverlayAccess | null>(null);
  const [legacyTokens, setLegacyTokens] = useState<readonly PanelOverlayToken[]>([]);
  const [legacyNextOffset, setLegacyNextOffset] = useState<number | null>(null);
  const [legacyError, setLegacyError] = useState<string | null>(null);
  const [legacyRevokeTarget, setLegacyRevokeTarget] = useState<PanelOverlayToken | null>(null);
  const [legacyImportOpen, setLegacyImportOpen] = useState(false);
  const [legacyImportLink, setLegacyImportLink] = useState("");
  const [legacyImportError, setLegacyImportError] = useState<string | null>(null);
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
    setShowSecret(false);
  }, []);
  const changeSelection = useCallback((nextId: string | null): void => {
    invalidateSecret();
    setSetupAccessId(null);
    setSetupTarget("obs");
    setSetupOutput("whole");
    setSetupCopiedUrl(false);
    setSetupCopiedSnippet(null);
    selectedIdRef.current = nextId;
    setSelectedId(nextId);
  }, [invalidateSecret]);
  const secretContextIsCurrent = (version: number, overlayId: string, requestedChannelId: string): boolean =>
    pageActiveRef.current && secretVersion.current === version && selectedIdRef.current === overlayId &&
    channelIdRef.current === requestedChannelId && permissionRef.current;
  const accessContextIsCurrent = (overlayId: string, requestedChannelId: string): boolean =>
    pageActiveRef.current && selectedIdRef.current === overlayId && channelIdRef.current === requestedChannelId && permissionRef.current;

  useLayoutEffect(() => {
    const accessContextChanged = permissionRef.current !== canManage || channelIdRef.current !== channelId;
    if (accessContextChanged) invalidateSecret();
    if (channelIdRef.current !== channelId) {
      changeSelection(null);
      setSelectedOverlayData(null);
    }
    if (accessContextChanged) {
      setLegacyImportOpen(false);
      setLegacyImportLink("");
      setLegacyImportError(null);
    }
    permissionRef.current = canManage;
    channelIdRef.current = channelId;
  }, [canManage, channelId, changeSelection, invalidateSecret]);
  const selected = useMemo(() => overlays.find((overlay) => overlay.id === selectedId) ?? null, [overlays, selectedId]);
  const selectedOverlay = selectedOverlayData?.id === selectedId ? selectedOverlayData.overlay : null;
  const accesses = selectedOverlayData?.id === selectedId ? selectedOverlayData.accesses : [];
  const setupAccess = accesses.find((access) => access.tokenId === setupAccessId) ?? null;

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
    setShowSecret(false);
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

  const revealAccessUrl = async (access: PanelOverlayAccess): Promise<string | null> => {
    if (selectedOverlay === null || !canManage || access.revokedAt !== null || !access.recoverable) return null;
    if (secret?.overlayId === selectedOverlay.id && secret.tokenId === access.tokenId) return secret.overlayUrl;
    const overlayId = selectedOverlay.id;
    invalidateSecret();
    const version = secretVersion.current;
    const requestedChannelId = channelId;
    const result = await revealOverlayAccess(channelId, overlayId, access.tokenId);
    if (secretContextIsCurrent(version, overlayId, requestedChannelId)) {
      saveIssuedSecret({ tokenId: access.tokenId, overlayUrl: result.overlayUrl, label: access.label, expiresAt: access.expiresAt }, overlayId);
      return result.overlayUrl;
    }
    return null;
  };

  const reveal = async (access: PanelOverlayAccess): Promise<void> => {
    if (selectedOverlay === null || !canManage || pending || access.revokedAt !== null || !access.recoverable) return;
    const overlayId = selectedOverlay.id;
    const requestedChannelId = channelId;
    setPending(true);
    setError(null);
    try {
      await revealAccessUrl(access);
    } catch (caught) {
      if (accessContextIsCurrent(overlayId, requestedChannelId)) {
        setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
      }
    } finally {
      setPending(false);
    }
  };

  const copySetupUrl = async (): Promise<void> => {
    if (setupAccess === null || selectedOverlay === null || !canManage || pending || !isAccessActive(setupAccess) || !setupAccess.recoverable) return;
    const overlayId = selectedOverlay.id;
    const requestedChannelId = channelId;
    try {
      const overlayUrl = secret?.overlayId === overlayId && secret.tokenId === setupAccess.tokenId
        ? secret.overlayUrl
        : null;
      setSetupCopiedUrl(false);
      setError(null);
      if (overlayUrl === null) {
        setPending(true);
        await revealAccessUrl(setupAccess);
        return;
      }
      const elementId = selectedOutputElementId(selectedOverlay.elements, setupOutput);
      const copyPromise = navigator.clipboard.writeText(elementOutputUrl(overlayUrl, elementId));
      setPending(true);
      await copyPromise;
      if (accessContextIsCurrent(overlayId, requestedChannelId)) setSetupCopiedUrl(true);
    } catch (caught) {
      if (accessContextIsCurrent(overlayId, requestedChannelId)) {
        setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.copyError);
      }
    } finally {
      setPending(false);
    }
  };

  const copySetupSnippet = async (target: SetupTarget, kind: SetupSnippetKind, content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
      setSetupCopiedSnippet(`${target}:${kind}`);
      setError(null);
    } catch {
      setError(labels.copyError);
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
      const result = await revokeOverlayToken(channelId, legacyRevokeTarget.id, labels.legacyRevocationReason);
      setLegacyRevokeTarget(null);
      setNotice(result.closingPending ? labels.revokedPending : labels.revoked);
      await loadLegacyTokens();
    } catch (caught) {
      setLegacyError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
    } finally {
      setPending(false);
    }
  };

  const importLegacy = async (): Promise<void> => {
    if (!canManage || pending) return;
    const parsed = parseLegacyOverlayLink(legacyImportLink);
    if (parsed === null) {
      setLegacyImportError(labels.legacyImportInvalidLink);
      return;
    }
    setPending(true);
    setLegacyImportError(null);
    try {
      const result = await importLegacyOverlay(channelId, parsed);
      setLegacyImportOpen(false);
      setLegacyImportLink("");
      changeSelection(result.overlay.id);
      await Promise.all([load(), loadLegacyTokens()]);
      setNotice(result.closingPending ? labels.legacyImportClosingPending : labels.legacyImportSuccess(result.overlay.name));
    } catch (caught) {
      if (caught instanceof PanelApiError && caught.code === "overlay_token_not_found") {
        setLegacyImportError(labels.legacyImportTokenNotFound);
      } else if (caught instanceof PanelApiError && caught.code === "overlay_token_already_bound") {
        setLegacyImportError(labels.legacyImportAlreadyBound);
      } else {
        setLegacyImportError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
      }
    } finally {
      setPending(false);
    }
  };

  const isAccessActive = (access: PanelOverlayAccess): boolean => access.revokedAt === null &&
    (access.expiresAt === null || Date.parse(access.expiresAt) > now);
  const manageReason = canManage ? undefined : labels.managementLocked;
  const setupCopyUrlReason = setupAccess === null ? null
    : !canManage ? labels.setupCopyUnavailable
      : !setupAccess.recoverable ? labels.accessUnrecoverable
        : !isAccessActive(setupAccess) ? labels.setupAccessInactive : null;
  const setupCanCopyUrl = setupAccess !== null && setupCopyUrlReason === null;
  const setupUrlRevealed = setupAccess !== null && secret?.overlayId === selectedId && secret.tokenId === setupAccess.tokenId;
  const setupBaseUrl = setupAccess !== null && secret?.overlayId === selectedId && secret.tokenId === setupAccess.tokenId
    ? maskOverlaySecret(secret.overlayUrl)
    : `${window.location.origin}/overlay#token=••••••`;
  const legacyRevokeIdentity = legacyRevokeTarget === null
    ? labels.legacyTokenName
    : `${labels.legacyTokenName} (${legacyRevokeTarget.id.slice(0, 8)})`;
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
    {!loading && overlays.length > 0 ? <div className={`table-wrap overlays-table-wrap${selectedId !== null || creating ? " overlays-table-wrap--inspector-open" : ""}`}>
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
      <div className="overlay-legacy-links__heading">
        <h2>{labels.legacyTitle}</h2>
        {canManage ? <Button variant="neutral" disabled={pending} onClick={() => {
          setLegacyImportLink("");
          setLegacyImportError(null);
          setLegacyImportOpen(true);
        }}>{labels.legacyImport}</Button> : null}
      </div>
      <p className="muted">{labels.legacyDescription}</p>
      <ul className="overlay-access-list">{legacyTokens.map((token) => <li key={token.id} className="overlay-access-list__item">
        <div><strong>{labels.legacyTokenName}</strong>
          <span className="muted">{labels.legacyTokenId}: {token.id.slice(0, 8)}</span>
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
      {onOpenEditor === undefined ? null : <Button variant="primary" onClick={() => { onOpenEditor(selectedOverlay.id); }}>{labels.editComposition}</Button>}
      <section className="overlay-elements-section" aria-label={labels.elements}>
        <h3>{labels.elements}</h3>
        {selectedOverlay.elements.length === 0 ? <p className="muted">{labels.elementCount(0)}</p> : <ul className="overlay-elements-list">{selectedOverlay.elements.map((element) => <li key={element.id}>
          {element.label || element.id}{element.variableName === null ? <span className="muted"> · {element.missingVariableName === undefined || element.missingVariableName === null ? "—" : labels.missingVariable(element.missingVariableName)}</span> : null}
        </li>)}</ul>}
      </section>
      <section className="overlay-access-section" aria-label={labels.accesses}>
        <h3>{labels.accesses}</h3>
        <Field id="overlay-access-name" label={labels.issueLabel} hint={labels.issueHint} value={accessName} maxLength={40} countLabel={(count, max) => `${String(count)} / ${String(max)}`} disabled={!canManage || pending} onChange={setAccessName} />
          <Button variant="primary" disabled={!canManage || pending || accessName.trim().length === 0}
            {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { void issue(); }}>{labels.issue}</Button>
          {accesses.length === 0 ? <p className="muted">{labels.noAccesses}</p> : <ul className="overlay-access-list">{accesses.map((access) => {
            const active = isAccessActive(access);
            const status = access.revokedAt !== null ? labels.revokedStatus : active ? labels.active : labels.expired;
            const statusTone = access.revokedAt !== null ? "revoked" : active ? "active" : "expired";
            return (
              <li key={access.tokenId} className="overlay-access-list__item">
                <div><strong>{access.label}</strong>
                  <span className="muted">{labels.lastUsedAt}: {access.lastUsedAt === null ? labels.lastUsedNever : formatTimestamp(access.lastUsedAt)}</span>
                  <span className="overlay-access-list__status" data-status={statusTone}>{labels.statusLabel}: {status}</span>
                </div>
                <div className="overlay-access-list__actions">
                  <Button variant="neutral" ariaPressed={setupAccessId === access.tokenId} disabled={pending}
                    onClick={() => {
                      if (secret?.overlayId !== selectedId || secret.tokenId !== access.tokenId) invalidateSecret();
                      setSetupAccessId(access.tokenId);
                      setSetupTarget("obs");
                      setSetupOutput("whole");
                      setSetupCopiedUrl(false);
                      setSetupCopiedSnippet(null);
                    }}>{labels.setup}</Button>
                  <Button variant="neutral" disabled={!canManage || pending || !active || !access.recoverable} {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { void reveal(access); }}>{labels.reveal}</Button>
                  <Button variant="neutral" disabled={!canManage || pending || !active} {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { void replace(access); }}>{labels.replace}</Button>
                  <Button danger="subtle" disabled={!canManage || pending || !active} {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { setRevokeTarget(access); }}>{labels.revoke}</Button>
                  {!access.recoverable ? <span className="muted">{labels.accessUnrecoverable}</span> : null}
                </div>
              </li>
            );
          })}</ul>}
          {setupAccess === null ? null : <OverlaySetupAssistant labels={labels} overlay={selectedOverlay} access={setupAccess}
            target={setupTarget} onTargetChange={(target) => { setSetupTarget(target); setSetupCopiedSnippet(null); }}
            output={setupOutput} onOutputChange={(output) => { setSetupOutput(output); setSetupCopiedUrl(false); }}
            visibleUrl={setupBaseUrl} canCopyUrl={setupCanCopyUrl} copyUrlReason={setupCopyUrlReason} copiedUrl={setupCopiedUrl}
            urlActionLabel={setupUrlRevealed ? labels.setupCopyRevealedUrl : labels.setupRevealUrl} pending={pending}
            onCopyUrl={() => { void copySetupUrl(); }} copiedSnippet={setupCopiedSnippet}
            onCopySnippet={(target, kind, content) => { void copySetupSnippet(target, kind, content); }} />}
          {secret === null || secret.overlayId !== selectedId || !canManage ? null : <div className="overlay-access-secret" aria-label={labels.issue}>
            <p className="overlay-access-secret__masked"><code>{maskOverlaySecret(secret.overlayUrl)}</code></p>
            <Button variant="neutral" disabled={pending} onClick={() => { setShowSecret((current) => !current); }}>
              {showSecret ? labels.hideLink : labels.showLink}
            </Button>
            {showSecret ? <Field id="overlay-access-full-link" label={labels.fullLink} value={secret.overlayUrl} onChange={() => {}} readOnly mono /> : null}
            <Button variant="neutral" disabled={pending} onClick={() => { void copySecret(); }}>{copied ? labels.copied : labels.copy}</Button>
          </div>}
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
      title={labels.legacyRevokeTitle(legacyRevokeIdentity)}
      description={labels.legacyRevokeDescription(legacyRevokeIdentity)}
      confirmLabel={labels.legacyRevokeConfirm(legacyRevokeIdentity)} cancelLabel={labels.cancel}
      onCancel={() => { setLegacyRevokeTarget(null); }} onConfirm={() => { void revokeLegacy(); }} pending={pending} danger
      {...(legacyError === null ? {} : { error: legacyError })} />
    <FormDialog opened={legacyImportOpen} title={labels.legacyImportTitle}
      description={labels.legacyImportDescription} confirmLabel={labels.legacyImportConfirm}
      cancelLabel={labels.cancel} onCancel={() => {
        setLegacyImportOpen(false);
        setLegacyImportLink("");
        setLegacyImportError(null);
      }}
      onConfirm={() => { void importLegacy(); }} pending={pending}
      confirmDisabled={legacyImportLink.trim().length === 0}
      {...(legacyImportError === null ? {} : { error: legacyImportError })}>
      <div className="overlay-legacy-import-form">
        <Field id="overlay-legacy-import-link" label={labels.legacyImportLinkLabel} value={legacyImportLink}
          onChange={(value) => { setLegacyImportLink(value); setLegacyImportError(null); }}
          placeholder={labels.legacyImportPlaceholder} mono disabled={pending}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void importLegacy(); } }} />
        <ul className="muted">
          <li>{labels.legacyImportCssWarning}</li>
          <li>{labels.legacyImportPositionWarning}</li>
          <li>{labels.legacyImportTokenWarning}</li>
        </ul>
      </div>
    </FormDialog>
  </>;
}
