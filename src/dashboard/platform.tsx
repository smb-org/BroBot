import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject, type SyntheticEvent } from "react";

import type {
  PanelPlatformAuditEntry,
  PanelPlatformAuditResponse,
  PanelPlatformChannelOverview,
  PanelPlatformMembersResponse,
  PanelMember,
  PanelTwitchUser,
} from "../panel-contract";
import { CHANNEL_ROLES } from "../contracts/values";
import {
  changePlatformMember,
  removePlatformMember,
  addPlatformMember,
  releasePlatformChannel,
  getPlatformAudit,
  getPlatformMembers,
  getPlatformOverview,
  PanelApiError,
  setPlatformFullConsent,
  searchPlatformUser,
} from "./api";
import { platformActionLabel, platformTexts, roleLabel } from "./labels";
import { dashboardCommonTexts, formatTimestamp, formatNumber } from "./locale";
import { InspectorHeading, SubInspector } from "./inspector";
import { useInspectorSelection } from "./inspector-selection";
import { NavigationIcon, StateRow, type StateTone } from "./module-panels";

interface PlatformPageProperties {
  onAuthenticationRequired: () => void;
}

interface LoadState<T> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: string | null;
}

const emptyLoadState = <T,>(): LoadState<T> => ({ status: "idle", data: null, error: null });
const loadState = <T,>(): LoadState<T> => ({ status: "loading", data: null, error: null });
const loadedState = <T,>(data: T): LoadState<T> => ({ status: "success", data, error: null });

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.length > 0 ? error.message : fallback;

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const memberName = (member: PanelMember): string =>
  member.displayName ?? (member.login === null ? "Twitch-ID " + member.userId : "@" + member.login);

const userName = (user: PanelTwitchUser): string =>
  user.displayName.length > 0 ? user.displayName : "@" + user.login;

const roleOptions = (): ReactElement[] => CHANNEL_ROLES.filter((role) => role !== "broadcaster").map((role) => (
  <option key={role} value={role}>{roleLabel(role)}</option>
));

const connectionTone = (channel: PanelPlatformChannelOverview): StateTone =>
  channel.broadcasterConnected ? "healthy" : channel.fullConsent ? "warning" : "neutral";

const connectionWord = (channel: PanelPlatformChannelOverview): string => {
  const texts = platformTexts();
  return channel.broadcasterConnected ? texts.connected : channel.fullConsent ? texts.consentPending : texts.no;
};

const MembersTable = ({
  members: members,
  pendingRemoval,
  onRoleChange: onRoleChange,
  onRemove: onRemove,
  onConfirmRemoval: onConfirmRemoval,
  onCancelRemoval: onCancelRemoval,
  confirmButton: confirmationButton,
}: {
  members: PanelMember[];
  pendingRemoval: string | null;
  onRoleChange: (member: PanelMember, role: "manager" | "operator") => void;
  onRemove: (member: PanelMember) => void;
  onConfirmRemoval: (member: PanelMember) => void;
  onCancelRemoval: () => void;
  confirmButton: RefObject<HTMLButtonElement | null>;
}): ReactElement => {
  const texts = platformTexts();
  if (members.length === 0) return <p className="muted">{texts.noMembers}</p>;
  return (
    <div className="tabelle-wrap">
      <table className="tabelle">
        <thead>
          <tr>
            <th scope="col">{texts.login}</th>
            <th scope="col">{texts.role}</th>
            <th scope="col" className="tabelle__aktion">{texts.remove}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <Fragment key={member.userId}>
              <tr>
                <th scope="row">
                  <span>{memberName(member)}</span>
                  <span className="login-hinweis">
                    {member.login === null ? texts.twitchId(member.userId) : "@" + member.login + " · " + texts.twitchId(member.userId)}
                  </span>
                </th>
                <td>
                  {member.role === "broadcaster" ? <span>{roleLabel(member.role)}</span> : (
                    <select
                      aria-label={texts.role + ": " + memberName(member)}
                      value={member.role}
                      onChange={(event) => { onRoleChange(member, event.target.value as "manager" | "operator"); }}
                    >
                      {roleOptions()}
                    </select>
                  )}
                </td>
                <td className="tabelle__aktion">
                  {member.role === "broadcaster" ? (
                    <>
                      <button
                        className="button button--danger"
                        type="button"
                        disabled
                        title={texts.removeBroadcasterHint}
                        aria-describedby={"betreiber-entfernen-hinweis-" + member.userId}
                      >
                        {texts.remove}
                      </button>
                      <span id={"betreiber-entfernen-hinweis-" + member.userId} className="sr-only">{texts.removeBroadcasterHint}</span>
                    </>
                  ) : (
                    <button className="button button--danger" type="button" onClick={() => { onRemove(member); }}>
                      {texts.remove}
                    </button>
                  )}
                </td>
              </tr>
              {pendingRemoval === member.userId ? (
                <tr>
                  <td colSpan={3}>
                    <div className="inspector-confirmation" role="alertdialog" aria-label={texts.removeQuestion(memberName(member))}>
                      <h3>{texts.removeQuestion(memberName(member))}</h3>
                      <p>{texts.removeQuestion(memberName(member))}</p>
                      <div className="form-actions form-actions--destructive">
                        <button ref={confirmationButton} className="button button--danger" type="button" onClick={() => { onConfirmRemoval(member); }}>
                          {texts.confirmRemove}
                        </button>
                        <button className="button button--quiet" type="button" onClick={onCancelRemoval}>
                          {dashboardCommonTexts().cancel}
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const ChannelInspector = ({
  channel: channel,
  onAuthenticationRequired: onAuthenticationRequired,
  onReloadOverview: onReload,
  onClose,
}: {
  channel: PanelPlatformChannelOverview;
  onAuthenticationRequired: () => void;
  onReloadOverview: () => Promise<void>;
  onClose: () => void;
}): ReactElement => {
  const texts = platformTexts();
  const [members, setMembers] = useState<LoadState<PanelPlatformMembersResponse>>(() => emptyLoadState());
  const [foundMember, setFoundMember] = useState<PanelTwitchUser | null>(null);
  const [searchLogin, setSearchLogin] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchInProgress, setSearchInProgress] = useState(false);
  const [newRole, setNewRole] = useState<"manager" | "operator">("operator");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [consentInProgress, setConsentInProgress] = useState(false);
  const confirmationButton = useRef<HTMLButtonElement | null>(null);

  const loadMembers = async (): Promise<void> => {
    setMembers((current) => current.data === null ? loadState() : { ...current, status: "loading", error: null });
    try {
      setMembers(loadedState(await getPlatformMembers(channel.channelId)));
    } catch (error: unknown) {
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
      if (!isAbort(error)) setMembers({ status: "error", data: null, error: errorText(error, texts.error) });
    }
  };

  useEffect(() => {
    let aborted = false;
    const load = async (): Promise<void> => {
      try {
        const data = await getPlatformMembers(channel.channelId);
        if (!aborted) setMembers(loadedState(data));
      } catch (error: unknown) {
        if (!aborted && !isAbort(error)) {
          setMembers({ status: "error", data: null, error: errorText(error, texts.error) });
          if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
        }
      }
    };
    void load();
    return () => { aborted = true; };
  }, [channel.channelId, onAuthenticationRequired, texts.error]);

  useEffect(() => {
    if (pendingRemoval !== null) confirmationButton.current?.focus();
  }, [pendingRemoval]);

  const toggleConsent = async (): Promise<void> => {
    setConsentInProgress(true);
    setActionError(null);
    try {
      await setPlatformFullConsent(channel.channelId, !channel.fullConsent);
      await onReload();
    } catch (error: unknown) {
      setActionError(errorText(error, texts.error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setConsentInProgress(false);
    }
  };

  const searchUser = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSearchInProgress(true);
    setSearchError(null);
    setFoundMember(null);
    try {
      setFoundMember((await searchPlatformUser(searchLogin)).user);
    } catch (error: unknown) {
      setSearchError(errorText(error, texts.error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setSearchInProgress(false);
    }
  };

  const addMember = async (): Promise<void> => {
    if (foundMember === null) return;
    setBusyUserId(foundMember.userId);
    setActionError(null);
    try {
      await addPlatformMember(channel.channelId, foundMember.userId, newRole);
      setFoundMember(null);
      setSearchLogin("");
      await loadMembers();
    } catch (error: unknown) {
      setActionError(errorText(error, texts.error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  const changeRole = async (member: PanelMember, role: "manager" | "operator"): Promise<void> => {
    setBusyUserId(member.userId);
    setActionError(null);
    try {
      await changePlatformMember(channel.channelId, member.userId, role);
      await loadMembers();
    } catch (error: unknown) {
      setActionError(errorText(error, texts.error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  const removeMember = async (member: PanelMember): Promise<void> => {
    setBusyUserId(member.userId);
    setActionError(null);
    try {
      await removePlatformMember(channel.channelId, member.userId);
      setPendingRemoval(null);
      await loadMembers();
    } catch (error: unknown) {
      setActionError(errorText(error, texts.error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <SubInspector ariaLabel={texts.editChannel(channel.displayName)} title={texts.editChannel(channel.displayName)} identifier={channel.channelId} closeLabel={dashboardCommonTexts().close} onClose={onClose}>
      <StateRow
        label={texts.identity}
        tone={connectionTone(channel)}
        word={connectionWord(channel)}
        detail={!channel.broadcasterConnected && channel.fullConsent ? texts.consentPendingHint : channel.login}
      />
      <section className="config-section" aria-label={texts.toggleConsent}>
        <div className="section-heading"><h3>{texts.toggleConsent}</h3></div>
        <div className="form-actions">
          <button className="switch" type="button" role="switch" aria-checked={channel.fullConsent} aria-label={texts.fullConsent} aria-busy={consentInProgress} disabled={consentInProgress} onClick={() => { void toggleConsent(); }}>
            <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
          </button>
          <span className="muted">{channel.fullConsent ? texts.yes : texts.no}</span>
        </div>
      </section>
      <InvitationLink channel={channel} />
      <section className="config-section" aria-label={texts.members}>
        <div className="section-heading"><h3>{texts.members}</h3></div>
        {members.status === "loading" && members.data === null ? <p className="loading-line">{texts.loadMembers}</p> : null}
        {members.error === null ? null : <p className="form-error" role="alert">{members.error}</p>}
        {members.data === null ? null : (
          <MembersTable
            members={members.data.members}
            pendingRemoval={pendingRemoval}
            confirmButton={confirmationButton}
            onRoleChange={(member, role) => { void changeRole(member, role); }}
            onRemove={(member) => { setPendingRemoval(member.userId); }}
            onConfirmRemoval={(member) => { void removeMember(member); }}
            onCancelRemoval={() => { setPendingRemoval(null); }}
          />
        )}
      </section>
      <section className="config-section" aria-label={texts.addMember}>
        <div className="section-heading"><h3>{texts.addMember}</h3></div>
        <form className="inspector-form" onSubmit={(event) => { void searchUser(event); }}>
          <label className="config-field config-field--mittel" htmlFor={"betreiber-mitglied-suche-" + channel.channelId}>{texts.twitchLogin}
            <input id={"betreiber-mitglied-suche-" + channel.channelId} value={searchLogin} onChange={(event) => { setSearchLogin(event.target.value); }} autoComplete="off" />
          </label>
          <div className="form-actions">
            <button className="button" type="submit" disabled={searchInProgress || searchLogin.trim().length === 0}>{searchInProgress ? texts.searching : texts.search}</button>
          </div>
        </form>
        {searchError === null ? null : <p className="form-error" role="alert">{searchError}</p>}
        {foundMember === null ? null : (
          <div className="inspector-result">
            <div>
              <strong>{userName(foundMember)}</strong>
              <span>@{foundMember.login} · {texts.twitchId(foundMember.userId)}</span>
            </div>
            <label className="config-field config-field--mittel">{texts.role}
              <select aria-label={texts.newRole} value={newRole} onChange={(event) => { setNewRole(event.target.value as "manager" | "operator"); }}>
                {roleOptions()}
              </select>
            </label>
            <button className="button button--primary" type="button" disabled={busyUserId === foundMember.userId} onClick={() => { void addMember(); }}>{texts.add}</button>
          </div>
        )}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
      </section>
    </SubInspector>
  );
};

const ChannelRelease = ({
  onReloadOverview: onReload,
  onAuthenticationRequired: onAuthenticationRequired,
  onClose,
}: {
  onReloadOverview: () => Promise<void>;
  onAuthenticationRequired: () => void;
  onClose: () => void;
}): ReactElement => {
  const texts = platformTexts();
  const [login, setLogin] = useState("");
  const [searchInProgress, setSearchInProgress] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [found, setFound] = useState<PanelTwitchUser | null>(null);
  const [fullConsent, setFullConsent] = useState(true);
  const [confirmation, setConfirmation] = useState(false);
  const [releaseInProgress, setReleaseInProgress] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const confirmationButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (confirmation) confirmationButton.current?.focus();
  }, [confirmation]);

  const searchUser = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSearchInProgress(true);
    setSearchError(null);
    setFound(null);
    setConfirmation(false);
    try {
      setFound((await searchPlatformUser(login)).user);
    } catch (error: unknown) {
      setSearchError(errorText(error, texts.error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setSearchInProgress(false);
    }
  };

  const releaseChannel = async (): Promise<void> => {
    if (found === null) return;
    setReleaseInProgress(true);
    setActionError(null);
    try {
      await releasePlatformChannel(found.login, fullConsent);
      setFound(null);
      setLogin("");
      setConfirmation(false);
      await onReload();
    } catch (error: unknown) {
      setActionError(errorText(error, texts.error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setReleaseInProgress(false);
    }
  };

  return (
    <SubInspector ariaLabel={texts.releaseChannel} title={texts.releaseChannel} closeLabel={dashboardCommonTexts().close} onClose={onClose}>
      <form className="inspector-form" onSubmit={(event) => { void searchUser(event); }}>
        <label className="config-field config-field--mittel" htmlFor="betreiber-kanal-login">{texts.twitchLogin}
          <input id="betreiber-kanal-login" value={login} onChange={(event) => { setLogin(event.target.value); }} autoComplete="off" />
        </label>
        <div className="form-actions">
          <button className="button" type="submit" disabled={searchInProgress || login.trim().length === 0}>{searchInProgress ? texts.searching : texts.search}</button>
        </div>
      </form>
      {searchError === null ? null : <p className="form-error" role="alert">{searchError}</p>}
      {found === null ? null : (
        <div className="inspector-result">
          <div>
            <strong>{texts.userFound}: {found.displayName}</strong>
            <span>@{found.login} · {texts.twitchId(found.userId)}</span>
          </div>
          <label className="config-field config-field--mittel">
            <span>{texts.setFullConsent}</span>
            <input type="checkbox" checked={fullConsent} onChange={(event) => { setFullConsent(event.target.checked); }} />
          </label>
          <button className="button" type="button" onClick={() => { setActionError(null); setConfirmation(true); }}>{texts.releaseChannel}</button>
        </div>
      )}
      {confirmation && found !== null ? (
        <div className="inspector-confirmation" role="alertdialog" aria-label={texts.releaseChannelQuestion(found.displayName)}>
          <h3>{texts.releaseChannelQuestion(found.displayName)}</h3>
          <p>{texts.releaseChannelDescription(found.displayName, found.userId, fullConsent ? texts.yes : texts.no)}</p>
          <div className="form-actions">
            <button ref={confirmationButton} className="button button--primary" type="button" disabled={releaseInProgress} onClick={() => { void releaseChannel(); }}>{texts.confirmRelease}</button>
            <button className="button button--quiet" type="button" disabled={releaseInProgress} onClick={() => { setConfirmation(false); }}>{dashboardCommonTexts().cancel}</button>
          </div>
        </div>
      ) : null}
      {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
    </SubInspector>
  );
};

const InvitationLink = ({ channel: channel }: { channel: PanelPlatformChannelOverview }): ReactElement => {
  const texts = platformTexts();
  const [status, setStatus] = useState<string | null>(null);
  const link = window.location.origin + "/auth/login?channel=" + encodeURIComponent(channel.login);

  const copyLinkToClipboard = async (): Promise<void> => {
    const clipboard = Reflect.get(navigator, "clipboard") as { writeText: (text: string) => Promise<void> } | undefined;
    if (clipboard === undefined) return;
    await clipboard.writeText(link);
    setStatus(texts.linkCopied);
  };

  return (
    <section className="config-section" aria-label={texts.invitationLink}>
      <div className="section-heading"><h2>{texts.invitationLink}</h2></div>
      <p className="muted">{texts.invitationLinkHint}</p>
      <label className="config-field config-field--breit" htmlFor="betreiber-einladungslink">{texts.invitationLink}
        <input id="betreiber-einladungslink" readOnly value={link} />
      </label>
      <div className="form-actions">
        <button className="button" type="button" onClick={() => { void copyLinkToClipboard(); }}>{texts.copyLink}</button>
        {status === null ? null : <span className="muted">{status}</span>}
      </div>
      {!channel.broadcasterConnected && channel.fullConsent ? <StateRow label={texts.identity} tone="warning" word={texts.consentPending} detail={texts.consentPendingHint} /> : null}
    </section>
  );
};

const PlatformAudit = ({
  auditState: auditState,
  channels: channels,
  onLoadMore: onLoadMore,
  loadingMore: loadingMore,
}: {
  auditState: LoadState<PanelPlatformAuditResponse>;
  channels: PanelPlatformChannelOverview[];
  onLoadMore: () => void;
  loadingMore: boolean;
}): ReactElement => {
  const texts = platformTexts();
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.channelId, channel.login])), [channels]);
  const actorName = (entry: PanelPlatformAuditEntry): string =>
    entry.actorDisplayName ?? (entry.actorLogin == null ? entry.actorUserId : `@${entry.actorLogin}`);
  const actor = (entry: PanelPlatformAuditEntry): string =>
    (entry.actorKind === "platform_admin" ? texts.platformAdmin : texts.member) + " · " + actorName(entry);
  return (
    <section className="config-section" aria-label={texts.audit}>
      <div className="section-heading"><h2>{texts.audit}</h2></div>
      {auditState.status === "loading" && auditState.data === null ? <p className="loading-line">{texts.loadAudit}</p> : null}
      {auditState.error === null ? null : <p className="form-error" role="alert">{auditState.error}</p>}
      {auditState.data?.entries.length === 0 ? <p className="muted">{texts.auditEmpty}</p> : null}
      {auditState.data === null ? null : auditState.data.entries.length === 0 ? null : (
        <div className="tabelle-wrap">
          <table className="tabelle">
            <thead><tr><th scope="col">{texts.login}</th><th scope="col">{texts.action}</th><th scope="col">{texts.actor}</th><th scope="col">{texts.timestamp}</th></tr></thead>
            <tbody>{auditState.data.entries.map((entry) => <tr key={entry.auditId}><th scope="row">{channelNames.get(entry.channelId) ?? <span className="mono">{entry.channelId}</span>}</th><td>{platformActionLabel(entry.action)}</td><td className="mono">{actor(entry)}</td><td className="mono" title={entry.createdAt}>{formatTimestamp(entry.createdAt)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {auditState.data?.nextCursor === null || auditState.data?.nextCursor === undefined ? null : <button className="button button--secondary" type="button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? texts.loadingMore : texts.loadMore}</button>}
    </section>
  );
};

export const PlatformPage = ({ onAuthenticationRequired: onAuthenticationRequired }: PlatformPageProperties): ReactElement => {
  const texts = platformTexts();
  const [overview, setOverview] = useState<LoadState<PanelPlatformChannelOverview[]>>(() => emptyLoadState());
  const [audit, setAudit] = useState<LoadState<PanelPlatformAuditResponse>>(() => emptyLoadState());
  const { selectedKey: selectedChannelId, select: selectChannel, rowRef: channelRowRef, close: closeChannel } = useInspectorSelection<string>();
  const [channelReleaseOpen, setChannelReleaseOpen] = useState(false);
  const channelReleaseButton = useRef<HTMLButtonElement | null>(null);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);

  const openChannelRelease = (): void => {
    closeChannel();
    setChannelReleaseOpen(true);
    channelReleaseButton.current?.focus();
  };

  const closeChannelRelease = (): void => {
    setChannelReleaseOpen(false);
    channelReleaseButton.current?.focus();
  };

  const loadOverview = async (): Promise<void> => {
    setOverview((current) => current.data === null ? loadState() : { ...current, status: "loading", error: null });
    try {
      const response = await getPlatformOverview();
      setOverview(loadedState(response.channels));
      if (selectedChannelId !== null && !response.channels.some((channel) => channel.channelId === selectedChannelId)) closeChannel();
    } catch (error: unknown) {
      setOverview({ status: "error", data: null, error: errorText(error, texts.error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    }
  };

  useEffect(() => {
    let aborted = false;
    const load = async (): Promise<void> => {
      setOverview(loadState());
      setAudit(loadState());
      try {
        const [channelResponse, auditResponse] = await Promise.all([getPlatformOverview(), getPlatformAudit()]);
        if (aborted) return;
        setOverview(loadedState(channelResponse.channels));
        closeChannel();
        setAudit(loadedState(auditResponse));
      } catch (error: unknown) {
        if (aborted) return;
        const message = errorText(error, texts.error);
        setOverview({ status: "error", data: null, error: message });
        setAudit({ status: "error", data: null, error: message });
        if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
      }
    };
    void load();
    return () => { aborted = true; };
  }, [onAuthenticationRequired, closeChannel, texts.error]);

  const selectedChannel = overview.data?.find((channel) => channel.channelId === selectedChannelId) ?? null;

  const loadMoreAudit = async (): Promise<void> => {
    if (auditLoadingMore || audit.data?.nextCursor === null || audit.data?.nextCursor === undefined) return;
    setAuditLoadingMore(true);
    try {
      const nextPage = await getPlatformAudit(audit.data.nextCursor);
      setAudit((current) => current.data === null ? current : loadedState({ entries: current.data.entries.concat(nextPage.entries), nextCursor: nextPage.nextCursor }));
    } catch (error: unknown) {
      setAudit((current) => ({ ...current, status: "error", error: errorText(error, texts.error) }));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setAuditLoadingMore(false);
    }
  };

  return (
    <section className="module-stack" aria-label={texts.title}>
      <header className="module-detail-heading">
        <div className="module-detail-heading__icon" aria-hidden="true"><NavigationIcon kind="members" className="module-heading-glyph" /></div>
        <div className="module-detail-heading__copy"><h1>{texts.title}</h1><p>{texts.subtitle(formatNumber(overview.data?.length ?? 0))}</p></div>
      </header>
      <section className={`config-section inspektor-bereich${selectedChannel === null && !channelReleaseOpen ? "" : " inspektor-bereich--offen"}`} aria-label={texts.channelOverview}>
        <div className="inspektor-bereich__liste">
          <InspectorHeading level="h2" title={texts.channelOverview} buttonRef={channelReleaseButton} action={{ kind: "add", label: texts.releaseChannel, onClick: openChannelRelease }} />
          {overview.status === "loading" && overview.data === null ? <p className="loading-line">{texts.load}</p> : null}
          {overview.error === null ? null : <p className="form-error" role="alert">{overview.error}</p>}
          {overview.data?.length === 0 ? <p className="muted">{texts.noChannels}</p> : null}
          {overview.data === null ? null : overview.data.length === 0 ? null : (
            <div className="tabelle-wrap">
              <table className="tabelle tabelle--inhalt">
                <thead><tr><th scope="col">{texts.login}</th><th scope="col">{texts.identifier}</th><th scope="col">{texts.fullConsent}</th><th scope="col">{texts.broadcaster}</th><th scope="col">{texts.manager}</th><th scope="col">{texts.operator}</th><th scope="col">{texts.identity}</th></tr></thead>
                <tbody>{overview.data.map((channel) => <tr key={channel.channelId} ref={channelRowRef(channel.channelId)} tabIndex={0} aria-selected={channel.channelId === selectedChannelId} onClick={() => { setChannelReleaseOpen(false); selectChannel(channel.channelId); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setChannelReleaseOpen(false); selectChannel(channel.channelId); } }}><th scope="row">{channel.login}</th><td className="mono">{channel.channelId}</td><td>{channel.fullConsent ? texts.yes : texts.no}</td><td className="zahl">{formatNumber(channel.memberCounts.broadcaster)}</td><td className="zahl">{formatNumber(channel.memberCounts.manager)}</td><td className="zahl">{formatNumber(channel.memberCounts.operator)}</td><td><span className="led" data-status={connectionTone(channel) === "healthy" ? "green" : connectionTone(channel) === "warning" ? "amber" : "off"}><span className="led__dot" aria-hidden="true" /><span>{connectionWord(channel)}</span></span></td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
        {selectedChannel === null
          ? channelReleaseOpen ? <ChannelRelease onReloadOverview={loadOverview} onAuthenticationRequired={onAuthenticationRequired} onClose={closeChannelRelease} /> : null
          : <ChannelInspector key={selectedChannel.channelId} channel={selectedChannel} onAuthenticationRequired={onAuthenticationRequired} onReloadOverview={loadOverview} onClose={closeChannel} />}
      </section>
      <PlatformAudit auditState={audit} channels={overview.data ?? []} onLoadMore={() => { void loadMoreAudit(); }} loadingMore={auditLoadingMore} />
    </section>
  );
};
