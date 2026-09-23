import { useEffect, useRef, useState, type ReactElement } from "react";

import { CHANNEL_ROLES, canManage, type ChannelRole } from "../contracts/values";
import type { PanelMember } from "../panel-contract";
import { membersTexts, roleDescription, roleLabel } from "./labels";
import { apiErrorText, dashboardCommonTexts, formatDate } from "./locale";
import { ModuleCount, ModuleHeading } from "./module-panels";
import { MemberAvatar } from "./member-avatar";
import { MemberGrantEditor } from "./member-grant-editor";
import { Button, ChoiceCards, ConfirmDialog, EditorShell, ListDetail, useDraftGuard, useInspectorSelection } from "./ui";
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
                    <MemberAvatar src={member.profileImageUrl} name={member.displayName ?? member.login ?? member.userId} />
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

/**
 * The member editor (15b): a role `ChoiceCards` as the only draft field,
 * "Zugang entziehen" left in the save bar behind its own `ConfirmDialog`.
 * `role`/`dirty`/`onRoleChange` are controlled by `MembersPage` so its
 * `useDraftGuard` (row switch, grant editor, close) can see the same draft.
 */
const MemberInspector = ({
  member,
  canManageMembers,
  broadcasterCount,
  ownUserId,
  role,
  dirty,
  onRoleChange,
  pending,
  error,
  onSave,
  onDiscard,
  onRemove,
  onClose,
}: {
  member: PanelMember;
  canManageMembers: boolean;
  broadcasterCount: number;
  ownUserId: string;
  role: ChannelRole;
  dirty: boolean;
  onRoleChange: (role: ChannelRole) => void;
  pending: boolean;
  error?: string;
  onSave: () => void;
  onDiscard: () => void;
  onRemove: () => void;
  onClose: () => void;
}): ReactElement => {
  const texts = membersTexts();
  const common = dashboardCommonTexts();
  const name = memberLabel(member);
  const roles = selectableRoles(member, ownUserId, broadcasterCount);
  const locked = removalLocked(member, broadcasterCount);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);

  const propertiesList = (
    <dl className="properties">
      <div><dt>{texts.name}</dt><dd>{name}</dd></div>
      <div><dt>{texts.role}</dt><dd>{roleLabel(member.role)}</dd></div>
      <div><dt>{texts.accessSince}</dt><dd>{formatJoinDate(member.joinedAt)}</dd></div>
    </dl>
  );

  if (!canManageMembers) {
    return (
      <EditorShell
        ariaLabel={texts.editMember(name)}
        title={name}
        identifier={formatJoinDate(member.joinedAt)}
        sections={[]}
        readOnly={{ reason: texts.managementLocked, content: propertiesList }}
        dirty={false}
        onSave={() => {}}
        onDiscard={() => {}}
        saveLabel={common.save}
        discardLabel={common.discard}
        savedLabel={common.saved}
        pendingLabel={common.saving}
        issueLabels={{ error: common.error, warning: common.warning }}
        onClose={onClose}
        closeLabel={common.close}
      />
    );
  }

  return (
    <>
      <EditorShell
        ariaLabel={texts.editMember(name)}
        title={name}
        identifier={formatJoinDate(member.joinedAt)}
        sections={[{
          id: "role",
          label: texts.role,
          content: (
            <ChoiceCards
              label={texts.roleFor(name)}
              hint={locked ?? texts.roleHint}
              value={role}
              onChange={(next) => { onRoleChange(next as ChannelRole); }}
              options={roles.map((candidate) => ({ value: candidate, label: roleLabel(candidate), description: roleDescription(candidate) }))}
              disabled={locked !== null}
            />
          ),
        }]}
        dirty={dirty}
        pending={pending}
        {...(error === undefined ? {} : { error })}
        onSave={onSave}
        onDiscard={onDiscard}
        saveLabel={common.save}
        discardLabel={common.discard}
        savedLabel={common.saved}
        pendingLabel={common.saving}
        issueLabels={{ error: common.error, warning: common.warning }}
        onClose={onClose}
        closeLabel={common.close}
        footer={<span title={locked ?? undefined}><Button danger icon="memberRemove" disabled={locked !== null} onClick={() => { setRemoveConfirmOpen(true); }}>{texts.remove}</Button></span>}
      />
      <ConfirmDialog
        opened={removeConfirmOpen}
        title={texts.removeConfirmTitle(name)}
        description={member.userId === ownUserId ? texts.removeSelf : texts.removeOther(name)}
        confirmLabel={texts.remove}
        cancelLabel={common.cancel}
        danger
        onCancel={() => { setRemoveConfirmOpen(false); }}
        onConfirm={() => { setRemoveConfirmOpen(false); onRemove(); }}
      />
    </>
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
  const canManageMembers = canManage(ownRole);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const grantButtonRef = useRef<HTMLButtonElement | null>(null);
  const [roleDraft, setRoleDraft] = useState<{ userId: string; role: ChannelRole } | null>(null);
  const { selectedKey: selectedUserId, select: selectMember, rowRef, close: closeSelection } = useInspectorSelection<string>();

  useEffect(() => {
    if (selectedUserId !== null && !members.some((member) => member.userId === selectedUserId)) closeSelection();
  }, [members, selectedUserId, closeSelection]);

  const selectedMember = members.find((member) => member.userId === selectedUserId) ?? null;
  const draftRole = selectedMember !== null && roleDraft?.userId === selectedMember.userId ? roleDraft.role : selectedMember?.role ?? "operator";
  const roleDirty = selectedMember !== null && roleDraft !== null && roleDraft.userId === selectedMember.userId && roleDraft.role !== selectedMember.role;

  const saveRoleDraft = async (): Promise<string | null> => {
    if (selectedMember === null || roleDraft === null || !roleDirty) return null;
    setBusyUserId(roleDraft.userId);
    setActionError(null);
    try {
      await updateChannelMemberRole(channelId, roleDraft.userId, roleDraft.role);
      setRoleDraft(null);
      await onReload();
      return null;
    } catch (error: unknown) {
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
      return errorMessage(error);
    } finally {
      setBusyUserId(null);
    }
  };

  const draftGuard = useDraftGuard(roleDirty, saveRoleDraft, () => { setRoleDraft(null); });

  const openGrant = (): void => {
    draftGuard.guardSwitch(() => {
      closeSelection();
      setGrantOpen(true);
      grantButtonRef.current?.focus();
    });
  };

  const closeGrant = (): void => {
    setGrantOpen(false);
    grantButtonRef.current?.focus();
  };

  const selectMemberGuarded = (userId: string): void => {
    draftGuard.guardSwitch(() => { setGrantOpen(false); selectMember(userId); });
  };

  const closeFloating = (): void => {
    draftGuard.guardSwitch(() => {
      if (selectedUserId !== null) closeSelection();
      if (grantOpen) setGrantOpen(false);
    });
  };

  const handleRemove = async (member: PanelMember): Promise<void> => {
    setBusyUserId(member.userId);
    setActionError(null);
    try {
      await removeChannelMember(channelId, member.userId);
      closeSelection();
      await onReload();
    } catch (error: unknown) {
      setActionError(errorMessage(error));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <>
      <ModuleHeading kind="members" title={texts.title} subtitle={<ModuleCount count={members.length} label={texts.count} />} />
      <section className="content-section" aria-label={texts.membersWithAccess}>
        <div className="section-heading">
          <h2>{texts.membersWithAccess}</h2>
          <span title={canManageMembers ? undefined : texts.managementLocked}>
            <Button ref={grantButtonRef} variant="subtle" iconOnly icon="add" ariaLabel={texts.grantAccessTitle} disabled={!canManageMembers} onClick={openGrant} />
          </span>
        </div>
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
        <div className={loading ? "stale" : undefined}>
          <ListDetail
            list={loading && members.length === 0 ? <p className="loading-line">{texts.load}</p> : <MemberList members={members} selectedUserId={selectedUserId} onSelect={selectMemberGuarded} rowRef={rowRef} />}
            inspector={selectedMember !== null ? (
              <MemberInspector
                key={selectedMember.userId}
                member={selectedMember}
                canManageMembers={canManageMembers}
                broadcasterCount={broadcasterCount}
                ownUserId={ownUserId}
                role={draftRole}
                dirty={roleDirty}
                onRoleChange={(role) => { setRoleDraft({ userId: selectedMember.userId, role }); }}
                pending={busyUserId === selectedMember.userId}
                {...(actionError === null ? {} : { error: actionError })}
                onSave={() => { void saveRoleDraft(); }}
                onDiscard={() => { setRoleDraft(null); }}
                onRemove={() => { void handleRemove(selectedMember); }}
                onClose={closeFloating}
              />
            ) : grantOpen ? (
              <MemberGrantEditor
                roles={manageableRoles}
                defaultRole="operator"
                texts={{
                  ariaLabel: texts.grantAccessTitle,
                  title: texts.grantAccessTitle,
                  searchLabel: texts.twitchName,
                  searchHint: texts.twitchNameHint,
                  searchButton: texts.search,
                  searchingButton: texts.searching,
                  roleLabel: texts.role,
                  roleHint: texts.roleHint,
                  saveLabel: texts.grantAccess,
                  confirmTitle: texts.confirmationTitle,
                  confirmDescription: (_name, role) => texts.confirmationText(role),
                  confirmButton: texts.grantPermanently,
                  closeLabel: dashboardCommonTexts().close,
                }}
                onSearch={(login) => searchTwitchUser(channelId, login).then((response) => response.user)}
                onGrant={(userId, role) => addChannelMember(channelId, userId, role).then(() => undefined)}
                errorText={errorMessage}
                onGranted={() => { void onReload(); }}
                onAuthenticationRequired={onAuthenticationRequired}
                onClose={closeGrant}
              />
            ) : null}
            onCloseInspector={closeFloating}
          />
        </div>
        {nextCursor == null ? null : <button className="button button--secondary" type="button" onClick={() => { void onLoadNextPage(); }} disabled={loading || loadingNextPage}>{loadingNextPage ? texts.loadingMore : texts.loadMore}</button>}
      </section>
      <ConfirmDialog
        opened={draftGuard.confirmOpen}
        title={texts.unsavedRoleTitle}
        description={texts.unsavedRoleDescription}
        cancelLabel={texts.continueEditing}
        alternative={{ label: texts.saveAndSwitch, onClick: () => { void draftGuard.saveAndSwitch(); } }}
        confirmLabel={texts.discardAndSwitch}
        danger
        {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
        onCancel={draftGuard.continueEditing}
        onConfirm={draftGuard.discardAndSwitch}
      />
    </>
  );
};
