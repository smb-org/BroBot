import { useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";

import { CHANNEL_ROLES, type ChannelRole } from "../contracts/values";
import type { PanelMember, PanelTwitchUser } from "../panel-contract";
import { roleLabel } from "./labels";
import { dashboardGemeinsameTexte, dashboardLanguage, type DashboardLanguage, type LocaleCatalog, formatDatum } from "./locale";
import { ModuleCount, ModuleHeading } from "./module-panels";
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

const manageableRoles = CHANNEL_ROLES;

/** Der Beitritt liegt Tage bis Jahre zurück; die Uhrzeit trägt dort nichts bei. */
const formatJoinDate = (value: string): string => formatDatum(value);

interface MembersTexte {
  verwaltungGesperrt: string;
  zugriffVergeben: string;
  twitchName: string;
  suchen: string;
  sucheLaeuft: string;
  titel: string;
  count: (anzahl: string) => string;
  name: string;
  rolle: string;
  zugriffSeit: string;
  aktionen: string;
  entziehen: string;
  letzterBroadcaster: string;
  nichtAufloesbar: string;
  twitchId: (userId: string) => string;
  rolleFuer: (name: string) => string;
  zugriffEntziehen: (name: string) => string;
  leer: string;
  zugriffFreigeben: string;
  neueRolle: string;
  bestaetigungTitel: (name: string) => string;
  bestaetigung: (rolle: string) => string;
  endgueltigFreigeben: string;
  freigegebeneMitglieder: string;
  laden: string;
  weitereLaden: string;
  weitereWerdenGeladen: string;
  sitzungUngueltig: string;
  aenderungFehlgeschlagen: string;
  selbstEntfernen: string;
  fremdenEntfernen: (name: string) => string;
}

const texte: LocaleCatalog<MembersTexte> = {
  de: {
    verwaltungGesperrt: "Nur Broadcaster und Verwalter dürfen Mitglieder ändern.", zugriffVergeben: "Zugriff vergeben",
    twitchName: "Twitch-Name", suchen: "Suchen", sucheLaeuft: "Suche läuft …", titel: "Mitglieder", count: (anzahl) => `${anzahl} Mitglieder`, name: "Name",
    rolle: "Rolle", zugriffSeit: "Zugriff seit", aktionen: "Aktionen", entziehen: "Entziehen",
    letzterBroadcaster: "Letzter Broadcaster", nichtAufloesbar: "Nicht auflösbar", twitchId: (userId) => `Twitch-ID ${userId}`,
    rolleFuer: (name) => `Rolle für ${name}`, zugriffEntziehen: (name) => `Zugriff für ${name} entziehen`,
    leer: "Für diesen Kanal ist noch niemand zusätzlich freigegeben.", zugriffFreigeben: "Zugriff freigeben",
    neueRolle: "Rolle für neue Mitgliedschaft", bestaetigungTitel: (name) => `Zugriff für ${name} freigeben?`,
    bestaetigung: (rolle) => `Diese Person hat keinerlei Beziehung zum Kanal, die Twitch belegen würde. Mit der Rolle „${rolle}“ erhält sie Zugriff auf die Mitgliederliste und auf die kanalbezogenen Panel-Funktionen, die diese Rolle erlaubt.`,
    endgueltigFreigeben: "Zugriff endgültig freigeben", freigegebeneMitglieder: "Freigegebene Mitglieder",
    laden: "Mitglieder werden geladen …", weitereLaden: "Weitere Mitglieder laden", weitereWerdenGeladen: "Weitere Mitglieder werden geladen …",
    sitzungUngueltig: "Deine Sitzung ist nicht mehr gültig.", aenderungFehlgeschlagen: "Die Mitgliederänderung ist fehlgeschlagen.",
    selbstEntfernen: "Deinen eigenen Zugang zu diesem Kanal wirklich entziehen? Du sperrst dich damit selbst aus und kommst nur über eine andere berechtigte Person zurück.",
    fremdenEntfernen: (name) => `Zugriff für ${name} wirklich entziehen? Die Person verliert den Zugang zu diesem Kanal und allen kanalbezogenen Panel-Daten und -Funktionen.`,
  },
  en: {
    verwaltungGesperrt: "Only broadcasters and managers may change members.", zugriffVergeben: "Grant access", twitchName: "Twitch name",
    suchen: "Search", sucheLaeuft: "Searching …", titel: "Members", count: (anzahl) => `${anzahl} members`, name: "Name", rolle: "Role", zugriffSeit: "Access since",
    aktionen: "Actions", entziehen: "Remove", letzterBroadcaster: "Last broadcaster", nichtAufloesbar: "Unresolvable",
    twitchId: (userId) => `Twitch ID ${userId}`, rolleFuer: (name) => `Role for ${name}`, zugriffEntziehen: (name) => `Remove access for ${name}`,
    leer: "No one else has access to this channel yet.", zugriffFreigeben: "Grant access", neueRolle: "Role for new membership",
    bestaetigungTitel: (name) => `Grant access for ${name}?`, bestaetigung: (rolle) => `This person has no Twitch relationship proving access to this channel. The ${rolle} role grants access to the member list and the channel features allowed by that role.`,
    endgueltigFreigeben: "Grant access permanently", freigegebeneMitglieder: "Members with access",
    laden: "Loading members …", weitereLaden: "Load more members", weitereWerdenGeladen: "Loading more members …",
    sitzungUngueltig: "Your session is no longer valid.", aenderungFehlgeschlagen: "The member change failed.",
    selbstEntfernen: "Remove your own access to this channel? This locks you out and you can return only through another authorized person.",
    fremdenEntfernen: (name) => `Remove access for ${name}? This person will lose access to this channel and all channel-specific panel data and features.`,
  },
};

const membersTexte = (language: DashboardLanguage = dashboardLanguage()): MembersTexte => texte[language];

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return membersTexte().sitzungUngueltig;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return membersTexte().aenderungFehlgeschlagen;
};

const canManage = (role: ChannelRole): boolean => role !== "operator";

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
    ? membersTexte().letzterBroadcaster
    : null;

/**
 * Rollenwerte, die für diesen Eintrag tatsächlich durchgehen. Die eigene Rolle
 * lässt sich nicht erhöhen, und der letzte Broadcaster nicht herabstufen.
 */
const waehlbareRollen = (
  member: PanelMember,
  eigeneUserId: string,
  broadcasterCount: number,
): readonly ChannelRole[] => {
  if (letzterBroadcaster(member, broadcasterCount)) return [member.role];
  if (member.userId !== eigeneUserId) return manageableRoles;
  const rang: Record<ChannelRole, number> = { operator: 0, manager: 1, broadcaster: 2 };
  return manageableRoles.filter((rolle) => rang[rolle] <= rang[member.role]);
};

const memberLabel = (member: PanelMember): string =>
  member.displayName ?? (member.login === null ? membersTexte().nichtAufloesbar : `@${member.login}`);

const roleOptions = (rollen: readonly ChannelRole[] = manageableRoles): ReactElement[] =>
  rollen.map((role) => <option key={role} value={role}>{roleLabel(role)}</option>);

const accessConfirmation = (role: ChannelRole): string =>
  membersTexte().bestaetigung(roleLabel(role));

/**
 * `src` darf auch fehlen, nicht nur `null` sein: Während eines Deploys kann
 * ein neues Panel-Bündel mit einem älteren Worker sprechen, der das Feld noch
 * nicht liefert. Ein fehlendes Bild darf die Seite nicht abräumen.
 */
const MemberAvatar = ({ src }: { src: string | null | undefined }): ReactElement => {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (src === null || src === undefined || src.length === 0 || failedSource === src) {
    return <span className="member-avatar-placeholder" aria-hidden="true" />;
  }
  return <img className="member-avatar" src={src} alt="" aria-hidden="true" onError={() => setFailedSource(src)} />;
};

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
  onRoleChange: (userId: string, role: ChannelRole) => void;
  onRemove: (member: PanelMember) => void;
  busyUserId: string | null;
}): ReactElement => {
  const texte = membersTexte();
  if (members.length === 0) return <p className="muted">{texte.leer}</p>;
  const verwaltungGesperrt = canManageMembers ? null : texte.verwaltungGesperrt;
  return (
    <div className="tabelle-wrap">
      <table className="tabelle mitglieder-tabelle">
        <thead className="sr-only"><tr role="row"><th scope="col" role="columnheader">{texte.name}</th><th scope="col" role="columnheader">{texte.rolle}</th><th scope="col" role="columnheader" aria-sort="descending">{texte.zugriffSeit}</th><th scope="col" role="columnheader" className="tabelle__aktion"><span className="sr-only">{texte.aktionen}</span></th></tr></thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId} role="row">
              <th scope="row" role="rowheader">
                <div className="avatar-row">
                  <MemberAvatar src={member.profileImageUrl} />
                  <div>
                    <span>{memberLabel(member)}</span>
                    {member.displayName !== null && member.login !== null ? (
                      <a
                        className="login-hinweis profile-link"
                        href={`https://twitch.tv/${member.login}`}
                        target="_blank"
                        rel="noreferrer noopener"
                      >twitch.tv/{member.login}</a>
                    ) : null}
                    {member.displayName === null && member.login === null ? <span className="login-hinweis">{texte.twitchId(member.userId)}</span> : null}
                  </div>
                </div>
              </th>
              <td role="cell">
                <select
                  aria-label={texte.rolleFuer(memberLabel(member))}
                  value={member.role}
                  disabled={!canManageMembers || busyUserId === member.userId || letzterBroadcaster(member, broadcasterCount)}
                  title={verwaltungGesperrt ?? entzugGesperrt(member, broadcasterCount) ?? undefined}
                  onChange={(event) => onRoleChange(member.userId, event.target.value as ChannelRole)}
                  >
                    {roleOptions(waehlbareRollen(member, eigeneUserId, broadcasterCount))}
                  </select>
                  {verwaltungGesperrt !== null ? <span className="sperrgrund">{verwaltungGesperrt}</span> : entzugGesperrt(member, broadcasterCount) === null ? null : <span className="sperrgrund">{texte.letzterBroadcaster}</span>}
              </td>
              <td className="zahl" role="cell">{formatJoinDate(member.joinedAt)}</td>
              <td className="tabelle__aktion" role="cell">
                <button
                  className="button button--quiet"
                  type="button"
                  aria-label={texte.zugriffEntziehen(memberLabel(member))}
                  disabled={!canManageMembers || busyUserId === member.userId || entzugGesperrt(member, broadcasterCount) !== null}
                  title={verwaltungGesperrt ?? entzugGesperrt(member, broadcasterCount) ?? undefined}
                  onClick={() => onRemove(member)}
                >{texte.entziehen}</button>
                {entzugGesperrt(member, broadcasterCount) === null ? null : <span className="sperrgrund">{texte.letzterBroadcaster}</span>}
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
  const texte = membersTexte();
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

  /**
   * `role="alertdialog"` verlangt, dass der Fokus tatsächlich hinein wandert —
   * sonst bemerkt weder Tastatur- noch Screenreader-Bedienung die wichtigste
   * Sicherheitsabfrage des Formulars.
   */
  useEffect(() => {
    if (confirmingAdd) confirmButtonRef.current?.focus();
  }, [confirmingAdd]);

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
    const selbst = member.userId === eigeneUserId;
    const frage = selbst
      ? texte.selbstEntfernen
      : texte.fremdenEntfernen(memberLabel(member));
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
      <ModuleHeading kind="members" title={texte.titel} subtitle={<ModuleCount count={members.length} label={texte.count} />} />
      <section className="inspector-section inspector-form" aria-label={texte.zugriffVergeben}>
        <div className="section-heading"><h2>{texte.zugriffVergeben}</h2></div>
        {!canManageMembers ? <p className="sperrgrund">{texte.verwaltungGesperrt}</p> : null}
        <form className="inspector-form" onSubmit={(event) => { void handleSearch(event); }}>
          <label htmlFor="member-search">{texte.twitchName}</label>
          <div className="form-row"><input id="member-search" value={login} onChange={(event) => setLogin(event.target.value)} autoComplete="off" disabled={!canManageMembers} title={!canManageMembers ? texte.verwaltungGesperrt : undefined} /><button className="button" type="submit" disabled={!canManageMembers || searching || login.trim().length === 0} title={!canManageMembers ? texte.verwaltungGesperrt : undefined}>{searching ? texte.sucheLaeuft : texte.suchen}</button></div>
        </form>
        {!canManageMembers && foundUser === null ? <div><button className="button" type="button" disabled title={texte.verwaltungGesperrt}>{texte.zugriffFreigeben}</button><span className="sperrgrund">{texte.verwaltungGesperrt}</span></div> : null}
        {searchError === null ? null : <p className="form-error" role="alert">{searchError}</p>}
        {foundUser === null ? null : (
          <div className="inspector-result">
            <div className="avatar-row">
              <MemberAvatar src={foundUser.profileImageUrl} />
              <div>
                <strong>{foundUser.displayName}</strong>
                <span>@{foundUser.login} · Twitch-ID {foundUser.userId}</span>
                <a
                  className="login-hinweis profile-link"
                  href={`https://twitch.tv/${foundUser.login}`}
                  target="_blank"
                  rel="noreferrer noopener"
                >twitch.tv/{foundUser.login}</a>
              </div>
            </div>
            <label>{texte.rolle}<select aria-label={texte.neueRolle} value={newRole} disabled={!canManageMembers} title={!canManageMembers ? texte.verwaltungGesperrt : undefined} onChange={(event) => setNewRole(event.target.value as ChannelRole)}>{roleOptions()}</select></label>
            <div>
              <button className="button" type="button" onClick={() => { setActionError(null); setConfirmingAdd(true); }} disabled={!canManageMembers || busyUserId === foundUser.userId} title={!canManageMembers ? texte.verwaltungGesperrt : undefined}>{texte.zugriffFreigeben}</button>
              {!canManageMembers ? <span className="sperrgrund">{texte.verwaltungGesperrt}</span> : null}
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
                <h3 id="member-add-confirmation-title">{texte.bestaetigungTitel(foundUser.displayName)}</h3>
                <span>@{foundUser.login}</span>
              </div>
            </div>
            <p id="member-add-confirmation-description">{accessConfirmation(newRole)}</p>
            {!canManageMembers ? <span className="sperrgrund">{texte.verwaltungGesperrt}</span> : null}
            <div className="form-actions">
              <button ref={confirmButtonRef} className="button button--primary" type="button" onClick={() => { void handleAdd(); }} disabled={!canManageMembers || busyUserId === foundUser.userId} title={!canManageMembers ? texte.verwaltungGesperrt : undefined}>{texte.endgueltigFreigeben}</button>
              <button className="button button--quiet" type="button" onClick={cancelAdd} disabled={busyUserId === foundUser.userId}>{dashboardGemeinsameTexte().abbrechen}</button>
            </div>
          </div>
        ) : null}
      </section>
      <section className="content-section" aria-label={texte.freigegebeneMitglieder}>
        <div className="section-heading"><h2>{texte.freigegebeneMitglieder}</h2></div>
        {loading && members.length === 0 ? <p className="loading-line">{texte.laden}</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
        {members.length === 0 && loading ? null : <div className={loading ? "veraltet" : undefined}>
          <MemberTable members={members} canManageMembers={canManageMembers} broadcasterCount={broadcasterCount} eigeneUserId={eigeneUserId} onRoleChange={(userId, role) => { void handleRoleChange(userId, role); }} onRemove={(member) => { void handleRemove(member); }} busyUserId={busyUserId} />
        </div>}
        {nextCursor == null ? null : <button className="button button--secondary" type="button" onClick={() => { void onLoadNextPage(); }} disabled={loading || loadingNextPage}>{loadingNextPage ? texte.weitereWerdenGeladen : texte.weitereLaden}</button>}
      </section>
    </>
  );
};
