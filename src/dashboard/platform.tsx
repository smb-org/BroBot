import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

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
import { apiErrorText, dashboardCommonTexts, formatTimestamp, formatNumber } from "./locale";
import { Button, ConfirmDialog, EditorShell, Field, InspectorHeading, ListDetail, Select, SubInspector, Switch, useInspectorSelection, type SelectOption } from "./ui";
import { MemberGrantEditor } from "./member-grant-editor";
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
  error instanceof PanelApiError ? apiErrorText(error.code, fallback) : fallback;

const isAbort = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const memberName = (member: PanelMember): string =>
  member.displayName ?? (member.login === null ? platformTexts().member : "@" + member.login);

const roleSelectOptions = (): SelectOption[] => CHANNEL_ROLES.filter((role) => role !== "broadcaster").map((role) => ({
  value: role,
  label: roleLabel(role),
}));

const connectionTone = (channel: PanelPlatformChannelOverview): StateTone =>
  channel.broadcasterConnected ? "healthy" : channel.fullConsent ? "warning" : "neutral";

const connectionWord = (channel: PanelPlatformChannelOverview, compact = false): string => {
  const texts = platformTexts();
  if (channel.broadcasterConnected) return texts.connected;
  if (!channel.fullConsent) return texts.no;
  return compact ? texts.consentPendingShort : texts.consentPending;
};

const MembersTable = ({
  members: members,
  busyUserId,
  onRoleChange: onRoleChange,
  onRemove: onRemove,
}: {
  members: PanelMember[];
  busyUserId: string | null;
  onRoleChange: (member: PanelMember, role: "manager" | "operator") => void;
  onRemove: (member: PanelMember) => void;
}): ReactElement => {
  const texts = platformTexts();
  if (members.length === 0) return <p className="muted">{texts.noMembers}</p>;
  return (
    <div className="table-wrap">
      <table className="table platform-members-table">
        <thead>
          <tr>
            <th scope="col">{texts.login}</th>
            <th scope="col">{texts.role}</th>
            <th scope="col" className="table__action">{texts.remove}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <th scope="row">
                <span>{memberName(member)}</span>
                <span className="login-hint" title={texts.twitchId(member.userId)}>{member.login === null ? texts.member : "@" + member.login}</span>
              </th>
              <td>
                {member.role === "broadcaster" ? <span>{roleLabel(member.role)}</span> : (
                  <Select
                    ariaLabel={texts.role + ": " + memberName(member)}
                    value={member.role}
                    disabled={busyUserId === member.userId}
                    onChange={(role) => { if (role !== null) onRoleChange(member, role as "manager" | "operator"); }}
                    options={roleSelectOptions()}
                  />
                )}
              </td>
              <td className="table__action">
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
                  <button className="button button--danger" type="button" disabled={busyUserId === member.userId} onClick={() => { onRemove(member); }}>
                    {texts.remove}
                  </button>
                )}
              </td>
            </tr>
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
  const common = dashboardCommonTexts();
  const [members, setMembers] = useState<LoadState<PanelPlatformMembersResponse>>(() => emptyLoadState());
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PanelMember | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [consentInProgress, setConsentInProgress] = useState(false);

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
    <SubInspector ariaLabel={texts.editChannel(channel.displayName)} title={texts.editChannel(channel.displayName)} identifier={channel.channelId} closeLabel={common.close} onClose={onClose}>
      <StateRow
        label={texts.identity}
        tone={connectionTone(channel)}
        word={connectionWord(channel)}
        detail={!channel.broadcasterConnected && channel.fullConsent ? texts.consentPendingHint : channel.login}
      />
      <section className="config-section platform-inspector-section" aria-label={texts.toggleConsent}>
        <Switch
          layout="inline"
          label={texts.fullConsent}
          hint={common.immediate}
          checked={channel.fullConsent}
          pending={consentInProgress}
          onChange={() => { void toggleConsent(); }}
        />
      </section>
      <InvitationLink channel={channel} />
      <section className="config-section platform-inspector-section" aria-label={texts.members}>
        <div className="section-heading"><h3>{texts.members}</h3></div>
        {members.status === "loading" && members.data === null ? <p className="loading-line">{texts.loadMembers}</p> : null}
        {members.error === null ? null : <p className="form-error" role="alert">{members.error}</p>}
        {members.data === null ? null : (
          <MembersTable
            members={members.data.members}
            busyUserId={busyUserId}
            onRoleChange={(member, role) => { void changeRole(member, role); }}
            onRemove={(member) => { setPendingRemoval(member); }}
          />
        )}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
      </section>
      <section className="config-section platform-inspector-section" aria-label={texts.addMember}>
        <div className="section-heading"><h3>{texts.addMember}</h3></div>
        <MemberGrantEditor
          roles={["manager", "operator"]}
          defaultRole="operator"
          texts={{
            ariaLabel: texts.addMember,
            title: texts.addMember,
            searchLabel: texts.twitchLogin,
            searchHint: texts.twitchLoginHint,
            searchButton: texts.search,
            searchingButton: texts.searching,
            roleLabel: texts.role,
            roleHint: texts.roleHint,
            saveLabel: texts.add,
            confirmTitle: texts.addMemberConfirmTitle,
            confirmDescription: texts.addMemberConfirmDescription,
            confirmButton: texts.addMemberConfirmButton,
          }}
          onSearch={(login) => searchPlatformUser(login).then((response) => response.user)}
          onGrant={(userId, role) => addPlatformMember(channel.channelId, userId, role as "manager" | "operator").then(() => undefined)}
          errorText={(error) => errorText(error, texts.error)}
          onGranted={() => { void loadMembers(); }}
          onAuthenticationRequired={onAuthenticationRequired}
        />
      </section>
      <ConfirmDialog
        opened={pendingRemoval !== null}
        title={texts.removeConfirmTitle(pendingRemoval === null ? "" : memberName(pendingRemoval))}
        description={texts.removeQuestion(pendingRemoval === null ? "" : memberName(pendingRemoval))}
        confirmLabel={texts.confirmRemove}
        cancelLabel={common.cancel}
        danger
        onCancel={() => { setPendingRemoval(null); }}
        onConfirm={() => { if (pendingRemoval !== null) void removeMember(pendingRemoval); }}
      />
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
  const common = dashboardCommonTexts();
  const [login, setLogin] = useState("");
  const [searchInProgress, setSearchInProgress] = useState(false);
  const [searchError, setSearchError] = useState<string | undefined>(undefined);
  const [found, setFound] = useState<PanelTwitchUser | null>(null);
  const [fullConsent, setFullConsent] = useState(true);
  const [confirmation, setConfirmation] = useState(false);
  const [releaseInProgress, setReleaseInProgress] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);

  const searchUser = async (): Promise<void> => {
    const trimmed = login.trim();
    if (searchInProgress || trimmed.length === 0) return;
    setSearchInProgress(true);
    setSearchError(undefined);
    setFound(null);
    try {
      setFound((await searchPlatformUser(trimmed)).user);
      setFullConsent(true);
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
    setActionError(undefined);
    try {
      await releasePlatformChannel(found.login, fullConsent);
      setConfirmation(false);
      setFound(null);
      setLogin("");
      await onReload();
    } catch (error: unknown) {
      setConfirmation(false);
      setActionError(errorText(error, texts.error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setReleaseInProgress(false);
    }
  };

  return (
    <>
      <EditorShell
        ariaLabel={texts.releaseChannel}
        title={texts.releaseChannel}
        sections={[{
          id: "release",
          label: texts.releaseChannel,
          content: (
            <>
              <div className="form-row">
                <Field label={texts.twitchLogin} hint={texts.twitchLoginHint} prefix="@" value={login} onChange={setLogin} {...(searchError === undefined ? {} : { error: searchError })} disabled={searchInProgress} onKeyDown={(event) => { if (event.key !== "Enter") return; event.preventDefault(); void searchUser(); }} />
                <Button variant="neutral" disabled={searchInProgress || login.trim().length === 0} onClick={() => { void searchUser(); }}>{searchInProgress ? texts.searching : texts.search}</Button>
              </div>
              {found === null ? null : (
                <div className="member-grant-editor__result">
                  <div><strong>{texts.userFound}: {found.displayName}</strong><span>@{found.login} · {texts.twitchId(found.userId)}</span></div>
                  <Switch layout="card" label={texts.fullConsent} description={texts.fullConsentCardDescription} checked={fullConsent} onChange={setFullConsent} />
                </div>
              )}
            </>
          ),
        }]}
        dirty={found !== null}
        pending={releaseInProgress}
        {...(actionError === undefined ? {} : { error: actionError })}
        onSave={() => { if (found !== null) setConfirmation(true); }}
        onDiscard={() => { setFound(null); setSearchError(undefined); }}
        saveLabel={texts.releaseChannel}
        discardLabel={common.discard}
        savedLabel={common.saved}
        pendingLabel={common.saving}
        issueLabels={{ error: common.error, warning: common.warning }}
        onClose={onClose}
        closeLabel={common.close}
      />
      {found === null ? null : (
        <ConfirmDialog
          opened={confirmation}
          title={texts.releaseChannelQuestion(found.displayName)}
          description={texts.releaseChannelDescription(found.displayName, found.userId, fullConsent ? texts.yes : texts.no)}
          confirmLabel={texts.confirmRelease}
          cancelLabel={common.cancel}
          onCancel={() => { setConfirmation(false); }}
          onConfirm={() => { void releaseChannel(); }}
        />
      )}
    </>
  );
};

const InvitationLink = ({ channel: channel }: { channel: PanelPlatformChannelOverview }): ReactElement => {
  const texts = platformTexts();
  const [copied, setCopied] = useState(false);
  const link = window.location.origin + "/auth/login?channel=" + encodeURIComponent(channel.login);

  const copyLinkToClipboard = async (): Promise<void> => {
    setCopied(false);
    const clipboard = Reflect.get(navigator, "clipboard") as { writeText: (text: string) => Promise<void> } | undefined;
    if (clipboard === undefined) return;
    await clipboard.writeText(link);
    setCopied(true);
  };

  return (
    <section className="config-section platform-inspector-section" aria-label={texts.invitationLink}>
      <div className="section-heading"><h2>{texts.invitationLink}</h2></div>
      <div className="form-row">
        <Field label={texts.invitationLink} hint={texts.invitationLinkHint} value={link} onChange={() => {}} readOnly mono />
        <Button variant="neutral" icon={copied ? "copied" : "copy"} onClick={() => { void copyLinkToClipboard(); }}>{copied ? texts.linkCopied : texts.copyLink}</Button>
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
        <div className="table-wrap">
          <table className="table">
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

  const closeFloating = useCallback((): void => {
    if (selectedChannelId !== null) { closeChannel(); return; }
    if (channelReleaseOpen) closeChannelRelease();
  }, [selectedChannelId, closeChannel, channelReleaseOpen]);

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
  const inspectorOpen = selectedChannelId !== null || channelReleaseOpen;

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
      <section className="config-section" aria-label={texts.channelOverview}>
        <ListDetail
          list={
            <div>
              <InspectorHeading level="h2" title={texts.channelOverview} buttonRef={channelReleaseButton} action={{ kind: "add", label: texts.releaseChannel, onClick: openChannelRelease }} />
              {overview.status === "loading" && overview.data === null ? <p className="loading-line">{texts.load}</p> : null}
              {overview.error === null ? null : <p className="form-error" role="alert">{overview.error}</p>}
              {overview.data?.length === 0 ? <p className="muted">{texts.noChannels}</p> : null}
              {overview.data === null ? null : overview.data.length === 0 ? null : (
                <div className="table-wrap">
                  <table className={`table table--content platform-channel-table${inspectorOpen ? " platform-channel-table--inspector-open" : ""}`}>
                    <thead><tr><th scope="col">{texts.login}</th>{inspectorOpen ? null : <th scope="col">{texts.identifier}</th>}<th scope="col" title={texts.fullConsent}>{texts.fullConsentColumn}</th><th scope="col" title={`${texts.broadcaster} · ${texts.manager} · ${texts.operator}`}>{texts.members}</th><th scope="col">{inspectorOpen ? texts.identityShort : texts.identity}</th></tr></thead>
                    <tbody>{overview.data.map((channel) => {
                      const roleCountsTitle = `${texts.broadcaster} · ${texts.manager} · ${texts.operator}`;
                      return <tr key={channel.channelId} ref={channelRowRef(channel.channelId)} tabIndex={0} aria-selected={channel.channelId === selectedChannelId} onClick={() => { setChannelReleaseOpen(false); selectChannel(channel.channelId); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setChannelReleaseOpen(false); selectChannel(channel.channelId); } }}>
                        <th scope="row" title={inspectorOpen ? channel.channelId : channel.login}>{channel.login}</th>
                        {inspectorOpen ? null : <td className="mono" title={channel.channelId}>{channel.channelId}</td>}
                        <td>{channel.fullConsent ? texts.yes : texts.no}</td>
                        <td className="number" title={roleCountsTitle}>{[channel.memberCounts.broadcaster, channel.memberCounts.manager, channel.memberCounts.operator].map(formatNumber).join(" · ")}</td>
                        <td><span className="led" data-status={connectionTone(channel) === "healthy" ? "green" : connectionTone(channel) === "warning" ? "amber" : "off"}><span className="led__dot" aria-hidden="true" /><span>{connectionWord(channel, inspectorOpen)}</span></span></td>
                      </tr>;
                    })}</tbody>
                  </table>
                </div>
              )}
            </div>
          }
          inspector={selectedChannel === null
            ? channelReleaseOpen ? <ChannelRelease onReloadOverview={loadOverview} onAuthenticationRequired={onAuthenticationRequired} onClose={closeChannelRelease} /> : null
            : <ChannelInspector key={selectedChannel.channelId} channel={selectedChannel} onAuthenticationRequired={onAuthenticationRequired} onReloadOverview={loadOverview} onClose={closeChannel} />}
          onCloseInspector={closeFloating}
        />
      </section>
      <PlatformAudit auditState={audit} channels={overview.data ?? []} onLoadMore={() => { void loadMoreAudit(); }} loadingMore={auditLoadingMore} />
    </section>
  );
};
