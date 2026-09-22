import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";

import { CHANNEL_ROLES, canManage, type ChannelRole } from "../contracts/values";
import type { PanelMember, PanelTwitchUser } from "../panel-contract";
import { membersTexts, roleLabel } from "./labels";
import { apiErrorText, dashboardCommonTexts, formatDate } from "./locale";
import { ModuleCount, ModuleHeading } from "./module-panels";
import { ListDetail, SubInspector, useInspectorSelection } from "./ui";
import {
  addChannelMember,
  PanelApiError,
  removeChannelMember,
  searchTwitchUser,
  updateChannelMemberRole,
} from "./api";

interface MembersPageProperties {
  channelId: string;
  ownRole: ChannelRole;
  /** Own Twitch user id, to recognize the own entry. */
  ownUserId: string;
  members: PanelMember[];
  /** Broadcasters across the whole channel, not on this page. */
  broadcasterCount: number;
  nextCursor: string | null;
  loading: boolean;
  loadingNextPage: boolean;
  error: string | null;
  onReload: () => Promise<void>;
  onLoadNextPage: () => Promise<void>;
  onAuthenticationRequired: () => void;
}

const manageableRoles = CHANNEL_ROLES;

/** The join date is days to years in the past; the time of day adds nothing there. */
const formatJoinDate = (value: string): string => formatDate(value);

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return membersTexts().sessionInvalid;
  const fallback = membersTexts().changeFailed;
  return error instanceof PanelApiError ? apiErrorText(error.code, fallback) : fallback;
};

/**
 * The UI does not offer as an option what the worker would reject anyway.
 * A button that's guaranteed to fail looks like an option — you'd have
 * to press it to find out it isn't one.
 *
 * Disabled with a reason instead of hidden: a vanished button raises the
 * question of whether something is broken; a disabled one with a reason answers it.
 *
 * The check in the worker is unaffected by this. This here is a convenience,
 * not a security boundary.
 */
const isLastBroadcaster = (member: PanelMember, broadcasterCount: number): boolean =>
  member.role === "broadcaster" && broadcasterCount <= 1;

const removalLocked = (member: PanelMember, broadcasterCount: number): string | null =>
  isLastBroadcaster(member, broadcasterCount)
    ? membersTexts().lastBroadcaster
    : null;

/**
 * Role values that actually go through for this entry. The own role
 * cannot be raised, and the last broadcaster cannot be demoted.
 */
const selectableRoles = (
  member: PanelMember,
  ownUserId: string,
  broadcasterCount: number,
): readonly ChannelRole[] => {
  if (isLastBroadcaster(member, broadcasterCount)) return [member.role];
  if (member.userId !== ownUserId) return manageableRoles;
  const rank: Record<ChannelRole, number> = { operator: 0, manager: 1, broadcaster: 2 };
  return manageableRoles.filter((role) => rank[role] <= rank[member.role]);
};

const memberLabel = (member: PanelMember): string =>
  member.displayName ?? (member.login === null ? membersTexts().unresolvable : `@${member.login}`);

const roleOptions = (roles: readonly ChannelRole[] = manageableRoles): ReactElement[] =>
  roles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>);

const accessConfirmation = (role: ChannelRole): string =>
  membersTexts().confirmationText(roleLabel(role));

/**
 * `src` may also be missing, not just `null`: during a deploy, a new panel
 * bundle can talk to an older worker that doesn't supply the field yet.
 * A missing image must not take down the page.
 */
const MemberAvatar = ({ src }: { src: string | null | undefined }): ReactElement => {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (src === null || src === undefined || src.length === 0 || failedSource === src) {
    return <span className="member-avatar-placeholder" aria-hidden="true" />;
  }
  return <img className="member-avatar" src={src} alt="" aria-hidden="true" onError={() => setFailedSource(src)} />;
};

const MemberList = ({
  members,
  selectedUserId,
  onSelect,
  rowRef,
}: {
  members: PanelMember[];
  selectedUserId: string | null;
  onSelect: (userId: string) => void;
  rowRef: (userId: string) => (row: HTMLTableRowElement | null) => void;
}): ReactElement => {
  const texts = membersTexts();
  if (members.length === 0) return <p className="muted">{texts.empty}</p>;
  return (
    <div className="table-wrap">
      <table className="table members-table">
        <thead className="sr-only"><tr role="row"><th scope="col" role="columnheader">{texts.name}</th><th scope="col" role="columnheader">{texts.role}</th><th scope="col" role="columnheader" aria-sort="descending">{texts.accessSince}</th></tr></thead>
        <tbody>
          {members.map((member) => {
            const selected = selectedUserId === member.userId;
            const select = (): void => onSelect(member.userId);
            return (
              <tr
                key={member.userId}
                ref={rowRef(member.userId)}
                role="row"
                tabIndex={0}
                aria-selected={selected}
                onClick={select}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } }}
              >
                <th scope="row" role="rowheader">
                  <div className="avatar-row">
                    <MemberAvatar src={member.profileImageUrl} />
                    <div>
                      <span>{memberLabel(member)}</span>
                      {member.displayName !== null && member.login !== null ? (
                        <a
                          className="login-hint profile-link"
                          href={`https://twitch.tv/${member.login}`}
                          target="_blank"
                          rel="noreferrer noopener"
                        >twitch.tv/{member.login}</a>
                      ) : null}
                      {member.displayName === null && member.login === null ? <span className="login-hint">{texts.twitchId(member.userId)}</span> : null}
                    </div>
                  </div>
                </th>
                <td role="cell">{roleLabel(member.role)}</td>
                <td className="number" role="cell">{formatJoinDate(member.joinedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

const MemberEditor = ({
  member,
  canManageMembers,
  broadcasterCount,
  ownUserId,
  busy,
  onRoleChange,
  onRemove,
  onClose,
}: {
  member: PanelMember;
  canManageMembers: boolean;
  broadcasterCount: number;
  ownUserId: string;
  busy: boolean;
  onRoleChange: (role: ChannelRole) => void;
  onRemove: () => void;
  onClose: () => void;
}): ReactElement => {
  const texts = membersTexts();
  const name = memberLabel(member);
  const managementLocked = canManageMembers ? null : texts.managementLocked;
  const locked = removalLocked(member, broadcasterCount);

  return (
    <SubInspector ariaLabel={texts.editMember(name)} title={name} identifier={formatJoinDate(member.joinedAt)} closeLabel={dashboardCommonTexts().close} onClose={onClose}>
      <div className="avatar-row">
        <MemberAvatar src={member.profileImageUrl} />
        <div>
          <span>{name}</span>
          {member.displayName !== null && member.login !== null ? (
            <a
              className="login-hint profile-link"
              href={`https://twitch.tv/${member.login}`}
              target="_blank"
              rel="noreferrer noopener"
            >twitch.tv/{member.login}</a>
          ) : null}
          {member.displayName === null && member.login === null ? <span className="login-hint">{texts.twitchId(member.userId)}</span> : null}
        </div>
      </div>
      <label className="config-field config-field--medium">
        {texts.role}
        <select
          aria-label={texts.roleFor(name)}
          value={member.role}
          disabled={!canManageMembers || busy || isLastBroadcaster(member, broadcasterCount)}
          title={managementLocked ?? locked ?? undefined}
          onChange={(event) => { onRoleChange(event.target.value as ChannelRole); }}
        >
          {roleOptions(selectableRoles(member, ownUserId, broadcasterCount))}
        </select>
        {managementLocked !== null ? <span className="lock-reason">{managementLocked}</span> : locked === null ? null : <span className="lock-reason">{texts.lastBroadcaster}</span>}
      </label>
      <div className="form-actions form-actions--destructive">
        <button
          className="button button--quiet"
          type="button"
          aria-label={texts.removeAccessFor(name)}
          disabled={!canManageMembers || busy || locked !== null}
          title={managementLocked ?? locked ?? undefined}
          onClick={onRemove}
        >{texts.remove}</button>
      </div>
      {locked === null ? null : <span className="lock-reason">{texts.lastBroadcaster}</span>}
    </SubInspector>
  );
};

export const MembersPage = ({
  channelId,
  ownRole,
  ownUserId,
  members,
  broadcasterCount,
  nextCursor,
  loading,
  loadingNextPage,
  error,
  onReload,
  onLoadNextPage,
  onAuthenticationRequired,
}: MembersPageProperties): ReactElement => {
  const texts = membersTexts();
  const [login, setLogin] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [foundUser, setFoundUser] = useState<PanelTwitchUser | null>(null);
  const [newRole, setNewRole] = useState<ChannelRole>("operator");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmingAdd, setConfirmingAdd] = useState(false);
  const canManageMembers = canManage(ownRole);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const { selectedKey: selectedUserId, select: selectMember, rowRef, close: closeSelection } = useInspectorSelection<string>();

  /**
   * `role="alertdialog"` requires focus to actually move into it —
   * otherwise neither keyboard nor screen reader use notices the form's
   * most important safety prompt.
   */
  useEffect(() => {
    if (confirmingAdd) confirmButtonRef.current?.focus();
  }, [confirmingAdd]);

  useEffect(() => {
    if (selectedUserId !== null && !members.some((member) => member.userId === selectedUserId)) closeSelection();
  }, [members, selectedUserId, closeSelection]);

  const cancelAdd = (): void => setConfirmingAdd(false);

  const handleSearch = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canManageMembers) return;
    setSearching(true);
    setSearchError(null);
    setFoundUser(null);
    setConfirmingAdd(false);
    try {
      setFoundUser((await searchTwitchUser(channelId, login)).user);
    } catch (error: unknown) {
      setSearchError(errorMessage(error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setSearching(false);
    }
  };

  const handleAdd = async (): Promise<void> => {
    if (!canManageMembers || foundUser === null) return;
    setBusyUserId(foundUser.userId);
    setActionError(null);
    try {
      await addChannelMember(channelId, foundUser.userId, newRole);
      setConfirmingAdd(false);
      setFoundUser(null);
      setLogin("");
      await onReload();
    } catch (error: unknown) {
      setActionError(errorMessage(error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRoleChange = async (userId: string, role: ChannelRole): Promise<void> => {
    setBusyUserId(userId);
    setActionError(null);
    try {
      await updateChannelMemberRole(channelId, userId, role);
      await onReload();
    } catch (error: unknown) {
      setActionError(errorMessage(error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  const handleRemove = async (member: PanelMember): Promise<void> => {
    const isSelf = member.userId === ownUserId;
    const confirmationMessage = isSelf
      ? texts.removeSelf
      : texts.removeOther(memberLabel(member));
    if (!window.confirm(confirmationMessage)) return;
    setBusyUserId(member.userId);
    setActionError(null);
    try {
      await removeChannelMember(channelId, member.userId);
      await onReload();
    } catch (error: unknown) {
      setActionError(errorMessage(error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  const selectedMember = members.find((member) => member.userId === selectedUserId) ?? null;

  return (
    <>
      <ModuleHeading kind="members" title={texts.title} subtitle={<ModuleCount count={members.length} label={texts.count} />} />
      <section className="inspector-section inspector-form" aria-label={texts.grantAccessTitle}>
        <div className="section-heading"><h2>{texts.grantAccessTitle}</h2></div>
        {!canManageMembers ? <p className="lock-reason">{texts.managementLocked}</p> : null}
        <form className="inspector-form" onSubmit={(event) => { void handleSearch(event); }}>
          <label htmlFor="member-search">{texts.twitchName}</label>
          <div className="form-row"><input id="member-search" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="off" disabled={!canManageMembers} title={!canManageMembers ? texts.managementLocked : undefined} /><button className="button" type="submit" disabled={!canManageMembers || searching || login.trim().length === 0} title={!canManageMembers ? texts.managementLocked : undefined}>{searching ? texts.searching : texts.search}</button></div>
        </form>
        {!canManageMembers && foundUser === null ? <div><button className="button" type="button" disabled title={texts.managementLocked}>{texts.grantAccess}</button><span className="lock-reason">{texts.managementLocked}</span></div> : null}
        {searchError === null ? null : <p className="form-error" role="alert">{searchError}</p>}
        {foundUser === null ? null : (
          <div className="inspector-result">
            <div className="avatar-row">
              <MemberAvatar src={foundUser.profileImageUrl} />
              <div>
                <strong>{foundUser.displayName}</strong>
                <span>@{foundUser.login} · Twitch-ID {foundUser.userId}</span>
                <a
                  className="login-hint profile-link"
                  href={`https://twitch.tv/${foundUser.login}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >twitch.tv/{foundUser.login}</a>
              </div>
            </div>
            <label>{texts.role}<select aria-label={texts.newMemberRoleLabel} value={newRole} disabled={!canManageMembers} title={!canManageMembers ? texts.managementLocked : undefined} onChange={(event) => setNewRole(event.target.value as ChannelRole)}>{roleOptions()}</select></label>
            <div>
              <button className="button" type="button" onClick={() => { setActionError(null); setConfirmingAdd(true); }} disabled={!canManageMembers || busyUserId === foundUser.userId} title={!canManageMembers ? texts.managementLocked : undefined}>{texts.grantAccess}</button>
              {!canManageMembers ? <span className="lock-reason">{texts.managementLocked}</span> : null}
            </div>
          </div>
        )}
        {confirmingAdd && foundUser !== null ? (
          <div
            className="inspector-confirmation"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="member-add-confirmation-title"
            aria-describedby="member-add-confirmation-description"
            onKeyDown={(event) => { if (event.key === "Escape") cancelAdd(); }}
          >
            <div className="avatar-row">
              <MemberAvatar src={foundUser.profileImageUrl} />
              <div>
                <h3 id="member-add-confirmation-title">{texts.confirmationTitle(foundUser.displayName)}</h3>
                <span>@{foundUser.login}</span>
              </div>
            </div>
            <p id="member-add-confirmation-description">{accessConfirmation(newRole)}</p>
            {!canManageMembers ? <span className="lock-reason">{texts.managementLocked}</span> : null}
            <div className="form-actions">
              <button ref={confirmButtonRef} className="button button--primary" type="button" onClick={() => { void handleAdd(); }} disabled={!canManageMembers || busyUserId === foundUser.userId} title={!canManageMembers ? texts.managementLocked : undefined}>{texts.grantPermanently}</button>
              <button className="button button--quiet" type="button" onClick={cancelAdd} disabled={busyUserId === foundUser.userId}>{dashboardCommonTexts().cancel}</button>
            </div>
          </div>
        ) : null}
      </section>
      <section className="content-section" aria-label={texts.membersWithAccess}>
        <div className="section-heading"><h2>{texts.membersWithAccess}</h2></div>
        {loading && members.length === 0 ? <p className="loading-line">{texts.load}</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
        {members.length === 0 && loading ? null : <div className={loading ? "stale" : undefined}>
          <ListDetail
            list={<MemberList members={members} selectedUserId={selectedUserId} onSelect={selectMember} rowRef={rowRef} />}
            inspector={selectedMember === null ? null : (
              <MemberEditor
                key={selectedMember.userId}
                member={selectedMember}
                canManageMembers={canManageMembers}
                broadcasterCount={broadcasterCount}
                ownUserId={ownUserId}
                busy={busyUserId === selectedMember.userId}
                onRoleChange={(role) => { void handleRoleChange(selectedMember.userId, role); }}
                onRemove={() => { void handleRemove(selectedMember); }}
                onClose={closeSelection}
              />
            )}
            onCloseInspector={closeSelection}
          />
        </div>}
        {nextCursor == null ? null : <button className="button button--secondary" type="button" onClick={() => { void onLoadNextPage(); }} disabled={loading || loadingNextPage}>{loadingNextPage ? texts.loadingMore : texts.loadMore}</button>}
      </section>
    </>
  );
};
