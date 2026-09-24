import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

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
  if (event.target !== event.currentTarget) return;
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [oneTimeLink, setOneTimeLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const listRequestVersion = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestVersion = ++listRequestVersion.current;
    try {
      const result = await fetchOverlayTokens(channelId);
      if (listRequestVersion.current !== requestVersion) return;
      setTokens(result.tokens);
      setNextOffset(result.nextOffset ?? null);
      setError(null);
    } catch (caught) {
      if (listRequestVersion.current !== requestVersion) return;
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.loadError) : labels.loadError);
    } finally {
      if (listRequestVersion.current === requestVersion) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [channelId, labels.loadError]);

  const loadMore = async (): Promise<void> => {
    if (nextOffset === null || loadingMore || pending) return;
    const requestVersion = ++listRequestVersion.current;
    setLoadingMore(true);
    try {
      const result = await fetchOverlayTokens(channelId, nextOffset);
      if (listRequestVersion.current !== requestVersion) return;
      setTokens((current) => [...current, ...result.tokens]);
      setNextOffset(result.nextOffset ?? null);
      setError(null);
    } catch (caught) {
      if (listRequestVersion.current !== requestVersion) return;
      setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.loadError) : labels.loadError);
    } finally {
      if (listRequestVersion.current === requestVersion) setLoadingMore(false);
    }
  };

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      const requestVersion = ++listRequestVersion.current;
      void fetchOverlayTokens(channelId).then((result) => {
        if (!active || listRequestVersion.current !== requestVersion) return;
        setTokens(result.tokens);
        setNextOffset(result.nextOffset ?? null);
        setError(null);
      }).catch((caught: unknown) => {
        if (!active || listRequestVersion.current !== requestVersion) return;
        setError(caught instanceof PanelApiError ? apiErrorText(caught.code, labels.loadError) : labels.loadError);
      }).finally(() => {
        if (!active || listRequestVersion.current !== requestVersion) return;
        setLoading(false);
        setLoadingMore(false);
      });
    };
    refresh();
    const reload = (): void => {
      if (document.visibilityState !== "visible") return;
      setLoading(true);
      setLoadingMore(false);
      setNextOffset(null);
      refresh();
    };
    window.addEventListener("focus", reload);
    document.addEventListener("visibilitychange", reload);
    return () => {
      active = false;
      listRequestVersion.current += 1;
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
    // A newly issued URL is the only copy of its secret. Row selection must
    // not silently replace the issued-link inspector before explicit dismissal.
    if (oneTimeLink !== null) return;
    setSelectedId(token.id);
    setCopied(false);
    setError(null);
  };

  const dismissIssuedLink = (): void => {
    setOneTimeLink(null);
    setSelectedId(null);
    setCopied(false);
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
      setNotice(null);
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
      const result = await revokeOverlayToken(channelId, selectedId, labels.revocationReason);
      setConfirmRevoke(false);
      closeInspector();
      await load();
      setNotice(result.closingPending ? labels.revokedPending : labels.revoked);
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
          <th scope="col">{labels.createdBy}</th>
          <th scope="col">{labels.createdAt}</th>
          <th scope="col">{labels.lastUsedAt}</th>
          <th scope="col">{labels.expiresAt}</th>
          <th scope="col"><span className="visually-hidden">{labels.revoke}</span></th>
        </tr></thead>
        <tbody>{tokens.map((token) => (
          <tr key={token.id} tabIndex={0} aria-selected={token.id === selectedId} onClick={() => { selectToken(token); }} onKeyDown={(event) => { rowKeyDown(event, () => { selectToken(token); }); }}>
            <th scope="row" className="mono" title={token.id}>{token.name ?? token.id}</th>
            <td>{token.createdBy ?? labels.unknownCreator}</td>
            <td><time dateTime={token.createdAt} title={token.createdAt}>{formatTimestamp(token.createdAt)}</time></td>
            <td>{token.lastUsedAt === null ? labels.never : <time dateTime={token.lastUsedAt} title={token.lastUsedAt}>{formatTimestamp(token.lastUsedAt)}</time>}</td>
            <td>{token.expiresAt === null ? labels.never : <time dateTime={token.expiresAt} title={token.expiresAt}>{formatTimestamp(token.expiresAt)}</time>}</td>
            <td className="overlay-tokens-table__action" onClick={(event) => { event.stopPropagation(); }}>
              <Button danger="subtle" icon="remove" iconOnly ariaLabel={labels.revoke}
                disabled={!canManageTokens || pending || oneTimeLink !== null}
                {...(manageReason !== undefined ? { title: manageReason } : oneTimeLink !== null ? { title: labels.issueBlocked } : {})}
                onClick={() => { setSelectedId(token.id); setConfirmRevoke(true); }} />
            </td>
          </tr>
        ))}</tbody>
      </table>
    </div> : null}
    {nextOffset === null ? null : <Button variant="neutral" disabled={loadingMore || pending} onClick={() => { void loadMore(); }}>
      {loadingMore ? labels.loadingMore : labels.loadMore}
    </Button>}
    {notice === null ? null : <p className="muted" role="status">{notice}</p>}
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
        <Button variant="subtle" disabled={pending} onClick={dismissIssuedLink}>{labels.dismissLink}</Button>
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
