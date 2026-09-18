# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Drei bestätigte Rollen, alle innerhalb eines Kanals vergeben:

- **Broadcaster** — besitzt den Kanal. Richtet ein, vergibt Zugang, verbindet den
  Bot. Als einziger darf er die Rolle `broadcaster` vergeben.
- **Verwalter** — vertraute Person des Broadcasters. Darf Mitglieder und Module
  verwalten, aber keine Broadcaster ernennen.
- **Bediener** — Moderator im Alltag. Liest den Zustand, bedient Module, ändert
  keine Zugänge.

Die Situation ist in allen drei Fällen dieselbe: **während ein Stream läuft**,
auf dem zweiten Monitor neben OBS, häufig nachts. Der Moment, der zählt, ist
nicht die Einrichtung, sondern die Störung: etwas reagiert nicht, und es bleiben
Sekunden, bevor der Stream darunter leidet.

Bedienung am Handy kommt vor, ist aber der Ausnahmefall. Sie muss funktionieren,
niemand plant seinen Alltag darauf.

Zielgruppe ist der Betreiber selbst plus ein **kleiner Kreis befreundeter
Streamer**. Eine offene Selbstanmeldung für beliebige Fremde ist ausdrücklich
nicht vorgesehen. Daraus folgt: Einrichtung und Fehlermeldungen müssen ohne
Rückfrage nachvollziehbar sein, aber nicht narrensicher für Unbekannte.

## Product Purpose

Ein modularer Twitch-Bot für mehrere Kanäle, bestehend aus drei Oberflächen:
dem Bot selbst im Chat, einem Admin- und Mod-Panel und einem Stream-Overlay.

Erfolg heißt: Der Betreiber muss im laufenden Stream **nicht über den Bot
nachdenken**. Er läuft, und wenn er es nicht tut, sieht man sofort woran es
liegt. Das Panel ist kein Ort, an dem man sich aufhält, sondern einer, den man
im Störfall aufschlägt und schnell wieder schließt.

## Positioning

Vier Mechanismen, die ein benachbartes Produkt nicht wahrheitsgemäß behaupten
könnte:

**Der Bot handelt als eigenes Twitch-Konto mit Moderatorrechten.** Er braucht
keine wiederkehrenden Anmeldungen des Broadcasters. Eine Broadcaster-Verbindung
ist ein *optionaler* Schalter je Kanal und wird nur von einzelnen Modulen
gebraucht — ein Kanal ist betriebsbereit, sobald der Bot dort gemoddet ist.

**Berechtigung kommt nie aus der Twitch-Rolle.** Nur eine Zeile in
`channel_members` berechtigt zur Bedienung. Ein Twitch-Moderator ist dadurch
allein nicht befugt; umgekehrt ist auch jemand ohne Twitch-Rolle berechtigbar.

**Mehrkanalfähig ab Tag eins.** `channelId` ist überall der Mandantenschlüssel;
es gibt keinen geheimen Konfigurationswert für einen einzelnen Kanal. Ein Kanal
wird durch eine Zeile freigegeben, nicht durch ein Deployment.

**Module sind isolierte Scheiben.** Sie kennen einander nicht und sind dem
System ausschließlich über Contract und Registry bekannt. Aktiviert wird ein
Modul pro Kanal durch eine Datenbankzeile, ohne Deploy; ein deaktiviertes Modul
kostet im Overlay-Bundle null Bytes.

## Operating Context

- Läuft neben OBS auf demselben Rechner, meist abends und nachts.
- Der Bot ist im Zweifel längst gestartet; das Panel wird selten geöffnet, dann
  aber unter Zeitdruck.
- Twitch ist die Umgebung: Kanäle, Moderatorrollen, EventSub-Ereignisse,
  Chatbefehle.
- Wartung läuft stündlich per Cron. Twitch-Zugänge laufen nach rund vier Stunden
  ab und werden automatisch erneuert; ein Panel-Besuch fällt fast immer in ein
  Fenster, in dem ein Zugang turnusmäßig bald abläuft, ohne dass etwas kaputt
  ist.
- Migrationen der Datenbank laufen für Staging automatisch im Deploy, für
  Production bewusst von Hand.

## Capabilities and Constraints

**Bestätigte Funktionen**

- Anmeldung über Twitch; serverseitige, widerrufbare Sitzungen ohne Token im
  Browser.
- Mitgliederverwaltung je Kanal samt Twitch-Nutzersuche und lückenlosem Audit.
- Zustandsanzeige: Bot-Konto, Moderatorstatus, Token-Zustand, Broadcaster-
  Verbindung, aktive Module.
- Manuelle Nachprüfung des Moderatorstatus mit Sperrzeit gegen Missbrauch.
- Overlay-Zugänge als widerrufbare Token je Kanal.

**Harte Zusicherungen**

- Der Bot **muss** Moderator im Kanal sein. Fehlt die Rolle, ist der Bot kaputt;
  das ist kein Randfall, sondern der häufigste Störfall.
- Der letzte Broadcaster eines Kanals kann weder entfernt noch herabgestuft
  werden.
- Nur ein Broadcaster darf die Rolle `broadcaster` vergeben.
- Jede schreibende Änderung prüft Sitzung und Rolle atomar in derselben
  Datenbankoperation, nicht nur vorab.

**Technische Grenzen**

- Cloudflare Workers mit D1 und Durable Objects; Einzelpaket, kein Monorepo.
- Das Overlay ist eine eigene Oberfläche mit strengen Bundle-Grenzen, per
  ESLint erzwungen. Es gehört nicht zum Panel.
- Sprache ist Deutsch mit echten Umlauten.
- Das Repository ist öffentlich.

**Ausdrücklich unentschieden**

- Was ein `verwalter` über die Broadcaster-Regel hinaus *nicht* darf, ist nicht
  definiert.
- Ein Ereignisprotokoll für Modulverhalten ist beschlossen, aber noch nicht
  gebaut. Es bekommt eine eigene Oberfläche im Panel.
- Mehrsprachigkeit (Deutsch und Englisch) ist eingeplant: Panel-Sprache folgt
  dem Browser, ist aber überschreibbar; die Overlay-Sprache wird davon
  unabhängig eingestellt. Noch nicht umgesetzt.

## Brand Commitments

- Name: **BroBot**. Das Bot-Konto auf Twitch heißt `kompetenzbrobot`.
- Sprache Deutsch, echte Umlaute, keine englischen Fachwortmischungen im
  Oberflächentext.
- Keine Attribution-Zeilen und keine Sitzungs-URLs in Code, Commits oder Doku.
- Es existiert kein Logo, keine Wortmarke und keine festgelegte Farbe.
- **Stehende Vorgabe: konventionelle Gestaltung.** Der Betreiber hat bei der
  Richtungswahl ausdrücklich den Kategoriestandard gewählt statt einer eigenen
  visuellen Welt. Das Panel soll neben Stripe, Cloudflare und Sentry stehen
  können: vertraute Anordnung, konventionelle Navigation, keine Metapher — und
  deren handwerkliches Niveau als Messlatte, nicht als allgemeine Vorstellung
  von „sauber". Künftige Oberflächen folgen dieser Vorgabe ohne erneute Frage.
- Zwei Festlegungen gelten trotz Kategoriestandard weiter: **keine gestapelten
  Karten** als Seitengliederung, und **ein gesunder Zustand erzeugt kein
  Signal**. Beides wurde am Vorgängerentwurf ausdrücklich bemängelt.

## Evidence on Hand

- Laufende Staging-Umgebung unter `brobot-staging.esembe.app`.
- Bestehende Oberfläche in `src/dashboard/` samt `styles.css` als Beweismittel
  des Ist-Zustands.
- Architektur- und Entscheidungsdokumente unter `docs/`, insbesondere
  `docs/ARCHITECTURE.md` und `docs/decisions/`.

**Was nicht existiert und nicht erfunden werden darf:** Nutzerzahlen,
Referenzen, Zitate, Preise, Auszeichnungen, Fallstudien. Es gibt keine zahlende
Kundschaft und keine öffentliche Einführung.

## Product Principles

1. **Stille ist die Normalmeldung.** Ein laufender Bot erzeugt keine Anzeige.
   Aufmerksamkeit wird nur für Abweichung ausgegeben. Eine Oberfläche, die
   dauerhaft warnt, wird nach einem Tag nicht mehr gelesen.
2. **Der Störfall bestimmt die Form, nicht die Einrichtung.** Was man einmal
   tut, darf umständlich sein; was man unter Zeitdruck tut, nicht.
3. **Berechtigung ist ausdrücklich, nie abgeleitet.** Weder aus einer
   Twitch-Rolle noch aus einer vorherigen Prüfung. Das gilt im Datenmodell und
   muss in der Oberfläche sichtbar bleiben.
4. **Der Grund gehört an die Wirkung.** Warum etwas gesperrt ist oder
   fehlschlug, steht dort, wo es wirkt, nicht als Meldung an anderer Stelle.
5. **Module sind austauschbar, das Gerüst nicht.** Zustandssprache, Navigation
   und Rollenmodell gelten für alle Module gleich; ein Modul erfindet keine
   eigene.

## Accessibility & Inclusion

**WCAG AA ist verbindliche Untergrenze**, kein Schönheitsthema. Ein Verstoß ist
ein Fehler und wird geprüft.

- Kontrast AA für Fließtext und Bedienelemente.
- Sichtbarer `focus-visible`-Ring, vollständige Tastaturbedienung.
- Trefferflächen mindestens 44px.
- Zustand nie allein über Farbe: immer zusätzlich Text, Form oder Position.
  Rot-Grün-Unterscheidung darf nie die einzige Information sein.
