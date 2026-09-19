import { useState, type ReactElement, type SyntheticEvent } from "react";

import type { PanelChannelRole, PanelMember, PanelTwitchUser } from "../panel-contract";
import { roleLabel } from "./labels";
import { formatDatum } from "./locale";
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
  /** Eigene Twitch-User-ID, um den eigenen Eintrag zu erkennen. */
  eigeneUserId: string;
  members: PanelMember[];
  /** Broadcaster im gesamten Kanal, nicht auf dieser Seite. */
  broadcasterCount: number;
  nextCursor: string | null;
  loading: boolean;
  loadingNextPage: boolean;
  error: string | null;
  onReload: () => Promise<void>;
  onLoadNextPage: () => Promise<void>;
  onAuthenticationRequired: () => void;
}

const manageableRoles: readonly PanelChannelRole[] = ["broadcaster", "verwalter", "bediener"];

const texte = {
  verwaltungGesperrt: "Nur Broadcaster und Verwalter dürfen Mitglieder ändern.",
  zugriffVergeben: "Zugriff vergeben",
  twitchName: "Twitch-Name",
  suchen: "Suchen",
  sucheLaeuft: "Suche läuft …",
};

/** Der Beitritt liegt Tage bis Jahre zurueck; die Uhrzeit traegt dort nichts bei. */
const formatJoinDate = (value: string): string => formatDatum(value);

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return "Deine Sitzung ist nicht mehr gültig.";
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Die Mitgliederänderung ist fehlgeschlagen.";
};

const canManage = (role: PanelChannelRole): boolean => role !== "bediener";

/**
 * Was der Worker ablehnen würde, bietet die Oberfläche nicht als Möglichkeit
 * an. Ein Knopf, der garantiert scheitert, sieht aus wie eine Option — man
 * muss ihn drücken, um zu erfahren, dass es keine ist.
 *
 * Gesperrt wird mit Begründung statt versteckt: Ein verschwundener Knopf wirft
 * die Frage auf, ob etwas kaputt ist; ein gesperrter mit Grund beantwortet sie.
 *
 * Die Prüfung im Worker bleibt davon unberührt. Das hier ist Komfort, keine
 * Sicherheitsgrenze.
 */
const letzterBroadcaster = (member: PanelMember, broadcasterCount: number): boolean =>
  member.role === "broadcaster" && broadcasterCount <= 1;

const entzugGesperrt = (member: PanelMember, broadcasterCount: number): string | null =>
  letzterBroadcaster(member, broadcasterCount)
    ? "Der letzte Broadcaster dieses Kanals kann nicht entfernt werden."
    : null;

/**
 * Rollenwerte, die für diesen Eintrag tatsächlich durchgehen. Die eigene Rolle
 * lässt sich nicht erhöhen, und der letzte Broadcaster nicht herabstufen.
 */
const waehlbareRollen = (
  member: PanelMember,
  eigeneUserId: string,
  broadcasterCount: number,
): readonly PanelChannelRole[] => {
  if (letzterBroadcaster(member, broadcasterCount)) return [member.role];
  if (member.userId !== eigeneUserId) return manageableRoles;
  const rang: Record<PanelChannelRole, number> = { bediener: 0, verwalter: 1, broadcaster: 2 };
  return manageableRoles.filter((rolle) => rang[rolle] <= rang[member.role]);
};

const memberLabel = (member: PanelMember): string =>
  member.displayName ?? (member.login === null ? "Nicht auflösbar" : `@${member.login}`);

const roleOptions = (rollen: readonly PanelChannelRole[] = manageableRoles): ReactElement[] =>
  rollen.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>);

const accessConfirmation = (role: PanelChannelRole): string =>
  `Diese Person hat keinerlei Beziehung zum Kanal, die Twitch belegen würde. Mit der Rolle „${roleLabel(role)}“ erhält sie Zugriff auf die Mitgliederliste und auf die kanalbezogenen Panel-Funktionen, die diese Rolle erlaubt. Zugriff freigeben?`;

const MemberTable = ({
  members,
  canManageMembers,
  broadcasterCount,
  eigeneUserId,
  onRoleChange,
  onRemove,
  busyUserId,
}: {
  members: PanelMember[];
  canManageMembers: boolean;
  broadcasterCount: number;
  eigeneUserId: string;
  onRoleChange: (userId: string, role: PanelChannelRole) => void;
  onRemove: (member: PanelMember) => void;
  busyUserId: string | null;
}): ReactElement => {
  if (members.length === 0) return <p className="muted">Für diesen Kanal ist noch niemand zusätzlich freigegeben.</p>;
  const verwaltungGesperrt = canManageMembers ? null : texte.verwaltungGesperrt;
  return (
    <div className="member-table-wrap">
      <table className="member-table">
        <thead><tr><th scope="col">Name</th><th scope="col">Rolle</th><th scope="col" aria-sort="descending">Zugriff seit</th><th scope="col"><span className="sr-only">Aktionen</span></th></tr></thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <th scope="row">
                <span>{memberLabel(member)}</span>
                {member.displayName !== null && member.login !== null ? (
                  <a
                    className="member-login member-profile-link"
                    href={`https://twitch.tv/${member.login}`}
                    target="_blank"
                    rel="noreferrer noopener"
                  >twitch.tv/{member.login}</a>
                ) : null}
                {member.displayName === null && member.login === null ? <span className="member-login">Twitch-ID {member.userId}</span> : null}
              </th>
              <td>
                <select
                  aria-label={`Rolle für ${memberLabel(member)}`}
                  value={member.role}
                  disabled={!canManageMembers || busyUserId === member.userId || letzterBroadcaster(member, broadcasterCount)}
                  title={verwaltungGesperrt ?? entzugGesperrt(member, broadcasterCount) ?? undefined}
                  onChange={(event) => onRoleChange(member.userId, event.target.value as PanelChannelRole)}
                >
                  {roleOptions(waehlbareRollen(member, eigeneUserId, broadcasterCount))}
                </select>
              </td>
              <td className="zahl">{formatJoinDate(member.joinedAt)}</td>
              <td>
                <button
                  className="button button--quiet"
                  type="button"
                  aria-label={`Zugriff für ${memberLabel(member)} entziehen`}
                  disabled={!canManageMembers || busyUserId === member.userId || entzugGesperrt(member, broadcasterCount) !== null}
                  title={verwaltungGesperrt ?? entzugGesperrt(member, broadcasterCount) ?? undefined}
                  onClick={() => onRemove(member)}
                >Entziehen</button>
                {verwaltungGesperrt !== null
                  ? <span className="sperrgrund">{verwaltungGesperrt}</span>
                  : entzugGesperrt(member, broadcasterCount) === null
                    ? null
                    : <span className="sperrgrund">Letzter Broadcaster</span>}
              </td>
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
  eigeneUserId,
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
    const selbst = member.userId === eigeneUserId;
    const frage = selbst
      ? `Deinen eigenen Zugang zu diesem Kanal wirklich entziehen? Du sperrst dich damit selbst aus und kommst nur über eine andere berechtigte Person zurück.`
      : `Zugriff für ${memberLabel(member)} wirklich entziehen? Die Person verliert den Zugang zu diesem Kanal und allen kanalbezogenen Panel-Daten und -Funktionen.`;
    if (!window.confirm(frage)) return;
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
      <section className="content-section" aria-label="Mitglied hinzufügen">
        <div className="section-heading"><h2>{texte.zugriffVergeben}</h2></div>
        {!canManageMembers ? <p className="sperrgrund">{texte.verwaltungGesperrt}</p> : null}
        <form className="member-search-form" onSubmit={(event) => { void handleSearch(event); }}>
          <label htmlFor="member-search">{texte.twitchName}</label>
          <div className="member-search-row"><input id="member-search" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="off" disabled={!canManageMembers} title={!canManageMembers ? texte.verwaltungGesperrt : undefined} /><button className="button" type="submit" disabled={!canManageMembers || searching || login.trim().length === 0} title={!canManageMembers ? texte.verwaltungGesperrt : undefined}>{searching ? texte.sucheLaeuft : texte.suchen}</button></div>
        </form>
        {!canManageMembers && foundUser === null ? <div><button className="button" type="button" disabled title={texte.verwaltungGesperrt}>Zugriff freigeben</button><span className="sperrgrund">{texte.verwaltungGesperrt}</span></div> : null}
        {searchError === null ? null : <p className="form-error" role="alert">{searchError}</p>}
        {foundUser === null ? null : (
          <div className="member-search-result">
            <div><strong>{foundUser.displayName}</strong><span>@{foundUser.login} · Twitch-ID {foundUser.userId}</span></div>
            <label>Rolle<select aria-label="Rolle für neue Mitgliedschaft" value={newRole} onChange={(event) => setNewRole(event.target.value as PanelChannelRole)}>{roleOptions()}</select></label>
            <button className="button" type="button" onClick={() => { void handleAdd(); }} disabled={busyUserId === foundUser.userId}>Zugriff freigeben</button>
          </div>
        )}
      </section>
      <section className="content-section" aria-label="Mitgliederliste">
        <div className="section-heading"><h2>Freigegebene Mitglieder</h2></div>
        {loading ? <p className="loading-line">Mitglieder werden geladen …</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
        {loading || error !== null ? null : <>
          <MemberTable members={members} canManageMembers={canManageMembers} broadcasterCount={broadcasterCount} eigeneUserId={eigeneUserId} onRoleChange={(userId, role) => { void handleRoleChange(userId, role); }} onRemove={(member) => { void handleRemove(member); }} busyUserId={busyUserId} />
          {nextCursor == null ? null : <button className="button button--secondary" type="button" onClick={() => { void onLoadNextPage(); }} disabled={loadingNextPage}>{loadingNextPage ? "Weitere Mitglieder werden geladen …" : "Weitere Mitglieder laden"}</button>}
        </>}
      </section>
    </>
  );
};
