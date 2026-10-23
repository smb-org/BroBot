import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import "./members.css";

import { CHANNEL_ROLES, canManage, type ChannelRole } from "../contracts/values";
import type { PanelMember } from "../panel-contract";
import { membersTexts, roleDescription, roleLabel } from "./labels";
import { apiErrorText, dashboardCommonTexts, dashboardTexts, formatDate } from "./locale";
import { MemberAvatar } from "./member-avatar";
import { Button, ChoiceCards, ConfirmDialog, EditorShell, Icon, Badge, CollectionPage, EmptyState, ListRow, ListToolbar, LoadState, LoadStateLines, notify, registerDashboardNavigationGuard, useDraftGuard, useInspectorSelection } from "./ui";
import { TruncatedText } from "./ui/TruncatedText";
import { dashboardDataKeys } from "./data/keys";
import { useMembersQuery } from "./data/lists";
import { dashboardRoutePath } from "./router";
import { MemberInviteDialog } from "./member-invite-dialog";
import { RoleMatrixDisclosure } from "./role-matrix";
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

const manageableRoles = (ownRole: ChannelRole): readonly ChannelRole[] => ownRole === "broadcaster"
  ? CHANNEL_ROLES
  : CHANNEL_ROLES.filter((role) => role !== "broadcaster");
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

const memberRoleLocked = (member: PanelMember, ownRole: ChannelRole, broadcasterCount: number): string | null =>
  removalLocked(member, broadcasterCount)
    ?? (member.role === "broadcaster" && ownRole !== "broadcaster" ? membersTexts().broadcasterRoleLocked : null);

/**
 * Role values that actually go through for this entry. The own role
 * cannot be raised, and the last broadcaster cannot be demoted.
 */
const selectableRoles = (
  member: PanelMember,
  ownUserId: string,
  ownRole: ChannelRole,
  broadcasterCount: number,
  availableRoles: readonly ChannelRole[],
): readonly ChannelRole[] => {
  if (member.role === "broadcaster" && ownRole !== "broadcaster") return [member.role];
  if (isLastBroadcaster(member, broadcasterCount)) return [member.role];
  if (member.userId !== ownUserId) return availableRoles;
  const rank: Record<ChannelRole, number> = { operator: 0, manager: 1, broadcaster: 2 };
  return availableRoles.filter((role) => rank[role] <= rank[member.role]);
};

const memberLabel = (member: PanelMember): string =>
  member.displayName ?? (member.login === null ? membersTexts().unresolvable : `@${member.login}`);

const MemberList = ({
  channelId,
  members,
  ownRole,
  broadcasterCount,
  selectedUserId,
  onSelect,
}: {
  channelId: string;
  members: PanelMember[];
  ownRole: ChannelRole;
  broadcasterCount: number;
  selectedUserId: string | null;
  onSelect: (userId: string) => void;
}): ReactElement => {
  const texts = membersTexts();
  if (members.length === 0) return <EmptyState title={texts.membersWithAccess} description={texts.empty} />;
  return (
    <div className="members-collection__rows">
      {members.map((member) => {
        const selected = selectedUserId === member.userId;
        const identity = member.login === null ? texts.twitchId(member.userId) : `@${member.login}`;
        const description = texts.memberRowDescription(identity, formatJoinDate(member.joinedAt));
        const lockReason = memberRoleLocked(member, ownRole, broadcasterCount);
        return <ListRow
          key={member.userId}
          href={dashboardRoutePath({ kind: "channel", channelId, section: "members" })}
          onNavigate={() => { onSelect(member.userId); }}
          icon={<MemberAvatar src={member.profileImageUrl} name={member.displayName ?? member.login ?? member.userId} />}
          title={<TruncatedText text={memberLabel(member)} />}
          description={<TruncatedText text={description} />}
          status={<Badge tone={member.role === "broadcaster" ? "brand" : member.role === "manager" ? "green" : "neutral"}>
            <span className="members-collection__role" {...(lockReason === null ? {} : { title: lockReason, "aria-label": `${roleLabel(member.role)}. ${lockReason}` })}>
              {roleLabel(member.role)}{lockReason === null ? null : <Icon name="lock" size={16} aria-hidden="true" />}
            </span>
          </Badge>}
          action={<span aria-hidden="true" />}
          selected={selected}
        />;
      })}
    </div>
  );
};

const MemberListLoading = (): ReactElement => <><LoadStateLines rows={MEMBERS_PAGE_SIZE} height={58} /><span className="sr-only">{membersTexts().load}</span></>;

/**
 * The member editor (15b): a role `ChoiceCards` as the only draft field,
 * "Zugang entziehen" left in the save status behind its own `ConfirmDialog`.
 * `role`/`dirty`/`onRoleChange` are controlled by `MembersPage` so its
 * `useDraftGuard` (row switch, grant editor, close) can see the same draft.
 */
const MemberInspector = ({
  member,
  canManageMembers,
  broadcasterCount,
  ownUserId,
  ownRole,
  availableRoles,
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
  ownRole: ChannelRole;
  availableRoles: readonly ChannelRole[];
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
  const roles = selectableRoles(member, ownUserId, ownRole, broadcasterCount, availableRoles);
  const locked = memberRoleLocked(member, ownRole, broadcasterCount);
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
        className="member-editor"
        ariaLabel={texts.editMember(name)}
        title={name}
        identifier={formatJoinDate(member.joinedAt)}
        sections={[]}
        readOnly={{ reason: texts.managementLocked, content: <>{propertiesList}<RoleMatrixDisclosure /></> }}
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
        className="member-editor"
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
        }, {
          id: "permissions",
          label: texts.roleMatrixTitle,
          content: <RoleMatrixDisclosure />,
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
    if (!membersQuery.isError || membersQuery.data === undefined) return;
    notify({ tone: "error", message: listErrorMessage(membersQuery.error) });
  }, [membersQuery.data, membersQuery.error, membersQuery.isError]);
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
  const { selectedKey: selectedUserId, select: selectMember, close: closeSelection } = useInspectorSelection<string>(channelId);

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

  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);

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

  const availableRoles = manageableRoles(ownRole);
  const list = <div className={fetching ? "stale" : undefined} aria-busy={fetching}>
    <LoadState
      variant="panel-320"
      status={members.length > 0 ? visibleMembers.length === 0 ? "empty" : "success" : error !== null ? "error" : loading ? "loading" : "empty"}
      loading={<MemberListLoading />}
      empty={members.length > 0
        ? <p className="empty-state">{dashboardCommonTexts().noMatches}</p>
        : <MemberList channelId={channelId} members={members} ownRole={ownRole} broadcasterCount={broadcasterCount} selectedUserId={selectedUserId} onSelect={selectMemberGuarded} />}
      error={<p role="alert">{error ?? texts.load}</p>}
      queryError={{ title: dashboardTexts().errors.dataLoadFailed, message: error ?? texts.load, onRetry: () => { void membersQuery.refetch(); } }}
    >{members.length === 0 ? null : <MemberList channelId={channelId} members={visibleMembers} ownRole={ownRole} broadcasterCount={broadcasterCount} selectedUserId={selectedUserId} onSelect={selectMemberGuarded} />}</LoadState>
    {nextCursor === null ? null : <div className="members-collection__load-more">
      <Button variant="neutral" onClick={() => { void membersQuery.fetchNextPage(); }} disabled={loading || membersQuery.isFetching || membersQuery.isPlaceholderData}>{membersQuery.isFetchingNextPage ? texts.loadingMore : texts.loadMore}</Button>
    </div>}
  </div>;
  const selectedDetail = selectedMember === null ? <p className="members-collection__empty">{texts.selectMemberPrompt}</p> : <MemberInspector
    key={selectedMember.userId}
    member={selectedMember}
    canManageMembers={canManageMembers}
    broadcasterCount={broadcasterCount}
    ownUserId={ownUserId}
    ownRole={ownRole}
    availableRoles={availableRoles}
    role={draftRole}
    dirty={roleDirty}
    onRoleChange={(role) => { setRoleDraft({ userId: selectedMember.userId, role }); }}
    pending={busyUserId === selectedMember.userId}
    onSave={() => { void saveRoleDraft(); }}
    onDiscard={() => { setRoleDraft(null); }}
    onRemove={() => { void handleRemove(selectedMember); }}
    onClose={closeFloating}
  />;

  return (
    <>
      <CollectionPage
        title={texts.title}
        headerKind="members"
        subtitle={texts.description}
        toolbar={<ListToolbar
          className="members-list-toolbar"
          searchLabel={texts.searchMembers}
          searchPlaceholder={texts.searchMembers}
          searchClearLabel={dashboardCommonTexts().clearSearch}
          searchValue={search}
          onSearchChange={setSearch}
          createPlacement="after-search"
          create={{ label: texts.grantAccessTitle, ref: grantButtonRef, onClick: openGrant, disabled: !canManageMembers, ...(!canManageMembers ? { reason: texts.managementLocked } : {}) }}
          usage={{
            count: members.length,
            ...(query.length > 0 ? { filteredCount: visibleMembers.length } : { loaded: true }),
            copy: { countSuffix: texts.countSuffix, filteredInfix: dashboardCommonTexts().of, filteredSuffix: texts.filteredSuffix, limitInfix: dashboardCommonTexts().of, limitSuffix: "", loadedSuffix: dashboardCommonTexts().loaded },
          }}
          {...(error === null || members.length === 0 ? {} : { queryError: {
            title: dashboardTexts().errors.dataLoadFailed,
            message: error,
            onRetry: () => { void membersQuery.refetch(); },
          } })}
          {...(query.length === 0 ? {} : { activeFilters: `${texts.searchMembers}: ${search.trim()}`, activeFiltersLabel: dashboardCommonTexts().activeFilters, resetLabel: dashboardCommonTexts().reset, onReset: () => { setSearch(""); } })}
        />}
        list={list}
        detail={selectedDetail}
        detailOpen={selectedMember !== null}
        backLabel={texts.inviteBack}
        closeDetailDisabled={roleDirty && busyUserId !== null}
        onCloseDetail={closeFloating}
      />
      <MemberInviteDialog
        opened={grantOpen}
        roles={availableRoles}
        defaultRole="operator"
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
