import "./platform.css";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type {
  PanelPlatformAuditEntry,
  PanelPlatformAuditResponse,
  PanelPlatformChannelOverview,
  PanelPlatformMembersResponse,
  PanelSpotifyAccessResponse,
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
  getPlatformSpotifyAccess,
  PanelApiError,
  fetchPlatformTwitchUserSuggestions,
  setPlatformFullConsent,
  setPlatformSpotifyChannel,
} from "./api";
import { platformTexts, roleLabel } from "./labels";
import { apiErrorText, auditSentenceForAction, dashboardCommonTexts, formatTimestamp, formatNumber } from "./locale";
import { AuditSentence, Badge, Button, ConfirmDialog, Field, FormDialog, InspectorActions, InspectorFieldRow, InspectorHeading, InspectorSection, ListDetail, ListPaginationFooter, LoadState as LoadStateView, LoadStateLines, notify, PageHeader, Select, SubInspector, SwitchRow, Tabs, TwitchUserField, useInspectorSelection, type SelectOption, type TwitchUserFieldHandle } from "./ui";
import { MemberGrantEditor } from "./member-grant-editor";
import { StateRow, type StateTone } from "./module-panels";

const loadPlatformUser = (query: string, signal: AbortSignal) => fetchPlatformTwitchUserSuggestions(query, signal);

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
  selectedUserId,
  onSelect: onSelect,
}: {
  members: PanelMember[];
  selectedUserId: string | null;
  onSelect: (member: PanelMember) => void;
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
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId} tabIndex={0} aria-selected={selectedUserId === member.userId} onClick={() => { onSelect(member); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(member); } }}>
              <th scope="row">
                <span>{memberName(member)}</span>
                <span className="login-hint" title={texts.twitchId(member.userId)}>{member.login === null ? texts.member : "@" + member.login}</span>
              </th>
              <td><Badge tone={member.role === "broadcaster" ? "brand" : "neutral"}>{roleLabel(member.role)}</Badge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const PlatformMembersLoading = (): ReactElement => {
  const texts = platformTexts();
  return (
    <><LoadStateLines rows={4} height={44} /><span className="sr-only">{texts.loadMembers}</span></>
  );
};

const ChannelInspector = ({
  channel: channel,
  onAuthenticationRequired: onAuthenticationRequired,
  onReloadOverview: onReload,
  spotifyAccess: spotifyAccess,
  onReloadSpotifyAccess: onReloadSpotifyAccess,
  onClose,
}: {
  channel: PanelPlatformChannelOverview;
  onAuthenticationRequired: () => void;
  onReloadOverview: () => Promise<void>;
  spotifyAccess: PanelSpotifyAccessResponse | null;
  onReloadSpotifyAccess: () => Promise<void>;
  onClose: () => void;
}): ReactElement => {
  const texts = platformTexts();
  const common = dashboardCommonTexts();
  const [members, setMembers] = useState<LoadState<PanelPlatformMembersResponse>>(() => emptyLoadState());
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PanelMember | null>(null);
  const [consentInProgress, setConsentInProgress] = useState(false);
  const [spotifyBusy, setSpotifyBusy] = useState(false);
  const notifiedMembersError = useRef<string | null>(null);

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
    if (members.error === null) {
      notifiedMembersError.current = null;
      return;
    }
    if (notifiedMembersError.current === members.error) return;
    notifiedMembersError.current = members.error;
    notify({ tone: "error", message: members.error });
  }, [members.error]);

  const toggleConsent = async (): Promise<void> => {
    setConsentInProgress(true);
    try {
      await setPlatformFullConsent(channel.channelId, !channel.fullConsent);
      await onReload();
    } catch (error: unknown) {
      notify({ tone: "error", message: errorText(error, texts.error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setConsentInProgress(false);
    }
  };

  const spotifyChannel = spotifyAccess?.channels.find((entry) => entry.channelId === channel.channelId);
  const toggleSpotify = async (): Promise<void> => {
    if (spotifyAccess === null) return;
    setSpotifyBusy(true);
    try {
      await setPlatformSpotifyChannel(channel.channelId, spotifyChannel === undefined);
      await onReloadSpotifyAccess();
    } catch (error: unknown) {
      notify({ tone: "error", message: error instanceof PanelApiError && error.code === "spotify_access_limit" ? texts.spotifyLimit : errorText(error, texts.error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally { setSpotifyBusy(false); }
  };

  const changeRole = async (member: PanelMember, role: "manager" | "operator"): Promise<void> => {
    setBusyUserId(member.userId);
    try {
      await changePlatformMember(channel.channelId, member.userId, role);
      await loadMembers();
    } catch (error: unknown) {
      notify({ tone: "error", message: errorText(error, texts.error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  const selectedMember = members.data?.members.find((member) => member.userId === selectedMemberId) ?? null;

  const removeMember = async (member: PanelMember): Promise<void> => {
    setBusyUserId(member.userId);
    try {
      await removePlatformMember(channel.channelId, member.userId);
      setPendingRemoval(null);
      await loadMembers();
    } catch (error: unknown) {
      notify({ tone: "error", message: errorText(error, texts.error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <SubInspector ariaLabel={texts.editChannel(channel.displayName)} title={texts.editChannel(channel.displayName)} identifier={channel.channelId} closeLabel={common.close} onClose={onClose}>
      <div className="platform-inspector-grid">
        <InspectorSection title={texts.identityAndConsent}>
          <StateRow
            label={texts.identity}
            tone={connectionTone(channel)}
            word={connectionWord(channel)}
            detail={!channel.broadcasterConnected && channel.fullConsent ? texts.consentPendingHint : channel.login}
          />
          <SwitchRow
            label={texts.fullConsent}
            hint={common.immediate}
            checked={channel.fullConsent}
            pending={consentInProgress}
            onChange={() => { void toggleConsent(); }}
          />
          <InvitationLink channel={channel} />
        </InspectorSection>
        <InspectorSection title={texts.spotifyAccess}>
          <p className="muted platform-spotify-channel-state">
            {spotifyChannel === undefined
              ? spotifyAccess === null ? "…" : texts.spotifyNotEnabled
              : texts.spotifySlotEnabled(String(spotifyChannel.slot))}
          </p>
          <Button type="button" variant="secondary" disabled={spotifyBusy || spotifyAccess === null || spotifyChannel === undefined && spotifyAccess.usedSlots >= spotifyAccess.limit} onClick={() => { void toggleSpotify(); }}>
            {spotifyChannel === undefined ? texts.spotifyEnabled : texts.spotifyDisabled}
          </Button>
        </InspectorSection>
        <InspectorSection title={texts.members}>
          <MemberGrantEditor
            channelId={channel.channelId}
            roles={["manager", "operator"]}
            defaultRole="operator"
            texts={{
              ariaLabel: texts.addMember,
              title: texts.addMember,
              searchLabel: texts.twitchLogin,
              searchHint: texts.twitchLoginHint,
              roleLabel: texts.role,
              roleHint: texts.roleHint,
              saveLabel: texts.add,
              confirmTitle: texts.addMemberConfirmTitle,
              confirmDescription: texts.addMemberConfirmDescription,
              confirmButton: texts.addMemberConfirmButton,
            }}
            loadSuggestions={loadPlatformUser}
            onGrant={(userId, role) => addPlatformMember(channel.channelId, userId, role as "manager" | "operator").then(() => undefined)}
            errorText={(error) => errorText(error, texts.error)}
            onGranted={() => { void loadMembers(); }}
            onAuthenticationRequired={onAuthenticationRequired}
          />
          {selectedMember === null ? null : <div className="platform-selected-member">
            <strong>{memberName(selectedMember)}</strong>
            {selectedMember.role === "broadcaster" ? <p className="muted" id={`platform-remove-broadcaster-reason-${selectedMember.userId}`}>{texts.removeBroadcasterHint}</p> : <InspectorFieldRow label={texts.role}>
              <Select ariaLabel={texts.role + ": " + memberName(selectedMember)} value={selectedMember.role}
                disabled={busyUserId === selectedMember.userId}
                onChange={(role) => { if (role !== null) void changeRole(selectedMember, role as "manager" | "operator"); }}
                options={roleSelectOptions()} />
            </InspectorFieldRow>}
            <InspectorActions destructive={
              <Button danger="subtle" disabled={selectedMember.role === "broadcaster" || busyUserId === selectedMember.userId}
                {...(selectedMember.role === "broadcaster" ? { title: texts.removeBroadcasterHint } : {})}
                {...(selectedMember.role === "broadcaster" ? { describedBy: `platform-remove-broadcaster-reason-${selectedMember.userId}` } : {})}
                onClick={() => { setPendingRemoval(selectedMember); }}>{texts.remove}</Button>
            } />
          </div>}
          <div className="platform-members-list">
            <LoadStateView
              variant="panel-220"
              status={members.data === null ? members.status === "error" ? "error" : "loading" : members.data.members.length === 0 ? "empty" : "success"}
              loading={<PlatformMembersLoading />}
              empty={<MembersTable members={[]} selectedUserId={selectedMemberId} onSelect={(member) => { setSelectedMemberId(member.userId); }} />}
              error={<PlatformMembersLoading />}
            >{members.data === null || members.data.members.length === 0 ? null : <MembersTable
                members={members.data.members}
                selectedUserId={selectedMemberId}
                onSelect={(member) => { setSelectedMemberId(member.userId); }}
              />}</LoadStateView>
          </div>
        </InspectorSection>
      </div>
      <ConfirmDialog
        opened={pendingRemoval !== null}
        title={texts.removeConfirmTitle(pendingRemoval === null ? "" : memberName(pendingRemoval))}
        description={texts.removeQuestion(pendingRemoval === null ? "" : memberName(pendingRemoval))}
        confirmLabel={texts.confirmRemove(pendingRemoval === null ? "" : memberName(pendingRemoval))}
        cancelLabel={common.cancel}
        danger
        onCancel={() => { setPendingRemoval(null); }}
        onConfirm={() => { if (pendingRemoval !== null) void removeMember(pendingRemoval); }}
      />
    </SubInspector>
  );
};

const ChannelRelease = ({
  opened,
  onReloadOverview: onReload,
  onAuthenticationRequired: onAuthenticationRequired,
  onClose,
}: {
  opened: boolean;
  onReloadOverview: () => Promise<void>;
  onAuthenticationRequired: () => void;
  onClose: () => void;
}): ReactElement => {
  const texts = platformTexts();
  const common = dashboardCommonTexts();
  const [login, setLogin] = useState("");
  const [resolving, setResolving] = useState(false);
  const [found, setFound] = useState<PanelTwitchUser | null>(null);
  const [fullConsent, setFullConsent] = useState(true);
  const [confirmation, setConfirmation] = useState(false);
  const [releaseInProgress, setReleaseInProgress] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const userField = useRef<TwitchUserFieldHandle>(null);

  const close = (): void => {
    if (resolving || releaseInProgress) return;
    setConfirmation(false);
    setActionError(undefined);
    setFound(null);
    setLogin("");
    userField.current?.clear();
    onClose();
  };

  const resolveUser = async (): Promise<void> => {
    if (resolving || login.length === 0) return;
    setResolving(true);
    try {
      const user = await userField.current?.resolve() ?? null;
      if (user !== null) {
        setFound(user);
        setFullConsent(true);
        setConfirmation(true);
      }
    } catch (error: unknown) {
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setResolving(false);
    }
  };

  const releaseChannel = async (): Promise<void> => {
    if (found === null) return;
    setReleaseInProgress(true);
    setActionError(undefined);
    try {
      await releasePlatformChannel(found, fullConsent);
      setConfirmation(false);
      setFound(null);
      setLogin("");
      userField.current?.clear();
      await onReload();
      notify({ tone: "success", message: common.saved });
      onClose();
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
      <FormDialog
        opened={opened}
        title={texts.releaseChannel}
        pending={resolving || releaseInProgress}
        confirmDisabled={login.length === 0 || releaseInProgress}
        {...(actionError === undefined ? {} : { error: actionError })}
        onConfirm={() => { if (found !== null) setConfirmation(true); else void resolveUser(); }}
        onCancel={close}
        confirmLabel={texts.releaseChannel}
        cancelLabel={common.cancel}
      >
        <TwitchUserField
          ref={userField}
          label={texts.twitchLogin}
          hint={texts.twitchLoginHint}
          value={found}
          onChange={setFound}
          onLoginChange={setLogin}
          onLookupError={(error) => { if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired(); }}
          loadSuggestions={loadPlatformUser}
          placeholder="beispielkanal"
          disabled={resolving || releaseInProgress}
        />
        <div className="platform-channel-release__result-slot">
          {found === null ? null : (
            <div className="member-grant-editor__result">
              <div><strong>{texts.userFound}: {found.displayName}</strong><span>@{found.login} · {texts.twitchId(found.userId)}</span></div>
              <SwitchRow label={texts.fullConsent} description={texts.fullConsentCardDescription} checked={fullConsent} disabled={releaseInProgress} onChange={setFullConsent} />
            </div>
          )}
        </div>
      </FormDialog>
      {found === null ? null : (
        <ConfirmDialog
          opened={confirmation}
          title={texts.releaseChannelQuestion(found.displayName)}
          description={texts.releaseChannelDescription(found.displayName, found.userId, fullConsent ? texts.yes : texts.no)}
          confirmLabel={texts.confirmRelease}
          cancelLabel={common.cancel}
          onCancel={() => { setConfirmation(false); }}
          onConfirm={() => { void releaseChannel(); }}
          pending={releaseInProgress}
        />
      )}
    </>
  );
};

const InvitationLink = ({ channel: channel }: { channel: PanelPlatformChannelOverview }): ReactElement => {
  const texts = platformTexts();
  const common = dashboardCommonTexts();
  const [copied, setCopied] = useState(false);
  const link = window.location.origin + "/auth/login?channel=" + encodeURIComponent(channel.login);

  const copyLinkToClipboard = async (): Promise<void> => {
    setCopied(false);
    const clipboard = Reflect.get(navigator, "clipboard") as { writeText: (text: string) => Promise<void> } | undefined;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      notify({ tone: "error", message: common.error });
      return;
    }
    try {
      await clipboard.writeText(link);
      setCopied(true);
    } catch {
      notify({ tone: "error", message: common.error });
    }
  };

  return (
    <div className={`platform-invitation-link${channel.broadcasterConnected ? " platform-invitation-link--compact" : ""}`} role="region" aria-label={texts.invitationLink}>
      {channel.broadcasterConnected ? <>
        <span>{texts.invitationLink}</span>
        <Button type="button" variant="neutral" icon={copied ? "copied" : "copy"} onClick={() => { void copyLinkToClipboard(); }}>{copied ? texts.linkCopied : texts.copyLink}</Button>
      </> : <div className="form-row">
        <Field label={texts.invitationLink} hint={texts.invitationLinkHint} value={link} onChange={() => {}} readOnly mono />
        <Button type="button" variant="neutral" icon={copied ? "copied" : "copy"} onClick={() => { void copyLinkToClipboard(); }}>{copied ? texts.linkCopied : texts.copyLink}</Button>
      </div>}
    </div>
  );
};

const PlatformSpotifyOverview = ({
  state,
  onRetry,
}: {
  state: LoadState<PanelSpotifyAccessResponse>;
  onRetry: () => void;
}): ReactElement => {
  const texts = platformTexts();
  return (
    <section className="platform-spotify-overview" aria-label={texts.spotifyOverview}>
      <div className="section-heading"><h2>{texts.spotifyAccess}</h2></div>
      {state.data === null
        ? state.error === null
          ? <p className="muted" role="status">…</p>
          : <div className="platform-spotify-overview__error"><p role="alert">{state.error}</p><Button type="button" variant="neutral" onClick={onRetry}>{dashboardCommonTexts().retry}</Button></div>
        : <>
          <p className="platform-spotify-overview__count" aria-live="polite">{texts.spotifyUsedSlots(String(state.data.usedSlots), String(state.data.limit))}</p>
          {state.data.channels.length === 0
            ? <p className="muted">{texts.spotifyNoSlots}</p>
            : <ul className="platform-spotify-overview__channels">
              {state.data.channels.map(({ channelId, slot, login }) => <li key={channelId}>{String(slot)}. @{login}</li>)}
            </ul>}
        </>}
    </section>
  );
};

const PlatformAudit = ({
  auditState: auditState,
  channels: channels,
  onLoadMore: onLoadMore,
  onRetry: onRetry,
  loadingMore: loadingMore,
}: {
  auditState: LoadState<PanelPlatformAuditResponse>;
  channels: PanelPlatformChannelOverview[];
  onLoadMore: () => void;
  onRetry: () => void;
  loadingMore: boolean;
}): ReactElement => {
  const texts = platformTexts();
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.channelId, channel.login])), [channels]);
  const record = (value: string): Record<string, unknown> | null => {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  };
  const recordText = (value: Record<string, unknown> | null, ...keys: string[]): string | null => {
    for (const key of keys) {
      const found = value?.[key];
      if (typeof found === "string" && found.trim().length > 0) return found;
    }
    return null;
  };
  const actorName = (entry: PanelPlatformAuditEntry): string =>
    entry.actorDisplayName ?? (entry.actorLogin == null ? entry.actorUserId : `@${entry.actorLogin}`);
  const actor = (entry: PanelPlatformAuditEntry): string =>
    (entry.actorKind === "platform_admin" ? texts.platformAdmin : texts.member) + " · " + actorName(entry);
  const sentence = (entry: PanelPlatformAuditEntry): string => {
    const before = record(entry.before);
    const after = record(entry.after);
    const isMemberAction = entry.action.startsWith("member.");
    const object = isMemberAction
      ? recordText(after, "displayName", "login") ?? recordText(before, "displayName", "login") ?? entry.subjectDisplayName ?? (entry.subjectLogin === null || entry.subjectLogin === undefined ? entry.subjectUserId : `@${entry.subjectLogin}`) ?? recordText(after, "userId") ?? recordText(before, "userId") ?? texts.member
      : channelNames.get(entry.channelId) ?? entry.channelId;
    const roleText = (value: unknown): string | null =>
      value === "broadcaster" || value === "manager" || value === "operator" ? roleLabel(value) : null;
    const valueText = (source: Record<string, unknown> | null, key: string): string | null => {
      const value = source?.[key];
      return typeof value === "boolean" ? value ? texts.yes : texts.no : null;
    };
    let from: string | null = null;
    let to: string | null = null;
    if (isMemberAction) {
      from = roleText(before?.role);
      to = roleText(after?.role);
    } else if (entry.action === "channel.full_consent_changed") {
      from = valueText(before, "fullConsent");
      to = valueText(after, "fullConsent");
    }
    return auditSentenceForAction(entry.action, { actor: actor(entry), object, from, to });
  };
  const status = auditState.data === null
    ? auditState.status === "error" ? "error" : "loading"
    : auditState.data.entries.length === 0 ? "empty" : "success";
  return (
    <section className="config-section" aria-label={texts.audit}>
      <div className="section-heading"><h2>{texts.audit}</h2></div>
      <div className="platform-audit-pagination-slot">
        {(auditState.data?.entries.length ?? 0) === 0 && auditState.data?.nextCursor == null ? null : <ListPaginationFooter loadedCount={auditState.data?.entries.length ?? 0} loadedLabel={texts.loaded}>
          {auditState.data?.nextCursor == null ? null : <button className="button button--secondary" type="button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? texts.loadingMore : texts.loadMore}</button>}
        </ListPaginationFooter>}
      </div>
      <LoadStateView
        variant="panel-280"
        status={status}
        loading={<LoadStateLines rows={6} height={34} />}
        empty={<p className="muted">{texts.auditEmpty}</p>}
        error={<p role="alert">{auditState.error ?? texts.error}</p>}
        queryError={{ message: auditState.error ?? texts.error, onRetry }}
      >{auditState.data === null || auditState.data.entries.length === 0 ? null : (
        <div className="table-wrap">
          <table className="table platform-audit-table">
            <thead><tr><th scope="col">{texts.login}</th><th scope="col">{texts.action}</th><th scope="col">{texts.timestamp}</th></tr></thead>
            <tbody>{auditState.data.entries.map((entry) => <tr key={entry.auditId}>
              <th scope="row" data-field="channel" data-label={texts.login}>{channelNames.get(entry.channelId) ?? <span className="mono">{entry.channelId}</span>}</th>
              <td data-field="action" data-label={texts.action}><AuditSentence sentence={sentence(entry)} /></td>
              <td className="mono" data-field="timestamp" data-label={texts.timestamp} title={entry.createdAt}>{formatTimestamp(entry.createdAt)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      )}</LoadStateView>
    </section>
  );
};

export const PlatformPage = ({ onAuthenticationRequired: onAuthenticationRequired }: PlatformPageProperties): ReactElement => {
  const texts = platformTexts();
  const [overview, setOverview] = useState<LoadState<PanelPlatformChannelOverview[]>>(() => emptyLoadState());
  const [audit, setAudit] = useState<LoadState<PanelPlatformAuditResponse>>(() => emptyLoadState());
  const [spotifyAccess, setSpotifyAccess] = useState<LoadState<PanelSpotifyAccessResponse>>(() => emptyLoadState());
  const { selectedKey: selectedChannelId, select: selectChannel, rowRef: channelRowRef, close: closeChannel } = useInspectorSelection<string>();
  const [channelReleaseOpen, setChannelReleaseOpen] = useState(false);
  const channelReleaseButton = useRef<HTMLButtonElement | null>(null);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);
  const notifiedPageError = useRef<string | null>(null);
  // Initial-load errors render in place of the list; the toast only covers failures while data is already shown.
  const pageError = (overview.data === null ? null : overview.error) ?? (audit.data === null ? null : audit.error);

  useEffect(() => {
    if (pageError === null) {
      notifiedPageError.current = null;
      return;
    }
    if (notifiedPageError.current === pageError) return;
    notifiedPageError.current = pageError;
    notify({ tone: "error", message: pageError });
  }, [pageError]);

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
    if (selectedChannelId !== null) closeChannel();
  }, [selectedChannelId, closeChannel]);

  // Every load (initial or retry) is guarded: a newer request or an unmount makes older results, including a 401, irrelevant.
  const overviewGeneration = useRef(0);
  const auditGeneration = useRef(0);
  const spotifyGeneration = useRef(0);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => { unmounted.current = true; };
  }, []);

  const loadOverview = async (): Promise<void> => {
    const generation = ++overviewGeneration.current;
    const stale = (): boolean => unmounted.current || generation !== overviewGeneration.current;
    setOverview((current) => current.data === null ? loadState() : { ...current, status: "loading", error: null });
    try {
      const response = await getPlatformOverview();
      if (stale()) return;
      setOverview(loadedState(response.channels));
      if (selectedChannelId !== null && !response.channels.some((channel) => channel.channelId === selectedChannelId)) closeChannel();
    } catch (error: unknown) {
      if (stale()) return;
      setOverview({ status: "error", data: null, error: errorText(error, texts.error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    }
  };

  const loadAudit = async (): Promise<void> => {
    const generation = ++auditGeneration.current;
    const stale = (): boolean => unmounted.current || generation !== auditGeneration.current;
    setAudit(loadState());
    try {
      const response = await getPlatformAudit();
      if (!stale()) setAudit(loadedState(response));
    } catch (error: unknown) {
      if (stale()) return;
      setAudit({ status: "error", data: null, error: errorText(error, texts.error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    }
  };

  const loadSpotifyAccess = async (): Promise<void> => {
    const generation = ++spotifyGeneration.current;
    const stale = (): boolean => unmounted.current || generation !== spotifyGeneration.current;
    setSpotifyAccess((current) => current.data === null ? loadState() : { ...current, status: "loading", error: null });
    try {
      const response = await getPlatformSpotifyAccess();
      if (!stale()) setSpotifyAccess(loadedState(response));
    } catch (error: unknown) {
      if (stale()) return;
      setSpotifyAccess({ status: "error", data: null, error: errorText(error, texts.error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    }
  };

  // Overview, Spotify access, and audit load independently so one failing request cannot block another page section.
  const loaders = useRef({ loadOverview, loadAudit, loadSpotifyAccess });
  loaders.current = { loadOverview, loadAudit, loadSpotifyAccess };
  useEffect(() => { void loaders.current.loadOverview(); }, [onAuthenticationRequired]);
  useEffect(() => { void loaders.current.loadAudit(); }, [onAuthenticationRequired]);
  useEffect(() => { void loaders.current.loadSpotifyAccess(); }, [onAuthenticationRequired]);

  const selectedChannel = overview.data?.find((channel) => channel.channelId === selectedChannelId) ?? null;
  const inspectorOpen = selectedChannelId !== null;
  const overviewStatus = overview.data === null
    ? overview.status === "error" ? "error" : "loading"
    : overview.data.length === 0 ? "empty" : "success";

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
    <section className="module-stack platform-page" aria-label={texts.title}>
      <PageHeader kind="platform" title={texts.title} subtitle={texts.subtitle(formatNumber(overview.data?.length ?? 0))} actions={
        <Button ref={channelReleaseButton} variant="primary" icon="add" onClick={openChannelRelease}>{texts.releaseChannel}</Button>
      } />
      <Tabs className="platform-tabs" defaultValue="channels" keepMounted={false}>
        <Tabs.List className="platform-tabs__list" aria-label={texts.title}>
          <Tabs.Tab className="platform-tabs__tab" value="channels">{texts.channels}</Tabs.Tab>
          <Tabs.Tab className="platform-tabs__tab" value="audit">{texts.auditTab}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel className="platform-tabs__panel" value="channels">
          <section className="config-section" aria-label={texts.channelOverview}>
            <ListDetail
              list={
                <div className="platform-channel-list">
                  <PlatformSpotifyOverview state={spotifyAccess} onRetry={() => { void loadSpotifyAccess(); }} />
                  <InspectorHeading level="h2" title={texts.channelOverview} />
                  <LoadStateView
                    variant="panel-360"
                    status={overviewStatus}
                    loading={<LoadStateLines rows={6} height={34} />}
                    empty={<p className="muted">{texts.noChannels}</p>}
                    error={<p role="alert">{overview.error ?? texts.error}</p>}
                    queryError={{ message: overview.error ?? texts.error, onRetry: () => { void loadOverview(); } }}
                  >{overview.data === null || overview.data.length === 0 ? null : (
                    <div className="table-wrap">
                      <table className={`table table--content platform-channel-table${inspectorOpen ? " platform-channel-table--inspector-open" : ""}`}>
                        <thead><tr><th scope="col">{texts.login}</th>{inspectorOpen ? null : <th scope="col">{texts.identifier}</th>}<th scope="col" title={texts.fullConsent}>{texts.fullConsentColumn}</th>{inspectorOpen ? null : <th scope="col" title={`${texts.broadcaster} · ${texts.manager} · ${texts.operator}`}>{texts.members}</th>}<th scope="col">{inspectorOpen ? texts.identityShort : texts.identity}</th></tr></thead>
                        <tbody>{overview.data.map((channel) => {
                          const broadcasterCount = formatNumber(channel.memberCounts.broadcaster);
                          const managerCount = formatNumber(channel.memberCounts.manager);
                          const operatorCount = formatNumber(channel.memberCounts.operator);
                          return <tr key={channel.channelId} ref={channelRowRef(channel.channelId)} tabIndex={0} aria-selected={channel.channelId === selectedChannelId} onClick={() => { setChannelReleaseOpen(false); selectChannel(channel.channelId); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setChannelReleaseOpen(false); selectChannel(channel.channelId); } }}>
                            <th scope="row" data-field="login" data-label={texts.login} title={inspectorOpen ? channel.channelId : channel.login}>{channel.login}</th>
                            {inspectorOpen ? null : <td className="mono" data-field="identifier" data-label={texts.identifier} title={channel.channelId}>{channel.channelId}</td>}
                            <td data-field="consent" data-label={texts.fullConsentColumn}>{channel.fullConsent ? texts.yes : texts.no}</td>
                            {inspectorOpen ? null : <td data-field="members" data-label={texts.members} aria-label={texts.memberCounts(broadcasterCount, managerCount, operatorCount)}><span className="platform-channel-member-counts">
                              <span>{texts.broadcaster}: {broadcasterCount}</span>
                              <span>{texts.manager}: {managerCount}</span>
                              <span>{texts.operator}: {operatorCount}</span>
                            </span></td>}
                            <td data-field="identity" data-label={inspectorOpen ? texts.identityShort : texts.identity}><span className="led" data-status={connectionTone(channel) === "healthy" ? "green" : connectionTone(channel) === "warning" ? "amber" : "off"}><span className="led__dot" aria-hidden="true" /><span>{connectionWord(channel, inspectorOpen)}</span></span></td>
                          </tr>;
                        })}</tbody>
                      </table>
                    </div>
                  )}</LoadStateView>
                </div>
              }
              inspector={selectedChannel === null ? null
                : <ChannelInspector key={selectedChannel.channelId} channel={selectedChannel} onAuthenticationRequired={onAuthenticationRequired} onReloadOverview={loadOverview} spotifyAccess={spotifyAccess.data} onReloadSpotifyAccess={loadSpotifyAccess} onClose={closeChannel} />}
              onCloseInspector={closeFloating}
            />
          </section>
        </Tabs.Panel>
        <Tabs.Panel className="platform-tabs__panel" value="audit">
          <PlatformAudit auditState={audit} channels={overview.data ?? []} onLoadMore={() => { void loadMoreAudit(); }} onRetry={() => { void loadAudit(); }} loadingMore={auditLoadingMore} />
        </Tabs.Panel>
      </Tabs>
      <ChannelRelease opened={channelReleaseOpen} onReloadOverview={loadOverview} onAuthenticationRequired={onAuthenticationRequired} onClose={closeChannelRelease} />
    </section>
  );
};
