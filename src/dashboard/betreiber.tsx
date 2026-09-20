import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement, type RefObject, type SyntheticEvent } from "react";

import type {
  PanelBetreiberAuditEntry,
  PanelBetreiberAuditResponse,
  PanelBetreiberKanalÜbersicht,
  PanelBetreiberMitgliederResponse,
  PanelMember,
  PanelTwitchUser,
} from "../panel-contract";
import {
  ändereBetreiberMitglied,
  entferneBetreiberMitglied,
  fügeBetreiberMitgliedHinzu,
  gibBetreiberKanalFrei,
  holeBetreiberAudit,
  holeBetreiberMitglieder,
  holeBetreiberÜbersicht,
  PanelApiError,
  setzeBetreiberVollzustimmung,
  sucheBetreiberNutzer,
} from "./api";
import { betreiberHandlungLabel, betreiberTexte, roleLabel } from "./labels";
import { dashboardGemeinsameTexte, formatZeitpunkt, formatZahl } from "./locale";
import { NavigationIcon, ZustandZeile, type ZustandsTon } from "./module-panels";

interface BetreiberSeitenEigenschaften {
  beiAnmeldungErforderlich: () => void;
}

interface Ladezustand<T> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: string | null;
}

const leererLadezustand = <T,>(): Ladezustand<T> => ({ status: "idle", data: null, error: null });
const ladezustand = <T,>(): Ladezustand<T> => ({ status: "loading", data: null, error: null });
const geladenerZustand = <T,>(data: T): Ladezustand<T> => ({ status: "success", data, error: null });

const fehlertext = (fehler: unknown, ersatz: string): string =>
  fehler instanceof Error && fehler.message.length > 0 ? fehler.message : ersatz;

const istAbbruch = (fehler: unknown): boolean =>
  fehler instanceof DOMException && fehler.name === "AbortError";

const mitgliedsname = (mitglied: PanelMember): string =>
  mitglied.displayName ?? (mitglied.login === null ? "Twitch-ID " + mitglied.userId : "@" + mitglied.login);

const nutzername = (nutzer: PanelTwitchUser): string =>
  nutzer.displayName.length > 0 ? nutzer.displayName : "@" + nutzer.login;

const rollenOptionen = (): ReactElement[] => (["verwalter", "bediener"] as const).map((rolle) => (
  <option key={rolle} value={rolle}>{roleLabel(rolle)}</option>
));

const verbindungsTon = (kanal: PanelBetreiberKanalÜbersicht): ZustandsTon =>
  kanal.broadcasterConnected ? "healthy" : kanal.vollzustimmung ? "warning" : "neutral";

const verbindungswort = (kanal: PanelBetreiberKanalÜbersicht): string => {
  const texte = betreiberTexte();
  return kanal.broadcasterConnected ? texte.verbunden : kanal.vollzustimmung ? texte.zustimmungAusstehend : texte.nein;
};

const MitgliederTabelle = ({
  mitglieder,
  angefragteEntfernung,
  aufRolleÄndern,
  aufEntfernen,
  aufEntfernungBestätigen,
  aufEntfernungAbbrechen,
  bestätigungsButton,
}: {
  mitglieder: PanelMember[];
  angefragteEntfernung: string | null;
  aufRolleÄndern: (mitglied: PanelMember, rolle: "verwalter" | "bediener") => void;
  aufEntfernen: (mitglied: PanelMember) => void;
  aufEntfernungBestätigen: (mitglied: PanelMember) => void;
  aufEntfernungAbbrechen: () => void;
  bestätigungsButton: RefObject<HTMLButtonElement | null>;
}): ReactElement => {
  const texte = betreiberTexte();
  if (mitglieder.length === 0) return <p className="muted">{texte.keineMitglieder}</p>;
  return (
    <div className="tabelle-wrap">
      <table className="tabelle">
        <thead>
          <tr>
            <th scope="col">{texte.login}</th>
            <th scope="col">{texte.rolle}</th>
            <th scope="col" className="tabelle__aktion">{texte.entfernen}</th>
          </tr>
        </thead>
        <tbody>
          {mitglieder.map((mitglied) => (
            <Fragment key={mitglied.userId}>
              <tr>
                <th scope="row">
                  <span>{mitgliedsname(mitglied)}</span>
                  <span className="login-hinweis">
                    {mitglied.login === null ? texte.twitchId(mitglied.userId) : "@" + mitglied.login + " · " + texte.twitchId(mitglied.userId)}
                  </span>
                </th>
                <td>
                  {mitglied.role === "broadcaster" ? <span>{roleLabel(mitglied.role)}</span> : (
                    <select
                      aria-label={texte.rolle + ": " + mitgliedsname(mitglied)}
                      value={mitglied.role}
                      onChange={(ereignis) => { aufRolleÄndern(mitglied, ereignis.target.value as "verwalter" | "bediener"); }}
                    >
                      {rollenOptionen()}
                    </select>
                  )}
                </td>
                <td className="tabelle__aktion">
                  {mitglied.role === "broadcaster" ? (
                    <>
                      <button
                        className="button button--danger"
                        type="button"
                        disabled
                        title={texte.broadcasterEntfernenHinweis}
                        aria-describedby={"betreiber-entfernen-hinweis-" + mitglied.userId}
                      >
                        {texte.entfernen}
                      </button>
                      <span id={"betreiber-entfernen-hinweis-" + mitglied.userId} className="sr-only">{texte.broadcasterEntfernenHinweis}</span>
                    </>
                  ) : (
                    <button className="button button--danger" type="button" onClick={() => { aufEntfernen(mitglied); }}>
                      {texte.entfernen}
                    </button>
                  )}
                </td>
              </tr>
              {angefragteEntfernung === mitglied.userId ? (
                <tr>
                  <td colSpan={3}>
                    <div className="inspector-confirmation" role="alertdialog" aria-label={texte.entfernenFrage(mitgliedsname(mitglied))}>
                      <h3>{texte.entfernenFrage(mitgliedsname(mitglied))}</h3>
                      <p>{texte.entfernenFrage(mitgliedsname(mitglied))}</p>
                      <div className="form-actions form-actions--destructive">
                        <button ref={bestätigungsButton} className="button button--danger" type="button" onClick={() => { aufEntfernungBestätigen(mitglied); }}>
                          {texte.endgültigEntfernen}
                        </button>
                        <button className="button button--quiet" type="button" onClick={aufEntfernungAbbrechen}>
                          {dashboardGemeinsameTexte().abbrechen}
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

const KanalInspector = ({
  kanal,
  beiAnmeldungErforderlich,
  aufÜbersichtLaden,
}: {
  kanal: PanelBetreiberKanalÜbersicht;
  beiAnmeldungErforderlich: () => void;
  aufÜbersichtLaden: () => Promise<void>;
}): ReactElement => {
  const texte = betreiberTexte();
  const [mitglieder, setMitglieder] = useState<Ladezustand<PanelBetreiberMitgliederResponse>>(() => leererLadezustand());
  const [gefundenesMitglied, setGefundenesMitglied] = useState<PanelTwitchUser | null>(null);
  const [suchLogin, setSuchLogin] = useState("");
  const [suchfehler, setSuchfehler] = useState<string | null>(null);
  const [sucheLäuft, setSucheLäuft] = useState(false);
  const [neueRolle, setNeueRolle] = useState<"verwalter" | "bediener">("bediener");
  const [beschäftigteUserId, setBeschäftigteUserId] = useState<string | null>(null);
  const [angefragteEntfernung, setAngefragteEntfernung] = useState<string | null>(null);
  const [aktionsfehler, setAktionsfehler] = useState<string | null>(null);
  const [zustimmungLäuft, setZustimmungLäuft] = useState(false);
  const bestätigungsButton = useRef<HTMLButtonElement | null>(null);

  const ladeMitglieder = async (): Promise<void> => {
    setMitglieder((aktuell) => aktuell.data === null ? ladezustand() : { ...aktuell, status: "loading", error: null });
    try {
      setMitglieder(geladenerZustand(await holeBetreiberMitglieder(kanal.channelId)));
    } catch (fehler: unknown) {
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
      if (!istAbbruch(fehler)) setMitglieder({ status: "error", data: null, error: fehlertext(fehler, texte.fehler) });
    }
  };

  useEffect(() => {
    let abgebrochen = false;
    const laden = async (): Promise<void> => {
      try {
        const daten = await holeBetreiberMitglieder(kanal.channelId);
        if (!abgebrochen) setMitglieder(geladenerZustand(daten));
      } catch (fehler: unknown) {
        if (!abgebrochen && !istAbbruch(fehler)) {
          setMitglieder({ status: "error", data: null, error: fehlertext(fehler, texte.fehler) });
          if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
        }
      }
    };
    void laden();
    return () => { abgebrochen = true; };
  }, [kanal.channelId, beiAnmeldungErforderlich, texte.fehler]);

  useEffect(() => {
    if (angefragteEntfernung !== null) bestätigungsButton.current?.focus();
  }, [angefragteEntfernung]);

  const schalteZustimmung = async (): Promise<void> => {
    setZustimmungLäuft(true);
    setAktionsfehler(null);
    try {
      await setzeBetreiberVollzustimmung(kanal.channelId, !kanal.vollzustimmung);
      await aufÜbersichtLaden();
    } catch (fehler: unknown) {
      setAktionsfehler(fehlertext(fehler, texte.fehler));
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
    } finally {
      setZustimmungLäuft(false);
    }
  };

  const sucheNutzer = async (ereignis: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    ereignis.preventDefault();
    setSucheLäuft(true);
    setSuchfehler(null);
    setGefundenesMitglied(null);
    try {
      setGefundenesMitglied((await sucheBetreiberNutzer(suchLogin)).user);
    } catch (fehler: unknown) {
      setSuchfehler(fehlertext(fehler, texte.fehler));
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
    } finally {
      setSucheLäuft(false);
    }
  };

  const fügeMitgliedHinzu = async (): Promise<void> => {
    if (gefundenesMitglied === null) return;
    setBeschäftigteUserId(gefundenesMitglied.userId);
    setAktionsfehler(null);
    try {
      await fügeBetreiberMitgliedHinzu(kanal.channelId, gefundenesMitglied.userId, neueRolle);
      setGefundenesMitglied(null);
      setSuchLogin("");
      await ladeMitglieder();
    } catch (fehler: unknown) {
      setAktionsfehler(fehlertext(fehler, texte.fehler));
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
    } finally {
      setBeschäftigteUserId(null);
    }
  };

  const ändereRolle = async (mitglied: PanelMember, rolle: "verwalter" | "bediener"): Promise<void> => {
    setBeschäftigteUserId(mitglied.userId);
    setAktionsfehler(null);
    try {
      await ändereBetreiberMitglied(kanal.channelId, mitglied.userId, rolle);
      await ladeMitglieder();
    } catch (fehler: unknown) {
      setAktionsfehler(fehlertext(fehler, texte.fehler));
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
    } finally {
      setBeschäftigteUserId(null);
    }
  };

  const entferneMitglied = async (mitglied: PanelMember): Promise<void> => {
    setBeschäftigteUserId(mitglied.userId);
    setAktionsfehler(null);
    try {
      await entferneBetreiberMitglied(kanal.channelId, mitglied.userId);
      setAngefragteEntfernung(null);
      await ladeMitglieder();
    } catch (fehler: unknown) {
      setAktionsfehler(fehlertext(fehler, texte.fehler));
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
    } finally {
      setBeschäftigteUserId(null);
    }
  };

  return (
    <section className="sub-inspector" aria-label={texte.kanalBearbeiten(kanal.displayName)}>
      <div className="section-heading"><h2>{texte.kanalBearbeiten(kanal.displayName)}</h2></div>
      <ZustandZeile
        label={texte.identität}
        tone={verbindungsTon(kanal)}
        wort={verbindungswort(kanal)}
        detail={!kanal.broadcasterConnected && kanal.vollzustimmung ? texte.zustimmungAusstehendHinweis : kanal.login}
      />
      <section className="config-section" aria-label={texte.zustimmungUmschalten}>
        <div className="section-heading"><h3>{texte.zustimmungUmschalten}</h3></div>
        <div className="form-actions">
          <button className="switch" type="button" role="switch" aria-checked={kanal.vollzustimmung} aria-label={texte.vollzustimmung} aria-busy={zustimmungLäuft} disabled={zustimmungLäuft} onClick={() => { void schalteZustimmung(); }}>
            <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
          </button>
          <span className="muted">{kanal.vollzustimmung ? texte.ja : texte.nein}</span>
        </div>
      </section>
      <Einladungslink kanal={kanal} />
      <section className="config-section" aria-label={texte.mitglieder}>
        <div className="section-heading"><h3>{texte.mitglieder}</h3></div>
        {mitglieder.status === "loading" && mitglieder.data === null ? <p className="loading-line">{texte.mitgliederLaden}</p> : null}
        {mitglieder.error === null ? null : <p className="form-error" role="alert">{mitglieder.error}</p>}
        {mitglieder.data === null ? null : (
          <MitgliederTabelle
            mitglieder={mitglieder.data.members}
            angefragteEntfernung={angefragteEntfernung}
            bestätigungsButton={bestätigungsButton}
            aufRolleÄndern={(mitglied, rolle) => { void ändereRolle(mitglied, rolle); }}
            aufEntfernen={(mitglied) => { setAngefragteEntfernung(mitglied.userId); }}
            aufEntfernungBestätigen={(mitglied) => { void entferneMitglied(mitglied); }}
            aufEntfernungAbbrechen={() => { setAngefragteEntfernung(null); }}
          />
        )}
      </section>
      <section className="config-section" aria-label={texte.mitgliedHinzufügen}>
        <div className="section-heading"><h3>{texte.mitgliedHinzufügen}</h3></div>
        <form className="inspector-form" onSubmit={(ereignis) => { void sucheNutzer(ereignis); }}>
          <label className="config-field config-field--mittel" htmlFor={"betreiber-mitglied-suche-" + kanal.channelId}>{texte.twitchLogin}
            <input id={"betreiber-mitglied-suche-" + kanal.channelId} value={suchLogin} onChange={(ereignis) => { setSuchLogin(ereignis.target.value); }} autoComplete="off" />
          </label>
          <div className="form-actions">
            <button className="button" type="submit" disabled={sucheLäuft || suchLogin.trim().length === 0}>{sucheLäuft ? texte.sucheLäuft : texte.suchen}</button>
          </div>
        </form>
        {suchfehler === null ? null : <p className="form-error" role="alert">{suchfehler}</p>}
        {gefundenesMitglied === null ? null : (
          <div className="inspector-result">
            <div>
              <strong>{nutzername(gefundenesMitglied)}</strong>
              <span>@{gefundenesMitglied.login} · {texte.twitchId(gefundenesMitglied.userId)}</span>
            </div>
            <label className="config-field config-field--mittel">{texte.rolle}
              <select aria-label={texte.neueRolle} value={neueRolle} onChange={(ereignis) => { setNeueRolle(ereignis.target.value as "verwalter" | "bediener"); }}>
                {rollenOptionen()}
              </select>
            </label>
            <button className="button button--primary" type="button" disabled={beschäftigteUserId === gefundenesMitglied.userId} onClick={() => { void fügeMitgliedHinzu(); }}>{texte.hinzufügen}</button>
          </div>
        )}
        {aktionsfehler === null ? null : <p className="form-error" role="alert">{aktionsfehler}</p>}
      </section>
    </section>
  );
};

const KanalFreigabe = ({
  aufÜbersichtLaden,
  beiAnmeldungErforderlich,
}: {
  aufÜbersichtLaden: () => Promise<void>;
  beiAnmeldungErforderlich: () => void;
}): ReactElement => {
  const texte = betreiberTexte();
  const [login, setLogin] = useState("");
  const [sucheLäuft, setSucheLäuft] = useState(false);
  const [suchfehler, setSuchfehler] = useState<string | null>(null);
  const [gefunden, setGefunden] = useState<PanelTwitchUser | null>(null);
  const [vollzustimmung, setVollzustimmung] = useState(true);
  const [bestätigung, setBestätigung] = useState(false);
  const [freigabeLäuft, setFreigabeLäuft] = useState(false);
  const [aktionsfehler, setAktionsfehler] = useState<string | null>(null);
  const bestätigungsButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (bestätigung) bestätigungsButton.current?.focus();
  }, [bestätigung]);

  const sucheNutzer = async (ereignis: SyntheticEvent<HTMLFormElement>): Promise<void> => {
    ereignis.preventDefault();
    setSucheLäuft(true);
    setSuchfehler(null);
    setGefunden(null);
    setBestätigung(false);
    try {
      setGefunden((await sucheBetreiberNutzer(login)).user);
    } catch (fehler: unknown) {
      setSuchfehler(fehlertext(fehler, texte.fehler));
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
    } finally {
      setSucheLäuft(false);
    }
  };

  const gibKanalFrei = async (): Promise<void> => {
    if (gefunden === null) return;
    setFreigabeLäuft(true);
    setAktionsfehler(null);
    try {
      await gibBetreiberKanalFrei(gefunden.login, vollzustimmung);
      setGefunden(null);
      setLogin("");
      setBestätigung(false);
      await aufÜbersichtLaden();
    } catch (fehler: unknown) {
      setAktionsfehler(fehlertext(fehler, texte.fehler));
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
    } finally {
      setFreigabeLäuft(false);
    }
  };

  return (
    <section className="config-section" aria-label={texte.kanalFreigeben}>
      <div className="section-heading"><h2>{texte.kanalFreigeben}</h2></div>
      <form className="inspector-form" onSubmit={(ereignis) => { void sucheNutzer(ereignis); }}>
        <label className="config-field config-field--mittel" htmlFor="betreiber-kanal-login">{texte.twitchLogin}
          <input id="betreiber-kanal-login" value={login} onChange={(ereignis) => { setLogin(ereignis.target.value); }} autoComplete="off" />
        </label>
        <div className="form-actions">
          <button className="button" type="submit" disabled={sucheLäuft || login.trim().length === 0}>{sucheLäuft ? texte.sucheLäuft : texte.suchen}</button>
        </div>
      </form>
      {suchfehler === null ? null : <p className="form-error" role="alert">{suchfehler}</p>}
      {gefunden === null ? null : (
        <div className="inspector-result">
          <div>
            <strong>{texte.nutzerGefunden}: {gefunden.displayName}</strong>
            <span>@{gefunden.login} · {texte.twitchId(gefunden.userId)}</span>
          </div>
          <label className="config-field config-field--mittel">
            <span>{texte.vollzustimmungSetzen}</span>
            <input type="checkbox" checked={vollzustimmung} onChange={(ereignis) => { setVollzustimmung(ereignis.target.checked); }} />
          </label>
          <button className="button" type="button" onClick={() => { setAktionsfehler(null); setBestätigung(true); }}>{texte.kanalFreigeben}</button>
        </div>
      )}
      {bestätigung && gefunden !== null ? (
        <div className="inspector-confirmation" role="alertdialog" aria-label={texte.kanalFreigebenFrage(gefunden.displayName)}>
          <h3>{texte.kanalFreigebenFrage(gefunden.displayName)}</h3>
          <p>{texte.kanalFreigebenBeschreibung(gefunden.displayName, gefunden.userId, vollzustimmung ? texte.ja : texte.nein)}</p>
          <div className="form-actions">
            <button ref={bestätigungsButton} className="button button--primary" type="button" disabled={freigabeLäuft} onClick={() => { void gibKanalFrei(); }}>{texte.endgültigFreigeben}</button>
            <button className="button button--quiet" type="button" disabled={freigabeLäuft} onClick={() => { setBestätigung(false); }}>{dashboardGemeinsameTexte().abbrechen}</button>
          </div>
        </div>
      ) : null}
      {aktionsfehler === null ? null : <p className="form-error" role="alert">{aktionsfehler}</p>}
    </section>
  );
};

const Einladungslink = ({ kanal }: { kanal: PanelBetreiberKanalÜbersicht }): ReactElement => {
  const texte = betreiberTexte();
  const [status, setStatus] = useState<string | null>(null);
  const link = window.location.origin + "/auth/login?kanal=" + encodeURIComponent(kanal.login);

  const kopieren = async (): Promise<void> => {
    const zwischenablage = Reflect.get(navigator, "clipboard") as { writeText: (text: string) => Promise<void> } | undefined;
    if (zwischenablage === undefined) return;
    await zwischenablage.writeText(link);
    setStatus(texte.linkKopiert);
  };

  return (
    <section className="config-section" aria-label={texte.einladungslink}>
      <div className="section-heading"><h2>{texte.einladungslink}</h2></div>
      <p className="muted">{texte.einladungslinkHinweis}</p>
      <label className="config-field config-field--breit" htmlFor="betreiber-einladungslink">{texte.einladungslink}
        <input id="betreiber-einladungslink" readOnly value={link} />
      </label>
      <div className="form-actions">
        <button className="button" type="button" onClick={() => { void kopieren(); }}>{texte.linkKopieren}</button>
        {status === null ? null : <span className="muted">{status}</span>}
      </div>
      {!kanal.broadcasterConnected && kanal.vollzustimmung ? <ZustandZeile label={texte.identität} tone="warning" wort={texte.zustimmungAusstehend} detail={texte.zustimmungAusstehendHinweis} /> : null}
    </section>
  );
};

const BetreiberAudit = ({
  auditZustand,
  kanäle,
  aufWeitereLaden,
  weitereLädt,
}: {
  auditZustand: Ladezustand<PanelBetreiberAuditResponse>;
  kanäle: PanelBetreiberKanalÜbersicht[];
  aufWeitereLaden: () => void;
  weitereLädt: boolean;
}): ReactElement => {
  const texte = betreiberTexte();
  const kanalnamen = useMemo(() => new Map(kanäle.map((kanal) => [kanal.channelId, kanal.login])), [kanäle]);
  const akteur = (eintrag: PanelBetreiberAuditEntry): string =>
    (eintrag.actorKind === "betreiber" ? texte.betreiber : texte.mitglied) + " · " + eintrag.actorUserId;
  return (
    <section className="config-section" aria-label={texte.audit}>
      <div className="section-heading"><h2>{texte.audit}</h2></div>
      {auditZustand.status === "loading" && auditZustand.data === null ? <p className="loading-line">{texte.auditLaden}</p> : null}
      {auditZustand.error === null ? null : <p className="form-error" role="alert">{auditZustand.error}</p>}
      {auditZustand.data?.entries.length === 0 ? <p className="muted">{texte.auditLeer}</p> : null}
      {auditZustand.data === null ? null : auditZustand.data.entries.length === 0 ? null : (
        <div className="tabelle-wrap">
          <table className="tabelle">
            <thead><tr><th scope="col">{texte.login}</th><th scope="col">{texte.handlung}</th><th scope="col">{texte.akteur}</th><th scope="col">{texte.zeitpunkt}</th></tr></thead>
            <tbody>{auditZustand.data.entries.map((eintrag) => <tr key={eintrag.auditId}><th scope="row">{kanalnamen.get(eintrag.channelId) ?? <span className="mono">{eintrag.channelId}</span>}</th><td>{betreiberHandlungLabel(eintrag.action)}</td><td className="mono">{akteur(eintrag)}</td><td className="mono" title={eintrag.createdAt}>{formatZeitpunkt(eintrag.createdAt)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      {auditZustand.data?.nextCursor === null || auditZustand.data?.nextCursor === undefined ? null : <button className="button button--secondary" type="button" onClick={aufWeitereLaden} disabled={weitereLädt}>{weitereLädt ? texte.weitereWerdenGeladen : texte.weitereLaden}</button>}
    </section>
  );
};

export const BetreiberSeite = ({ beiAnmeldungErforderlich }: BetreiberSeitenEigenschaften): ReactElement => {
  const texte = betreiberTexte();
  const [übersicht, setÜbersicht] = useState<Ladezustand<PanelBetreiberKanalÜbersicht[]>>(() => leererLadezustand());
  const [audit, setAudit] = useState<Ladezustand<PanelBetreiberAuditResponse>>(() => leererLadezustand());
  const [ausgewählterKanalId, setAusgewählterKanalId] = useState<string | null>(null);
  const [weitereAuditLädt, setWeitereAuditLädt] = useState(false);

  const ladeÜbersicht = async (): Promise<void> => {
    setÜbersicht((aktuell) => aktuell.data === null ? ladezustand() : { ...aktuell, status: "loading", error: null });
    try {
      const antwort = await holeBetreiberÜbersicht();
      setÜbersicht(geladenerZustand(antwort.channels));
      setAusgewählterKanalId((aktuell) => aktuell !== null && antwort.channels.some((kanal) => kanal.channelId === aktuell) ? aktuell : null);
    } catch (fehler: unknown) {
      setÜbersicht({ status: "error", data: null, error: fehlertext(fehler, texte.fehler) });
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
    }
  };

  useEffect(() => {
    let abgebrochen = false;
    const laden = async (): Promise<void> => {
      setÜbersicht(ladezustand());
      setAudit(ladezustand());
      try {
        const [kanalantwort, auditantwort] = await Promise.all([holeBetreiberÜbersicht(), holeBetreiberAudit()]);
        if (abgebrochen) return;
        setÜbersicht(geladenerZustand(kanalantwort.channels));
        setAusgewählterKanalId(null);
        setAudit(geladenerZustand(auditantwort));
      } catch (fehler: unknown) {
        if (abgebrochen) return;
        const meldung = fehlertext(fehler, texte.fehler);
        setÜbersicht({ status: "error", data: null, error: meldung });
        setAudit({ status: "error", data: null, error: meldung });
        if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
      }
    };
    void laden();
    return () => { abgebrochen = true; };
  }, [beiAnmeldungErforderlich, texte.fehler]);

  const ausgewählterKanal = übersicht.data?.find((kanal) => kanal.channelId === ausgewählterKanalId) ?? null;

  const ladeWeitereAudit = async (): Promise<void> => {
    if (weitereAuditLädt || audit.data?.nextCursor === null || audit.data?.nextCursor === undefined) return;
    setWeitereAuditLädt(true);
    try {
      const nächsteSeite = await holeBetreiberAudit(audit.data.nextCursor);
      setAudit((aktuell) => aktuell.data === null ? aktuell : geladenerZustand({ entries: aktuell.data.entries.concat(nächsteSeite.entries), nextCursor: nächsteSeite.nextCursor }));
    } catch (fehler: unknown) {
      setAudit((aktuell) => ({ ...aktuell, status: "error", error: fehlertext(fehler, texte.fehler) }));
      if (fehler instanceof PanelApiError && fehler.status === 401) beiAnmeldungErforderlich();
    } finally {
      setWeitereAuditLädt(false);
    }
  };

  return (
    <section className="module-stack" aria-label={texte.titel}>
      <header className="module-detail-heading">
        <div className="module-detail-heading__icon" aria-hidden="true"><NavigationIcon kind="members" className="module-heading-glyph" /></div>
        <div className="module-detail-heading__copy"><h1>{texte.titel}</h1><p>{texte.untertitel(formatZahl(übersicht.data?.length ?? 0))}</p></div>
      </header>
      <section className="config-section" aria-label={texte.kanalübersicht}>
        <div className="section-heading"><h2>{texte.kanalübersicht}</h2></div>
        {übersicht.status === "loading" && übersicht.data === null ? <p className="loading-line">{texte.laden}</p> : null}
        {übersicht.error === null ? null : <p className="form-error" role="alert">{übersicht.error}</p>}
        {übersicht.data?.length === 0 ? <p className="muted">{texte.keineKanäle}</p> : null}
        {übersicht.data === null ? null : übersicht.data.length === 0 ? null : (
          <div className="tabelle-wrap">
            <table className="tabelle tabelle--inhalt">
              <thead><tr><th scope="col">{texte.login}</th><th scope="col">{texte.kennung}</th><th scope="col">{texte.vollzustimmung}</th><th scope="col">{texte.broadcaster}</th><th scope="col">{texte.verwalter}</th><th scope="col">{texte.bediener}</th><th scope="col">{texte.identität}</th></tr></thead>
              <tbody>{übersicht.data.map((kanal) => <tr key={kanal.channelId} tabIndex={0} aria-selected={kanal.channelId === ausgewählterKanalId} onClick={() => { setAusgewählterKanalId(kanal.channelId); }} onKeyDown={(ereignis) => { if (ereignis.key === "Enter" || ereignis.key === " ") { ereignis.preventDefault(); setAusgewählterKanalId(kanal.channelId); } }}><th scope="row">{kanal.login}</th><td className="mono">{kanal.channelId}</td><td>{kanal.vollzustimmung ? texte.ja : texte.nein}</td><td className="zahl">{formatZahl(kanal.memberCounts.broadcaster)}</td><td className="zahl">{formatZahl(kanal.memberCounts.verwalter)}</td><td className="zahl">{formatZahl(kanal.memberCounts.bediener)}</td><td><span className="led" data-status={verbindungsTon(kanal) === "healthy" ? "green" : verbindungsTon(kanal) === "warning" ? "amber" : "off"}><span className="led__dot" aria-hidden="true" /><span>{verbindungswort(kanal)}</span></span></td></tr>)}</tbody>
            </table>
          </div>
        )}
        {ausgewählterKanal === null ? null : <KanalInspector key={ausgewählterKanal.channelId} kanal={ausgewählterKanal} beiAnmeldungErforderlich={beiAnmeldungErforderlich} aufÜbersichtLaden={ladeÜbersicht} />}
      </section>
      <KanalFreigabe aufÜbersichtLaden={ladeÜbersicht} beiAnmeldungErforderlich={beiAnmeldungErforderlich} />
      <BetreiberAudit auditZustand={audit} kanäle={übersicht.data ?? []} aufWeitereLaden={() => { void ladeWeitereAudit(); }} weitereLädt={weitereAuditLädt} />
    </section>
  );
};
