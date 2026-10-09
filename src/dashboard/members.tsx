import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { CHANNEL_ROLES, canManage, type ChannelRole } from "../contracts/values";
import type { PanelMember } from "../panel-contract";
import { membersTexts, roleDescription, roleLabel } from "./labels";
import { apiErrorText, dashboardCommonTexts, dashboardTexts, formatDate } from "./locale";
import { ModuleHeading } from "./module-panels";
import { MemberAvatar } from "./member-avatar";
import { MemberGrantEditor } from "./member-grant-editor";
import { Button, ChoiceCards, ConfirmDialog, EditorShell, Icon, ListDetail, ListPaginationFooter, ListToolbar, LoadState, notify, QueryErrorState, useDraftGuard, useInspectorSelection } from "./ui";
import { dashboardDataKeys } from "./data/keys";
import { useMembersQuery } from "./data/lists";
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
  onAuthenticationRequired: () => void;
}

const manageableRoles = CHANNEL_ROLES;
const MEMBERS_PAGE_SIZE = 100;

/** The join date is days to years in the past; the time of day adds nothing there. */
const formatJoinDate = (value: string): string => formatDate(value);

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return membersTexts().sessionInvalid;
  const fallback = membersTexts().changeFailed;
  return error instanceof PanelApiError ? apiErrorText(error.code, fallback) : fallback;
};

const listErrorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return membersTexts().sessionInvalid;
  const fallback = dashboardTexts().errors.dataLoadFailed;
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
  broadcasterCount,
  selectedUserId,
  onSelect,
  rowRef,
}: {
  members: PanelMember[];
  broadcasterCount: number;
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
                    {isLastBroadcaster(member, broadcasterCount) ? <span className="table-lock" role="img" aria-label={texts.lastBroadcaster} title={texts.lastBroadcaster}><Icon name="lock" size={16} /></span> : null}
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

const MemberListSkeleton = (): ReactElement => (
  <div className="table-wrap members-page__skeleton">
    <table className="table members-table" aria-hidden="true">
      <thead className="sr-only"><tr><th scope="col" /></tr></thead>
      <tbody>{Array.from({ length: MEMBERS_PAGE_SIZE }, (_, index) => (
        <tr key={index}>
          <th scope="row"><div className="avatar-row">
            <span className="members-page__skeleton-avatar" />
            <div><span className="members-page__skeleton-line members-page__skeleton-line--name" /><span className="members-page__skeleton-line members-page__skeleton-line--login" /></div>
          </div></th>
          <td><span className="members-page__skeleton-line members-page__skeleton-line--role" /></td>
          <td><span className="members-page__skeleton-line members-page__skeleton-line--date" /></td>
        </tr>
      ))}</tbody>
    </table>
    <span className="sr-only">{membersTexts().load}</span>
  </div>
);

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
        destructive={<span title={locked ?? undefined}><Button danger="subtle" icon="memberRemove" disabled={locked !== null} onClick={() => { setRemoveConfirmOpen(true); }}>{texts.remove}</Button></span>}
      />
      <ConfirmDialog
        opened={removeConfirmOpen}
        title={texts.removeConfirmTitle(name)}
        description={member.userId === ownUserId ? texts.removeSelf : texts.removeOther(name)}
        confirmLabel={texts.removeAccessFor(name)}
        cancelLabel={common.cancel}
        danger
        onCancel={() => { setRemoveConfirmOpen(false); }}
        onConfirm={() => { setRemoveConfirmOpen(false); onRemove(); }}
      />
    </>
  );
};

export const MembersPage = (properties: MembersPageProperties): ReactElement =>
  <MembersPageContent key={properties.channelId} {...properties} />;

const MembersPageContent = ({
  channelId,
  ownRole,
  onAuthenticationRequired,
}: MembersPageProperties): ReactElement => {
  const queryClient = useQueryClient();
  const membersQuery = useMembersQuery(channelId);
  const membersQueryKey = dashboardDataKeys.members(channelId);
  const queryFilter = { queryKey: membersQueryKey, exact: true } as const;
  const memberPages = membersQuery.data?.pages;
  const members = useMemo(
    () => [...new Map((memberPages ?? []).flatMap((page) => page.members).map((member) => [member.userId, member])).values()],
    [memberPages],
  );
  const latestPage = memberPages?.at(-1);
  const broadcasterCount = latestPage?.broadcasterCount ?? 0;
  const ownUserId = latestPage?.viewerUserId ?? "";
  const nextCursor = membersQuery.isPlaceholderData ? null : latestPage?.nextCursor ?? null;
  const loading = membersQuery.isPending;
  const fetching = membersQuery.isFetching && !membersQuery.isFetchingNextPage;
  const error = membersQuery.isError ? listErrorMessage(membersQuery.error) : null;
  useEffect(() => {
    if (!membersQuery.isError) return;
    notify({ tone: "error", message: listErrorMessage(membersQuery.error) });
  }, [membersQuery.error, membersQuery.isError]);
  const refreshMembers = async (): Promise<void> => {
    await queryClient.cancelQueries(queryFilter);
    await queryClient.invalidateQueries(queryFilter);
  };
  const texts = membersTexts();
  const canManageMembers = canManage(ownRole);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [grantOpen, setGrantOpen] = useState(false);
  const grantButtonRef = useRef<HTMLButtonElement | null>(null);
  const [roleDraft, setRoleDraft] = useState<{ userId: string; role: ChannelRole } | null>(null);
  const { selectedKey: selectedUserId, select: selectMember, rowRef, close: closeSelection } = useInspectorSelection<string>(channelId);

  useEffect(() => {
    if (selectedUserId !== null && !members.some((member) => member.userId === selectedUserId)) closeSelection();
  }, [members, selectedUserId, closeSelection]);

  const selectedMember = members.find((member) => member.userId === selectedUserId) ?? null;
  const query = search.trim().toLocaleLowerCase();
  const visibleMembers = query.length === 0 ? members : members.filter((member) => [
    member.displayName,
    member.login,
    roleLabel(member.role),
  ].some((value) => value?.toLocaleLowerCase().includes(query) === true));
  const draftRole = selectedMember !== null && roleDraft?.userId === selectedMember.userId ? roleDraft.role : selectedMember?.role ?? "operator";
  const roleDirty = selectedMember !== null && roleDraft !== null && roleDraft.userId === selectedMember.userId && roleDraft.role !== selectedMember.role;

  const saveRoleDraft = async (): Promise<string | null> => {
    if (selectedMember === null || roleDraft === null || !roleDirty) return null;
    setBusyUserId(roleDraft.userId);
    try {
      await queryClient.cancelQueries(queryFilter);
      await updateChannelMemberRole(channelId, roleDraft.userId, roleDraft.role);
      setRoleDraft(null);
      await queryClient.invalidateQueries(queryFilter);
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
    try {
      await queryClient.cancelQueries(queryFilter);
      await removeChannelMember(channelId, member.userId);
      closeSelection();
      await queryClient.invalidateQueries(queryFilter);
    } catch (error: unknown) {
      notify({ tone: "error", message: errorMessage(error) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <>
      <ModuleHeading kind="members" title={texts.title} subtitle="" />
      <section className="content-section" aria-label={texts.membersWithAccess}>
        <div className="section-heading">
          <h2>{texts.membersWithAccess}</h2>
        </div>
        <div>
          <ListDetail
            list={<div className="members-page__list-column">
              <ListToolbar
                searchLabel={texts.searchMembers}
                searchPlaceholder={texts.searchMembers}
                searchClearLabel={dashboardCommonTexts().clearSearch}
                searchValue={search}
                onSearchChange={setSearch}
                create={{ label: texts.grantAccessTitle, ref: grantButtonRef, onClick: openGrant, disabled: !canManageMembers, ...(!canManageMembers ? { reason: texts.managementLocked } : {}) }}
                usage={{
                  count: members.length,
                  ...(query.length > 0 ? { filteredCount: visibleMembers.length } : { loaded: true }),
                  copy: { countSuffix: texts.countSuffix, filteredInfix: dashboardCommonTexts().of, filteredSuffix: texts.filteredSuffix, limitInfix: dashboardCommonTexts().of, limitSuffix: "", loadedSuffix: dashboardCommonTexts().loaded },
                }}
                {...(query.length === 0 ? {} : { activeFilters: `${texts.searchMembers}: ${search.trim()}`, activeFiltersLabel: dashboardCommonTexts().activeFilters, resetLabel: dashboardCommonTexts().reset, onReset: () => { setSearch(""); } })}
              />
              <div className={fetching ? "stale" : undefined} aria-busy={fetching}>
              <LoadState
                status={members.length > 0 ? visibleMembers.length === 0 ? "empty" : "success" : error !== null ? "error" : loading ? "loading" : "empty"}
                minHeight={320}
                loading={<MemberListSkeleton />}
                empty={members.length > 0 ? <p className="empty-state">{dashboardCommonTexts().noMatches}</p> : <MemberList members={members} broadcasterCount={broadcasterCount} selectedUserId={selectedUserId} onSelect={selectMemberGuarded} rowRef={rowRef} />}
                error={<QueryErrorState
                  title={dashboardTexts().errors.dataLoadFailed}
                  reason={error ?? texts.load}
                  retryLabel={dashboardCommonTexts().retry}
                  onRetry={() => { void membersQuery.refetch(); }}
                />}
              >{members.length === 0 ? null : <MemberList members={visibleMembers} broadcasterCount={broadcasterCount} selectedUserId={selectedUserId} onSelect={selectMemberGuarded} rowRef={rowRef} />}</LoadState>
              </div>
              {members.length === 0 && nextCursor === null ? null : <ListPaginationFooter loadedCount={members.length} loadedLabel={texts.loaded}>
                {nextCursor === null ? null : <button className="button button--secondary" type="button" onClick={() => { void membersQuery.fetchNextPage(); }} disabled={loading || membersQuery.isFetching || membersQuery.isPlaceholderData}>{membersQuery.isFetchingNextPage ? texts.loadingMore : texts.loadMore}</button>}
              </ListPaginationFooter>}
            </div>}
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
                onGrant={async (userId, role) => {
                  await queryClient.cancelQueries(queryFilter);
                  await addChannelMember(channelId, userId, role);
                }}
                errorText={errorMessage}
                onGranted={() => { void refreshMembers(); }}
                onAuthenticationRequired={onAuthenticationRequired}
                onClose={closeGrant}
              />
            ) : null}
            onCloseInspector={closeFloating}
          />
        </div>
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
