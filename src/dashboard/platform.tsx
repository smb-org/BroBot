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
import { dashboardCommonTexts, formatTimestamp, formatZahl } from "./locale";
import { InspectorHeading, SubInspector } from "./inspector";
import { useInspectorSelection } from "./inspector-selection";
import { NavigationIcon, StateRow, type StateTone } from "./module-panels";

interface PlatformPageProperties {
  beiAnmeldungErforderlich: () => void;
}

interface LoadState<T> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: string | null;
}

const emptyLoadState = <T,>(): LoadState<T> => ({ status: "idle", data: null, error: null });
const loadState = <T,>(): LoadState<T> => ({ status: "loading", data: null, error: null });
const loadedState = <T,>(data: T): LoadState<T> => ({ status: "success", data, error: null });

const errorText = (error: unknown, ersatz: string): string =>
  error instanceof Error && error.message.length > 0 ? error.message : ersatz;

const istAbbruch = (error: unknown): boolean =>
  error instanceof DOMException && error.name === "AbortError";

const memberName = (member: PanelMember): string =>
  member.displayName ?? (member.login === null ? "Twitch-ID " + member.userId : "@" + member.login);

const userName = (user: PanelTwitchUser): string =>
  user.displayName.length > 0 ? user.displayName : "@" + user.login;

const rollenOptionen = (): ReactElement[] => CHANNEL_ROLES.filter((rolle) => rolle !== "broadcaster").map((rolle) => (
  <option key={rolle} value={rolle}>{roleLabel(rolle)}</option>
));

const connectionTone = (channel: PanelPlatformChannelOverview): StateTone =>
  channel.broadcasterConnected ? "healthy" : channel.fullConsent ? "warning" : "neutral";

const connectionWord = (channel: PanelPlatformChannelOverview): string => {
  const texts = platformTexts();
  return channel.broadcasterConnected ? texts.verbunden : channel.fullConsent ? texts.zustimmungAusstehend : texts.nein;
};

const MembersTable = ({
  mitglieder: members,
  angefragteEntfernung,
  aufRolleÄndern: onRoleChange,
  aufEntfernen: onRemove,
  aufEntfernungBestätigen: onConfirmRemoval,
  aufEntfernungAbbrechen: onCancelRemoval,
  bestätigungsButton: confirmationButton,
}: {
  mitglieder: PanelMember[];
  angefragteEntfernung: string | null;
  aufRolleÄndern: (member: PanelMember, rolle: "manager" | "operator") => void;
  aufEntfernen: (member: PanelMember) => void;
  aufEntfernungBestätigen: (member: PanelMember) => void;
  aufEntfernungAbbrechen: () => void;
  bestätigungsButton: RefObject<HTMLButtonElement | null>;
}): ReactElement => {
  const texts = platformTexts();
  if (members.length === 0) return <p className="muted">{texts.keineMitglieder}</p>;
  return (
    <div className="tabelle-wrap">
      <table className="tabelle">
        <thead>
          <tr>
            <th scope="col">{texts.login}</th>
            <th scope="col">{texts.rolle}</th>
            <th scope="col" className="tabelle__aktion">{texts.entfernen}</th>
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
                      aria-label={texts.rolle + ": " + memberName(member)}
                      value={member.role}
                      onChange={(event) => { onRoleChange(member, event.target.value as "manager" | "operator"); }}
                    >
                      {rollenOptionen()}
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
                        title={texts.broadcasterEntfernenHinweis}
                        aria-describedby={"betreiber-entfernen-hinweis-" + member.userId}
                      >
                        {texts.entfernen}
                      </button>
                      <span id={"betreiber-entfernen-hinweis-" + member.userId} className="sr-only">{texts.broadcasterEntfernenHinweis}</span>
                    </>
                  ) : (
                    <button className="button button--danger" type="button" onClick={() => { onRemove(member); }}>
                      {texts.entfernen}
                    </button>
                  )}
                </td>
              </tr>
              {angefragteEntfernung === member.userId ? (
                <tr>
                  <td colSpan={3}>
                    <div className="inspector-confirmation" role="alertdialog" aria-label={texts.entfernenFrage(memberName(member))}>
                      <h3>{texts.entfernenFrage(memberName(member))}</h3>
                      <p>{texts.entfernenFrage(memberName(member))}</p>
                      <div className="form-actions form-actions--destructive">
                        <button ref={confirmationButton} className="button button--danger" type="button" onClick={() => { onConfirmRemoval(member); }}>
                          {texts.endgültigEntfernen}
                        </button>
                        <button className="button button--quiet" type="button" onClick={onCancelRemoval}>
                          {dashboardCommonTexts().abbrechen}
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
  kanal: channel,
  beiAnmeldungErforderlich: onAuthenticationRequired,
  aufÜbersichtLaden: onReload,
  onClose,
}: {
  kanal: PanelPlatformChannelOverview;
  beiAnmeldungErforderlich: () => void;
  aufÜbersichtLaden: () => Promise<void>;
  onClose: () => void;
}): ReactElement => {
  const texts = platformTexts();
  const [members, setMembers] = useState<LoadState<PanelPlatformMembersResponse>>(() => emptyLoadState());
  const [foundMember, setFoundMember] = useState<PanelTwitchUser | null>(null);
  const [suchLogin, setSuchLogin] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchInProgress, setSearchInProgress] = useState(false);
  const [neueRolle, setNeueRolle] = useState<"manager" | "operator">("operator");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [angefragteEntfernung, setAngefragteEntfernung] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [consentInProgress, setConsentInProgress] = useState(false);
  const confirmationButton = useRef<HTMLButtonElement | null>(null);

  const loadMembers = async (): Promise<void> => {
    setMembers((aktuell) => aktuell.data === null ? loadState() : { ...aktuell, status: "loading", error: null });
    try {
      setMembers(loadedState(await getPlatformMembers(channel.channelId)));
    } catch (error: unknown) {
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
      if (!istAbbruch(error)) setMembers({ status: "error", data: null, error: errorText(error, texts.fehler) });
    }
  };

  useEffect(() => {
    let abgebrochen = false;
    const load = async (): Promise<void> => {
      try {
        const daten = await getPlatformMembers(channel.channelId);
        if (!abgebrochen) setMembers(loadedState(daten));
      } catch (error: unknown) {
        if (!abgebrochen && !istAbbruch(error)) {
          setMembers({ status: "error", data: null, error: errorText(error, texts.fehler) });
          if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
        }
      }
    };
    void load();
    return () => { abgebrochen = true; };
  }, [channel.channelId, onAuthenticationRequired, texts.fehler]);

  useEffect(() => {
    if (angefragteEntfernung !== null) confirmationButton.current?.focus();
  }, [angefragteEntfernung]);

  const toggleConsent = async (): Promise<void> => {
    setConsentInProgress(true);
    setActionError(null);
    try {
      await setPlatformFullConsent(channel.channelId, !channel.fullConsent);
      await onReload();
    } catch (error: unknown) {
      setActionError(errorText(error, texts.fehler));
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
      setFoundMember((await searchPlatformUser(suchLogin)).user);
    } catch (error: unknown) {
      setSearchError(errorText(error, texts.fehler));
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
      await addPlatformMember(channel.channelId, foundMember.userId, neueRolle);
      setFoundMember(null);
      setSuchLogin("");
      await loadMembers();
    } catch (error: unknown) {
      setActionError(errorText(error, texts.fehler));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  const changeRole = async (member: PanelMember, rolle: "manager" | "operator"): Promise<void> => {
    setBusyUserId(member.userId);
    setActionError(null);
    try {
      await changePlatformMember(channel.channelId, member.userId, rolle);
      await loadMembers();
    } catch (error: unknown) {
      setActionError(errorText(error, texts.fehler));
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
      setAngefragteEntfernung(null);
      await loadMembers();
    } catch (error: unknown) {
      setActionError(errorText(error, texts.fehler));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setBusyUserId(null);
    }
  };

  return (
    <SubInspector ariaLabel={texts.kanalBearbeiten(channel.displayName)} title={texts.kanalBearbeiten(channel.displayName)} identifier={channel.channelId} closeLabel={dashboardCommonTexts().schliessen} onClose={onClose}>
      <StateRow
        label={texts.identität}
        tone={connectionTone(channel)}
        wort={connectionWord(channel)}
        detail={!channel.broadcasterConnected && channel.fullConsent ? texts.zustimmungAusstehendHinweis : channel.login}
      />
      <section className="config-section" aria-label={texts.zustimmungUmschalten}>
        <div className="section-heading"><h3>{texts.zustimmungUmschalten}</h3></div>
        <div className="form-actions">
          <button className="switch" type="button" role="switch" aria-checked={channel.fullConsent} aria-label={texts.fullConsent} aria-busy={consentInProgress} disabled={consentInProgress} onClick={() => { void toggleConsent(); }}>
            <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
          </button>
          <span className="muted">{channel.fullConsent ? texts.ja : texts.nein}</span>
        </div>
      </section>
      <Einladungslink kanal={channel} />
      <section className="config-section" aria-label={texts.mitglieder}>
        <div className="section-heading"><h3>{texts.mitglieder}</h3></div>
        {members.status === "loading" && members.data === null ? <p className="loading-line">{texts.mitgliederLaden}</p> : null}
        {members.error === null ? null : <p className="form-error" role="alert">{members.error}</p>}
        {members.data === null ? null : (
          <MembersTable
            mitglieder={members.data.members}
            angefragteEntfernung={angefragteEntfernung}
            bestätigungsButton={confirmationButton}
            aufRolleÄndern={(member, rolle) => { void changeRole(member, rolle); }}
            aufEntfernen={(member) => { setAngefragteEntfernung(member.userId); }}
            aufEntfernungBestätigen={(member) => { void removeMember(member); }}
            aufEntfernungAbbrechen={() => { setAngefragteEntfernung(null); }}
          />
        )}
      </section>
      <section className="config-section" aria-label={texts.mitgliedHinzufügen}>
        <div className="section-heading"><h3>{texts.mitgliedHinzufügen}</h3></div>
        <form className="inspector-form" onSubmit={(event) => { void searchUser(event); }}>
          <label className="config-field config-field--mittel" htmlFor={"betreiber-mitglied-suche-" + channel.channelId}>{texts.twitchLogin}
            <input id={"betreiber-mitglied-suche-" + channel.channelId} value={suchLogin} onChange={(event) => { setSuchLogin(event.target.value); }} autoComplete="off" />
          </label>
          <div className="form-actions">
            <button className="button" type="submit" disabled={searchInProgress || suchLogin.trim().length === 0}>{searchInProgress ? texts.sucheLäuft : texts.suchen}</button>
          </div>
        </form>
        {searchError === null ? null : <p className="form-error" role="alert">{searchError}</p>}
        {foundMember === null ? null : (
          <div className="inspector-result">
            <div>
              <strong>{userName(foundMember)}</strong>
              <span>@{foundMember.login} · {texts.twitchId(foundMember.userId)}</span>
            </div>
            <label className="config-field config-field--mittel">{texts.rolle}
              <select aria-label={texts.neueRolle} value={neueRolle} onChange={(event) => { setNeueRolle(event.target.value as "manager" | "operator"); }}>
                {rollenOptionen()}
              </select>
            </label>
            <button className="button button--primary" type="button" disabled={busyUserId === foundMember.userId} onClick={() => { void addMember(); }}>{texts.hinzufügen}</button>
          </div>
        )}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
      </section>
    </SubInspector>
  );
};

const ChannelRelease = ({
  aufÜbersichtLaden: onReload,
  beiAnmeldungErforderlich: onAuthenticationRequired,
  onClose,
}: {
  aufÜbersichtLaden: () => Promise<void>;
  beiAnmeldungErforderlich: () => void;
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
      setSearchError(errorText(error, texts.fehler));
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
      setActionError(errorText(error, texts.fehler));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setReleaseInProgress(false);
    }
  };

  return (
    <SubInspector ariaLabel={texts.kanalFreigeben} title={texts.kanalFreigeben} closeLabel={dashboardCommonTexts().schliessen} onClose={onClose}>
      <form className="inspector-form" onSubmit={(event) => { void searchUser(event); }}>
        <label className="config-field config-field--mittel" htmlFor="betreiber-kanal-login">{texts.twitchLogin}
          <input id="betreiber-kanal-login" value={login} onChange={(event) => { setLogin(event.target.value); }} autoComplete="off" />
        </label>
        <div className="form-actions">
          <button className="button" type="submit" disabled={searchInProgress || login.trim().length === 0}>{searchInProgress ? texts.sucheLäuft : texts.suchen}</button>
        </div>
      </form>
      {searchError === null ? null : <p className="form-error" role="alert">{searchError}</p>}
      {found === null ? null : (
        <div className="inspector-result">
          <div>
            <strong>{texts.nutzerGefunden}: {found.displayName}</strong>
            <span>@{found.login} · {texts.twitchId(found.userId)}</span>
          </div>
          <label className="config-field config-field--mittel">
            <span>{texts.vollzustimmungSetzen}</span>
            <input type="checkbox" checked={fullConsent} onChange={(event) => { setFullConsent(event.target.checked); }} />
          </label>
          <button className="button" type="button" onClick={() => { setActionError(null); setConfirmation(true); }}>{texts.kanalFreigeben}</button>
        </div>
      )}
      {confirmation && found !== null ? (
        <div className="inspector-confirmation" role="alertdialog" aria-label={texts.kanalFreigebenFrage(found.displayName)}>
          <h3>{texts.kanalFreigebenFrage(found.displayName)}</h3>
          <p>{texts.kanalFreigebenBeschreibung(found.displayName, found.userId, fullConsent ? texts.ja : texts.nein)}</p>
          <div className="form-actions">
            <button ref={confirmationButton} className="button button--primary" type="button" disabled={releaseInProgress} onClick={() => { void releaseChannel(); }}>{texts.endgültigFreigeben}</button>
            <button className="button button--quiet" type="button" disabled={releaseInProgress} onClick={() => { setConfirmation(false); }}>{dashboardCommonTexts().abbrechen}</button>
          </div>
        </div>
      ) : null}
      {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
    </SubInspector>
  );
};

const Einladungslink = ({ kanal: channel }: { kanal: PanelPlatformChannelOverview }): ReactElement => {
  const texts = platformTexts();
  const [status, setStatus] = useState<string | null>(null);
  const link = window.location.origin + "/auth/login?channel=" + encodeURIComponent(channel.login);

  const kopieren = async (): Promise<void> => {
    const zwischenablage = Reflect.get(navigator, "clipboard") as { writeText: (text: string) => Promise<void> } | undefined;
    if (zwischenablage === undefined) return;
    await zwischenablage.writeText(link);
    setStatus(texts.linkKopiert);
  };

  return (
    <section className="config-section" aria-label={texts.einladungslink}>
      <div className="section-heading"><h2>{texts.einladungslink}</h2></div>
      <p className="muted">{texts.einladungslinkHinweis}</p>
      <label className="config-field config-field--breit" htmlFor="betreiber-einladungslink">{texts.einladungslink}
        <input id="betreiber-einladungslink" readOnly value={link} />
      </label>
      <div className="form-actions">
        <button className="button" type="button" onClick={() => { void kopieren(); }}>{texts.linkKopieren}</button>
        {status === null ? null : <span className="muted">{status}</span>}
      </div>
      {!channel.broadcasterConnected && channel.fullConsent ? <StateRow label={texts.identität} tone="warning" wort={texts.zustimmungAusstehend} detail={texts.zustimmungAusstehendHinweis} /> : null}
    </section>
  );
};

const PlatformAudit = ({
  auditZustand: auditState,
  kanäle: channels,
  aufWeitereLaden: onLoadMore,
  weitereLädt: loadingMore,
}: {
  auditZustand: LoadState<PanelPlatformAuditResponse>;
  kanäle: PanelPlatformChannelOverview[];
  aufWeitereLaden: () => void;
  weitereLädt: boolean;
}): ReactElement => {
  const texts = platformTexts();
  const channelNames = useMemo(() => new Map(channels.map((channel) => [channel.channelId, channel.login])), [channels]);
  const actorName = (entry: PanelPlatformAuditEntry): string =>
    entry.actorDisplayName ?? (entry.actorLogin == null ? entry.actorUserId : `@${entry.actorLogin}`);
  const actor = (entry: PanelPlatformAuditEntry): string =>
    (entry.actorKind === "platform_admin" ? texts.betreiber : texts.mitglied) + " · " + actorName(entry);
  return (
    <section className="config-section" aria-label={texts.audit}>
      <div className="section-heading"><h2>{texts.audit}</h2></div>
      {auditState.status === "loading" && auditState.data === null ? <p className="loading-line">{texts.auditLaden}</p> : null}
      {auditState.error === null ? null : <p className="form-error" role="alert">{auditState.error}</p>}
      {auditState.data?.entries.length === 0 ? <p className="muted">{texts.auditLeer}</p> : null}
      {auditState.data === null ? null : auditState.data.entries.length === 0 ? null : (
        <div className="tabelle-wrap">
          <table className="tabelle">
            <thead><tr><th scope="col">{texts.login}</th><th scope="col">{texts.handlung}</th><th scope="col">{texts.akteur}</th><th scope="col">{texts.zeitpunkt}</th></tr></thead>
            <tbody>{auditState.data.entries.map((entry) => <tr key={entry.auditId}><th scope="row">{channelNames.get(entry.channelId) ?? <span className="mono">{entry.channelId}</span>}</th><td>{platformActionLabel(entry.action)}</td><td className="mono">{actor(entry)}</td><td className="mono" title={entry.createdAt}>{formatTimestamp(entry.createdAt)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {auditState.data?.nextCursor === null || auditState.data?.nextCursor === undefined ? null : <button className="button button--secondary" type="button" onClick={onLoadMore} disabled={loadingMore}>{loadingMore ? texts.weitereWerdenGeladen : texts.weitereLaden}</button>}
    </section>
  );
};

export const PlatformPage = ({ beiAnmeldungErforderlich: onAuthenticationRequired }: PlatformPageProperties): ReactElement => {
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
    setOverview((aktuell) => aktuell.data === null ? loadState() : { ...aktuell, status: "loading", error: null });
    try {
      const response = await getPlatformOverview();
      setOverview(loadedState(response.channels));
      if (selectedChannelId !== null && !response.channels.some((channel) => channel.channelId === selectedChannelId)) closeChannel();
    } catch (error: unknown) {
      setOverview({ status: "error", data: null, error: errorText(error, texts.fehler) });
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    }
  };

  useEffect(() => {
    let abgebrochen = false;
    const load = async (): Promise<void> => {
      setOverview(loadState());
      setAudit(loadState());
      try {
        const [channelResponse, auditResponse] = await Promise.all([getPlatformOverview(), getPlatformAudit()]);
        if (abgebrochen) return;
        setOverview(loadedState(channelResponse.channels));
        closeChannel();
        setAudit(loadedState(auditResponse));
      } catch (error: unknown) {
        if (abgebrochen) return;
        const meldung = errorText(error, texts.fehler);
        setOverview({ status: "error", data: null, error: meldung });
        setAudit({ status: "error", data: null, error: meldung });
        if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
      }
    };
    void load();
    return () => { abgebrochen = true; };
  }, [onAuthenticationRequired, closeChannel, texts.fehler]);

  const selectedChannel = overview.data?.find((channel) => channel.channelId === selectedChannelId) ?? null;

  const ladeWeitereAudit = async (): Promise<void> => {
    if (auditLoadingMore || audit.data?.nextCursor === null || audit.data?.nextCursor === undefined) return;
    setAuditLoadingMore(true);
    try {
      const nextPage = await getPlatformAudit(audit.data.nextCursor);
      setAudit((aktuell) => aktuell.data === null ? aktuell : loadedState({ entries: aktuell.data.entries.concat(nextPage.entries), nextCursor: nextPage.nextCursor }));
    } catch (error: unknown) {
      setAudit((aktuell) => ({ ...aktuell, status: "error", error: errorText(error, texts.fehler) }));
      if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired();
    } finally {
      setAuditLoadingMore(false);
    }
  };

  return (
    <section className="module-stack" aria-label={texts.titel}>
      <header className="module-detail-heading">
        <div className="module-detail-heading__icon" aria-hidden="true"><NavigationIcon kind="members" className="module-heading-glyph" /></div>
        <div className="module-detail-heading__copy"><h1>{texts.titel}</h1><p>{texts.untertitel(formatZahl(overview.data?.length ?? 0))}</p></div>
      </header>
      <section className={`config-section inspektor-bereich${selectedChannel === null && !channelReleaseOpen ? "" : " inspektor-bereich--offen"}`} aria-label={texts.kanalübersicht}>
        <div className="inspektor-bereich__liste">
          <InspectorHeading level="h2" title={texts.kanalübersicht} buttonRef={channelReleaseButton} action={{ kind: "add", label: texts.kanalFreigeben, onClick: openChannelRelease }} />
          {overview.status === "loading" && overview.data === null ? <p className="loading-line">{texts.laden}</p> : null}
          {overview.error === null ? null : <p className="form-error" role="alert">{overview.error}</p>}
          {overview.data?.length === 0 ? <p className="muted">{texts.keineKanäle}</p> : null}
          {overview.data === null ? null : overview.data.length === 0 ? null : (
            <div className="tabelle-wrap">
              <table className="tabelle tabelle--inhalt">
                <thead><tr><th scope="col">{texts.login}</th><th scope="col">{texts.kennung}</th><th scope="col">{texts.fullConsent}</th><th scope="col">{texts.broadcaster}</th><th scope="col">{texts.verwalter}</th><th scope="col">{texts.bediener}</th><th scope="col">{texts.identität}</th></tr></thead>
                <tbody>{overview.data.map((channel) => <tr key={channel.channelId} ref={channelRowRef(channel.channelId)} tabIndex={0} aria-selected={channel.channelId === selectedChannelId} onClick={() => { setChannelReleaseOpen(false); selectChannel(channel.channelId); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setChannelReleaseOpen(false); selectChannel(channel.channelId); } }}><th scope="row">{channel.login}</th><td className="mono">{channel.channelId}</td><td>{channel.fullConsent ? texts.ja : texts.nein}</td><td className="zahl">{formatZahl(channel.memberCounts.broadcaster)}</td><td className="zahl">{formatZahl(channel.memberCounts.manager)}</td><td className="zahl">{formatZahl(channel.memberCounts.operator)}</td><td><span className="led" data-status={connectionTone(channel) === "healthy" ? "green" : connectionTone(channel) === "warning" ? "amber" : "off"}><span className="led__dot" aria-hidden="true" /><span>{connectionWord(channel)}</span></span></td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
        {selectedChannel === null
          ? channelReleaseOpen ? <ChannelRelease aufÜbersichtLaden={loadOverview} beiAnmeldungErforderlich={onAuthenticationRequired} onClose={closeChannelRelease} /> : null
          : <ChannelInspector key={selectedChannel.channelId} kanal={selectedChannel} beiAnmeldungErforderlich={onAuthenticationRequired} aufÜbersichtLaden={loadOverview} onClose={closeChannel} />}
      </section>
      <PlatformAudit auditZustand={audit} kanäle={overview.data ?? []} aufWeitereLaden={() => { void ladeWeitereAudit(); }} weitereLädt={auditLoadingMore} />
    </section>
  );
};
