import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactElement } from "react";

import {
  fetchOverlayTokens,
  issueOverlayToken,
  PanelApiError,
  revokeOverlayToken,
  type PanelOverlayToken,
} from "./api";
import { apiErrorText, formatTimestamp, overlayTokensTexts, dashboardLanguage } from "./locale";
import { Button, ConfirmDialog, Icon, ListDetail, SubInspector } from "./ui";

interface OverlayTokensPageProperties {
  channelId: string;
  canManage: boolean;
}

const rowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, onSelect: () => void): void => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelect();
  }
};

export function OverlayTokensPage({ channelId, canManage: canManageTokens }: OverlayTokensPageProperties): ReactElement {
  const language = dashboardLanguage();
  const labels = overlayTokensTexts(language);
  const [tokens, setTokens] = useState<readonly PanelOverlayToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await fetchOverlayTokens(channelId);
      setTokens(result.tokens);
      setError(null);
    } catch (caught) {
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.loadError) : labels.loadError);
    } finally {
      setLoading(false);
    }
  }, [channelId, labels.loadError]);

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void fetchOverlayTokens(channelId).then((result) => {
        if (!active) return;
        setTokens(result.tokens);
        setError(null);
      }).catch((caught: unknown) => {
        if (!active) return;
        setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.loadError) : labels.loadError);
      }).finally(() => { if (active) setLoading(false); });
    };
    refresh();
    const reload = (): void => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      active = false;
      window.removeEventListener("focus", reload);
      document.removeEventListener("visibilitychange", reload);
    };
  }, [channelId, labels.loadError]);

  const selected = useMemo(() => tokens.find((token) => token.id === selectedId) ?? null, [selectedId, tokens]);
  const displayName = selected?.name ?? selected?.id ?? selectedId ?? "";
  const manageReason = canManageTokens ? undefined : labels.managementLocked;

  const closeInspector = (): void => {
    setSelectedId(null);
    setOneTimeLink(null);
    setCopied(false);
    setError(null);
  };

  const selectToken = (token: PanelOverlayToken): void => {
    setSelectedId(token.id);
    setOneTimeLink(null);
    setCopied(false);
    setError(null);
  };

  const issue = async (): Promise<void> => {
    if (!canManageTokens || pending || oneTimeLink !== null) return;
    setPending(true);
    setError(null);
    setOneTimeLink(null);
    setCopied(false);
    try {
      const result = await issueOverlayToken(channelId);
      setSelectedId(result.tokenId);
      setOneTimeLink(result.overlayUrl);
      await load();
    } catch (caught) {
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
    } finally {
      setPending(false);
    }
  };

  const copyLink = async (): Promise<void> => {
    if (oneTimeLink === null) return;
    try {
      await navigator.clipboard.writeText(oneTimeLink);
      setCopied(true);
      setError(null);
    } catch {
      setError(labels.copyError);
    }
  };

  const revoke = async (): Promise<void> => {
    if (selectedId === null || !canManageTokens || pending) return;
    setPending(true);
    setError(null);
    try {
      await revokeOverlayToken(channelId, selectedId, labels.revocationReason);
      setConfirmRevoke(false);
      closeInspector();
      await load();
    } catch (caught) {
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.actionError) : labels.actionError);
    } finally {
      setPending(false);
    }
  };

  const list = <section className="overlay-tokens-page config-section" aria-label={labels.list}>
    <div className="section-heading">
      <h1>{labels.title}</h1>
      <span className="muted number">{String(tokens.length)}</span>
      <span title={manageReason}>
        <Button icon="add" iconOnly ariaLabel={labels.create} disabled={!canManageTokens || pending || oneTimeLink !== null} {...(manageReason !== undefined ? { title: manageReason } : oneTimeLink !== null ? { title: labels.issueBlocked } : {})} onClick={() => { void issue(); }} />
      </span>
    </div>
    {oneTimeLink === null ? null : <p className="muted" role="note">{labels.issueBlocked}</p>}
    {loading ? <p className="loading-line">{labels.loading}</p> : null}
    {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    {!loading && tokens.length === 0 ? <p className="empty-state">{labels.empty}</p> : null}
    {!loading && tokens.length > 0 ? <div className="table-wrap overlay-tokens-table-wrap">
      <table className="table overlay-tokens-table">
        <thead><tr>
          <th scope="col">{labels.identifier}</th>
          <th scope="col">{labels.createdAt}</th>
          <th scope="col">{labels.lastUsedAt}</th>
        </tr></thead>
        <tbody>{tokens.map((token) => (
          <tr key={token.id} tabIndex={0} aria-selected={token.id === selectedId} onClick={() => { selectToken(token); }} onKeyDown={(event) => { rowKeyDown(event, () => { selectToken(token); }); }}>
            <th scope="row" className="mono" title={token.id}>{token.name ?? token.id}</th>
            <td><time dateTime={token.createdAt} title={token.createdAt}>{formatTimestamp(token.createdAt)}</time></td>
            <td>{token.lastUsedAt === null ? labels.never : <time dateTime={token.lastUsedAt} title={token.lastUsedAt}>{formatTimestamp(token.lastUsedAt)}</time>}</td>
          </tr>
        ))}</tbody>
      </table>
    </div> : null}
    {manageReason === undefined ? null : <p className="muted" role="note">{manageReason}</p>}
  </section>;

  const inspector = selected !== null || oneTimeLink !== null ? (
    <SubInspector
      ariaLabel={labels.title}
      title={selected?.name ?? labels.title}
      identifier={selected?.id ?? selectedId ?? undefined}
      closeLabel={labels.close}
      onClose={closeInspector}
    >
      {oneTimeLink === null ? null : <section className="overlay-token-one-time" aria-label={labels.linkLabel}>
        <h3>{labels.linkLabel}</h3>
        <p className="overlay-token-link mono">{oneTimeLink}</p>
        <p className="muted" role="note">{labels.linkNote}</p>
        <Button variant="neutral" disabled={pending} onClick={() => { void copyLink(); }}>
          <Icon name="copy" size={16} /> {copied ? labels.copied : labels.copy}
        </Button>
      </section>}
      {selected === null ? null : <dl className="properties overlay-token-properties">
        <div><dt>{labels.identifier}</dt><dd className="mono">{selected.id}</dd></div>
        <div><dt>{labels.createdAt}</dt><dd><time dateTime={selected.createdAt}>{formatTimestamp(selected.createdAt)}</time></dd></div>
        <div><dt>{labels.createdBy}</dt><dd>{selected.createdBy ?? labels.unknownCreator}</dd></div>
        <div><dt>{labels.lastUsedAt}</dt><dd>{selected.lastUsedAt === null ? labels.never : <time dateTime={selected.lastUsedAt}>{formatTimestamp(selected.lastUsedAt)}</time>}</dd></div>
        <div><dt>{labels.expiresAt}</dt><dd>{selected.expiresAt === null ? labels.never : <time dateTime={selected.expiresAt}>{formatTimestamp(selected.expiresAt)}</time>}</dd></div>
      </dl>}
      {selectedId === null ? null : <span title={manageReason}>
        <Button danger="subtle" disabled={!canManageTokens || pending} {...(manageReason === undefined ? {} : { title: manageReason })} onClick={() => { setConfirmRevoke(true); }}>{labels.revoke}</Button>
      </span>}
      {manageReason === undefined ? null : <p className="muted" role="note">{manageReason}</p>}
      {error === null ? null : <p className="form-error" role="alert">{error}</p>}
    </SubInspector>
  ) : null;

  return <>
    <ListDetail list={list} inspector={inspector} onCloseInspector={closeInspector} />
    <ConfirmDialog
      opened={confirmRevoke}
      title={labels.revokeTitle(displayName)}
      description={labels.revokeDescription(displayName)}
      confirmLabel={labels.revokeConfirm(displayName)}
      cancelLabel={labels.revokeCancel}
      onCancel={() => { setConfirmRevoke(false); }}
      onConfirm={() => { void revoke(); }}
      pending={pending}
      danger
    />
  </>;
}
