import { useState, type ReactElement, type SyntheticEvent } from "react";

import type { PanelChannelRole, PanelMember, PanelTwitchUser } from "../panel-contract";
import { roleLabel } from "./labels";
import {
  addChannelMember,
  PanelApiError,
  removeChannelMember,
  searchTwitchUser,
  updateChannelMemberRole,
} from "./api";

interface MembersPageProperties {
  channelId: string;
  ownRole: PanelChannelRole;
  members: PanelMember[];
  nextCursor: string | null;
  loading: boolean;
  loadingNextPage: boolean;
  error: string | null;
  onReload: () => Promise<void>;
  onLoadNextPage: () => Promise<void>;
  onAuthenticationRequired: () => void;
}

const manageableRoles: readonly PanelChannelRole[] = ["broadcaster", "verwalter", "bediener"];

/** Der Beitritt liegt Tage bis Jahre zurueck; die Uhrzeit traegt dort nichts bei. */
const formatJoinDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("de-DE", { dateStyle: "medium" }).format(date);
};

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return "Deine Sitzung ist nicht mehr gültig.";
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Die Mitgliederänderung ist fehlgeschlagen.";
};

const canManage = (role: PanelChannelRole): boolean => role !== "bediener";

const memberLabel = (member: PanelMember): string =>
  member.displayName ?? (member.login === null ? "Nicht auflösbar" : `@${member.login}`);

const roleOptions = (): ReactElement[] =>
  manageableRoles.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>);

const accessConfirmation = (role: PanelChannelRole): string =>
  `Diese Person hat keinerlei Beziehung zum Kanal, die Twitch belegen würde. Mit der Rolle „${roleLabel(role)}“ erhält sie Zugriff auf die Mitgliederliste und auf die kanalbezogenen Panel-Funktionen, die diese Rolle erlaubt. Zugriff freigeben?`;

const MemberTable = ({
  members,
  canManageMembers,
  onRoleChange,
  onRemove,
  busyUserId,
}: {
  members: PanelMember[];
  canManageMembers: boolean;
  onRoleChange: (userId: string, role: PanelChannelRole) => void;
  onRemove: (member: PanelMember) => void;
  busyUserId: string | null;
}): ReactElement => {
  if (members.length === 0) return <p className="muted">Für diesen Kanal ist noch niemand zusätzlich freigegeben.</p>;
  return (
    <div className="member-table-wrap">
      <table className="member-table">
        <thead><tr><th scope="col">Name</th><th scope="col">Rolle</th><th scope="col">Beigetreten</th>{canManageMembers ? <th scope="col"><span className="sr-only">Aktionen</span></th> : null}</tr></thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <th scope="row">
                <span>{memberLabel(member)}</span>
                {member.displayName !== null && member.login !== null ? <span className="member-login">@{member.login}</span> : null}
                {member.displayName === null && member.login === null ? <span className="member-login">Twitch-ID {member.userId}</span> : null}
              </th>
              <td>
                {canManageMembers ? (
                  <select
                    aria-label={`Rolle für ${memberLabel(member)}`}
                    value={member.role}
                    disabled={busyUserId === member.userId}
                    onChange={(event) => onRoleChange(member.userId, event.target.value as PanelChannelRole)}
                  >
                    {roleOptions()}
                  </select>
                ) : roleLabel(member.role)}
              </td>
              <td className="zahl">{formatJoinDate(member.joinedAt)}</td>
              {canManageMembers ? <td><button className="button button--quiet" type="button" aria-label={`Zugriff für ${memberLabel(member)} entziehen`} disabled={busyUserId === member.userId} onClick={() => onRemove(member)}>Entziehen</button></td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export const MembersPage = ({
  channelId,
  ownRole,
  members,
  nextCursor,
  loading,
  loadingNextPage,
  error,
  onReload,
  onLoadNextPage,
  onAuthenticationRequired,
}: MembersPageProperties): ReactElement => {
  const [login, setLogin] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [foundUser, setFoundUser] = useState<PanelTwitchUser | null>(null);
  const [newRole, setNewRole] = useState<PanelChannelRole>("bediener");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const canManageMembers = canManage(ownRole);

  const handleSearch = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSearching(true);
    setSearchError(null);
    setFoundUser(null);
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
    if (foundUser === null || !window.confirm(accessConfirmation(newRole))) return;
    setBusyUserId(foundUser.userId);
    setActionError(null);
    try {
      await addChannelMember(channelId, foundUser.userId, newRole);
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

  const handleRoleChange = async (userId: string, role: PanelChannelRole): Promise<void> => {
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
    if (!window.confirm(`Zugriff für ${memberLabel(member)} wirklich entziehen? Die Person verliert den Zugang zu diesem Kanal und allen kanalbezogenen Panel-Daten und -Funktionen.`)) return;
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

  return (
    <>
      <header className="page-heading">
        <h1>Mitglieder</h1>
        <span className="muted zahl">{String(members.length)}</span>
      </header>
      {canManageMembers ? (
        <section className="content-section" aria-label="Mitglied hinzufügen">
          <div className="section-heading"><h2>Zugriff vergeben</h2></div>
          <form className="member-search-form" onSubmit={(event) => { void handleSearch(event); }}>
            <label htmlFor="member-search">Twitch-Name</label>
            <div className="member-search-row"><input id="member-search" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="off" /><button className="button" type="submit" disabled={searching || login.trim().length === 0}>{searching ? "Suche läuft …" : "Suchen"}</button></div>
          </form>
          {searchError === null ? null : <p className="form-error" role="alert">{searchError}</p>}
          {foundUser === null ? null : (
            <div className="member-search-result">
              <div><strong>{foundUser.displayName}</strong><span>@{foundUser.login} · Twitch-ID {foundUser.userId}</span></div>
              <label>Rolle<select aria-label="Rolle für neue Mitgliedschaft" value={newRole} onChange={(event) => setNewRole(event.target.value as PanelChannelRole)}>{roleOptions()}</select></label>
              <button className="button" type="button" onClick={() => { void handleAdd(); }} disabled={busyUserId === foundUser.userId}>Zugriff freigeben</button>
            </div>
          )}
        </section>
      ) : null}
      <section className="content-section" aria-label="Mitgliederliste">
        <div className="section-heading"><h2>Freigegebene Mitglieder</h2></div>
        {loading ? <p className="loading-line">Mitglieder werden geladen …</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
        {loading || error !== null ? null : <>
          <MemberTable members={members} canManageMembers={canManageMembers} onRoleChange={(userId, role) => { void handleRoleChange(userId, role); }} onRemove={(member) => { void handleRemove(member); }} busyUserId={busyUserId} />
          {nextCursor == null ? null : <button className="button button--secondary" type="button" onClick={() => { void onLoadNextPage(); }} disabled={loadingNextPage}>{loadingNextPage ? "Weitere Mitglieder werden geladen …" : "Weitere Mitglieder laden"}</button>}
        </>}
      </section>
    </>
  );
};
