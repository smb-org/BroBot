# Module

Ein Modul ist ein isolierter Feature-Slice unter `src/modules/<id>/`.

## Pflichtstruktur

```text
src/modules/<id>/
├── contracts/     # öffentliche Typen und fachliche Ein-/Ausgabeverträge
├── domain/        # reine Regeln und Werte ohne Worker-, UI- oder I/O-Abhängigkeit
├── service.ts     # Anwendungsfälle; orchestriert Domain und Repository
├── repository.ts  # kleines Interface für dauerhafte Daten
├── adapters/      # konkrete D1-, Durable-Object- oder externe Adapter
├── overlay/       # optionale schlanke Overlay-Ansicht mit strikten Bundle-Grenzen
└── panel/         # Panel-Ansicht für Formulare und Bedienung
```

`contracts/` beschreibt, was das Modul nach außen anbietet. `domain/` kennt keine Cloudflare-Bindings und kein React. `service.ts` verbindet die fachlichen Regeln mit dem Repository-Interface. `repository.ts` beschreibt nur die benötigte Persistenz. `adapters/` enthält die Infrastrukturimplementierungen. `overlay/` und `panel/` rendern und sammeln Eingaben, greifen aber nur über die jeweils beschriebenen Grenzen auf den Rest des Moduls zu.

`overlay/` enthält ausschließlich die möglichst kleine Overlay-Ansicht. Dort darf kein Worker-, Service-, Repository- oder Adaptercode und kein Zod importiert werden. `panel/` enthält Formulare und Bedienung; dort sind Zod für Formularvalidierung und Zugriffe auf `service.ts` für das Auslösen von Anwendungsfällen erlaubt. Worker-, Repository- und Adaptercode bleibt auch dort verboten. Das wird durch ESLint geprüft.

Eine Panel-Ansicht rendert keine eigene Überschrift mit dem Modulnamen. Der
Host trägt Name, Kennung und Kurzbeschreibung im Eigenschaften-Inspektor; die
Ansicht beginnt direkt mit ihrem fachlichen Inhalt.

### Hülle und Bauteile der Panel-Ansicht

Die äußerste Ansicht liegt in `.module-stack` (normalerweise als `<section>`
mit `aria-label`). Diese Hülle ist die Gestaltungskonvention des Hosts: Sie
vererbt die Regeln für Beschriftungen, Eingabefelder, Textareas, Selects und
Hinweise an die Modul-Ansicht. Ohne `.module-stack` bleibt eine neue Ansicht
unformatiert und fällt auf das Browser-Standardaussehen zurück. Panel-Autoren
übernehmen außerdem die Regeln aus [DESIGN.md, „Stabile Layouts"](../../DESIGN.md#stabile-layouts):
Statuswechsel belegen reservierte Zeilen oder erscheinen als Toast-Overlay,
und Lade-, Leer- und Fehlerzustände behalten dieselbe Mindesthöhe.

Eine Konfigurationsfläche teilt ihren Inhalt in `.config-section`-Abschnitte.
Jeder Abschnitt beginnt mit einer Überschrift in `.section-heading`, die von
einer Haarlinie getrennt wird; Container-Karten gehören nicht zu dieser Welt.
Die Feldhülle trägt genau eine Inhaltsstufe: `config-field--narrow` für
Zahlen und kurze Werte, `config-field--medium` für Namen und Bezeichner oder
`config-field--wide` für Fließtext.

Für wiederkehrende Panel-Inhalte stellt `src/dashboard/ui` `InspectorSection`,
`InspectorFieldRow`, `InspectorActions`, `ActionMenu`, `Badge` und `FilterBar`
bereit. Inspektorabschnitte verwenden kurze Haarlinien-Überschriften;
Feldzeilen setzen das Label links und füllen die rechte Kontrollspalte. Hilfen
stehen am Info-Symbol, Speichern und Verwerfen bleiben am Inspektorfuß, und
zerstörende Handlungen stehen an ihrem Objekt: als letzter roter Menüpunkt nach
einer Trennlinie bei einer Zeile oder ohne eigene Überschrift im
`InspectorActions`-Fuß des geöffneten Objekts als roter Knopf. Zerstörende
Aktionen fragen mit `ConfirmDialog` nach; der Titel nennt das Objekt als Frage,
die Beschreibung nennt in einem Satz die Folge und die Bestätigung nennt Verb
und Objekt. Entwurfsschritte bleiben neutral und ohne Nachfrage. Gesperrte
Aktionen bleiben für Operatoren sichtbar und deaktiviert; der Grund steht einmal
am Abschnitt. Tabellen zeigen
Status-Badges; ihre Spalten folgen dem Inhalt und kurze Werte werden nicht
abgeschnitten. Module importieren diese Bauteile und den Toast-Helfer aus dem
UI-Seam, nie direkt aus Mantine:

```ts
import { notify } from "../../../dashboard/ui";

notify({ tone: "success", message: labels.saved });
```

Der Toast-Host sitzt einmal im Dashboard-Shell; der Host enthält keine
modulabhängigen Sonderfälle.

Eine Tabelle mit wählbaren Zeilen und ihrem Inspektor verwendet das gemeinsame
`ListDetail`: Die Ansicht übergibt `list` und `inspector`, die Komponente hält
Reihenfolge und Layout konsistent. Ab 1280 px steht der 592-px-Inspektor rechts
neben der Liste; darunter öffnet er als überlagernde Fläche mit bis zu 480 px
Breite. Auf kleinen Viewports bleibt die Seite selbst in der Viewportbreite.
Ein Anlegen-Formular belegt dieselbe Fläche wie der Zeileninspektor; beide
schließen sich gegenseitig aus. Die Ansicht stellt Tabellen, Plus-Knopf,
Überschrift sowie Lade-, Fehler- und Leerzustand bereit. Inspektor wie Formular
beginnen mit dem gemeinsamen Kopf (Titel, optionale Kennung in Mono,
Schließen-Taste) und verwenden denselben Schließen-Rückruf für Taste und
Escape. Die Auswahl bleibt beim Nachladen bestehen, solange die Zeile noch
existiert. Zerstörende Handlungen folgen dem Muster am Objekt und bestätigen
mit `ConfirmDialog`. Eine Liste fehlender Berechtigungen ist kein Inspektor und
trägt `.sub-inspector` nicht.
## Registrierung

1. Das Modulverzeichnis mit der Pflichtstruktur anlegen.
2. Einen `BotModule`-Wert definieren. Pflicht sind `id`, `navigationCategory`,
   `settingsSchema` und `defaultSettings`; alles andere (EventSub-Typen,
   `handleEvent`, Routen, Panel, Overlay-Elemente, Alarme, Secrets-Nutzung)
   kommt nur bei Bedarf dazu. Jedes Feld ist in `src/modules/contract.ts`
   dokumentiert; der Contract ist die Quelle, dieser Leitfaden erklärt, wann man
   welches Feld braucht.
3. Genau diesen Wert in `src/modules/registry.ts` in `MODULES` eintragen. Das ist
   die einzige globale Kenntnis aller Module; die Reihenfolge bestimmt auch die
   Dispatch-Reihenfolge je Ereignis.
4. Prüfen: `pnpm run check`.

Die Registry validiert beim Laden und bricht bei Verstößen ab: Overlay-`kind`
mit Modulpräfix und eindeutig, Ereigniszeit-Kennungen (`^[a-z][a-z0-9_]*$`,
zweisprachiges Label), punktgetrennte Variablennamen, eine Variablengruppe sowie
zweisprachige Picker-Texte für jede deklarierte Variable.

Optionale Lebenszyklusfelder: `defaultEnabled` (neue Kanäle erhalten das Modul
aktiviert; Bestandskanäle brauchen eine Backfill-Migration), `mandatory` mit
`mandatoryReason` (nicht abschaltbar), `broadcasterScopes` (Zustimmung, die der
Host vor dem EventSub-Abo prüft), `onEnable` (einmalige Initialdaten),
`scheduledMaintenance` (stündliche Aufräumarbeit) und `variableReferences`
(Kanalvariablen in eigenen Daten; für Einstellungen genügt
`settingsVariableReferences(moduleId, fields)`).

## Wie ein Modul zu seinem Ereignis kommt

`handleEvent` ist der fachliche Einstiegspunkt. Es beschreibt weiterhin in
`ModuleResult.actions`, was geschehen soll, und führt Chataktionen nicht selbst
aus; der Host führt sie aus und protokolliert ihren Ausgang. Für Module mit
eigenem Zustand erhält der Einstiegspunkt zusätzlich den
`ModuleExecutionContext`: Er enthält den D1-Binding und eine vom Host erzeugte,
kanalgebundene Mutationsautorisierung. Das Modul kapselt den Bindingzugriff in
seinem Adapter und kennt weder `channel_members` noch die Sitzungsprüfung.
Das Modul begründet Handeln oder Nicht-Handeln mit `diagnostics` (Entscheidung
0004).

Ein Ereignis erreicht ein Modul nur, wenn alle drei Bedingungen gelten: Das
Modul ist in diesem Kanal aktiviert, es steht in `MODULES`, und der Abo-Typ
steht in seinen `eventSubTypes`.

Der Zielkanal kommt aus dem geprüften Ereignis und wird dem Modul in
`ModuleEvent.channelId` mitgeteilt. Der Host löst außerdem den Akteur anhand
von `channel_members` auf und übergibt `actor` mit User-ID, Login und Rolle.
Eine Rolle `null` bedeutet, dass der Nutzer kein Mitglied dieses Kanals ist;
`actor: null` bedeutet nur, dass der Payload kein `chatter_user_id` trägt: Der
Host wertet ausschließlich dieses Feld aus. Ein Raid-Ereignis enthält
`from_broadcaster_user_id`, erhält aber trotzdem `actor: null`. Wer
Berechtigungen aus `actor` ableitet, darf `null` daher nicht als „kein Nutzer
beteiligt“ lesen.
Bei `channel.chat.message` leitet der Host zusätzlich aus den Twitch-Badges
den eigenständigen `ModuleEvent.chatStatus` ab. `founder` zählt dabei als
`subscriber`; `moderator` und `broadcaster` erfüllen auch niedrigere Stufen.
Ereignisse ohne Chatbezug tragen dort `null`. Ein Modul kann keinen anderen
Kanal angeben — die Mandantentrennung liegt beim Host.

Wirft `handleEvent`, hält das weder den Worker noch die übrigen Module auf. Der
Fehler landet als `host.module.error` im Ereignisprotokoll.

Ein Modul beschreibt gewünschte Aktionen in der geordneten Liste
`ModuleResult.actions`; die Reihenfolge bleibt erhalten, neue Aktionsarten kommen
additiv hinzu. Es gibt `chat`, `announcement`, `shoutout`, `timeout`, `ban` und
`overlay`; das Modul führt keine davon selbst aus. Ausgabeziele,
Ausgabegrenze und Moderation stehen unter „Contract-Fähigkeiten“.

Zusätzlich meldet ein Modul eine fachliche Entscheidung über das Feld
`diagnostics`. Das gilt auch dann, wenn es keine Aktion erzeugt. So kann der
Host erklären, warum eine Aktion bewusst unterblieben ist.

```ts
return {
  actions: [{ kind: "chat", text: "Danke für den Raid!", target: "source_only" }],
  diagnostics: [{
    code: "shoutout.suppressed",
    detail: { reason: "raid_detected", viewers: 8, threshold: 10 },
  }],
};
```

`code` ist eine stabile, maschinenlesbare Kennung. `detail` enthält nur die
kleinen Werte, die den Grund erklären, und wird vom Host als JSON gespeichert.
Das Modul schreibt weder selbst in `event_log` noch verwendet es eine
Logging-API. Das Modul begründet Nicht-Handeln. Der Host kennt Kanal, Modul,
`triggerId`, auslösenden Nutzer und Zeitpunkt und protokolliert Handeln und
dessen Ausgang mit host-erzeugten Diagnosen wie `host.chat.sent` oder
`host.shoutout.failed` samt Ursache. Die Schreibfunktion
fügt nur ein; Aufbewahrungsfrist und Zeilenlimit setzt die geplante Wartung
(`scheduled`) separat durch.

Der Host mountet registrierte Modulrouten kanalbezogen unter
`/api/channels/:channelId/modules/<id>`. Textbefehle stellen dort die
CRUD-Routen unter `/commands` bereit. Die Host-Middleware prüft Session,
CSRF und Mitgliedschaft und gibt dem Modul anschließend den Akteur, eine
SQL-gebundene Mutationsautorisierung und eine vorbereitete Audit-Funktion für
Moduldatenänderungen weiter. Das Modul entscheidet selbst, ob es diese
Funktion nutzt; der Host erzwingt sie nicht rückwirkend.

Das optionale Feld `panel` ist eine Funktion, die ein `import()`-Promise
zurückgibt. So kann Vite für die Panel-Ansicht einen eigenen Chunk schneiden;
ein deaktiviertes Modul kostet im Panel-Bundle null Bytes. Panel-Ansichten
erhalten über `ModulePanelProperties` den bereits geprüften `channelId`.

## Contract-Fähigkeiten

Jeder Abschnitt nennt Zweck, Einsatz, ein kurzes Beispiel und die Grenzen.
Architekturhintergrund (Durable Objects, Datenfluss) steht in
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) und wird hier nicht
wiederholt.

### Vorlagenvariablen, Value-Provider und `nextChangeAt`

**Zweck:** Ein Modul stellt Werte für Chattexte, Textblöcke und Overlays
bereit, ohne Vorlagentexte selbst zu rendern.

**Einsatz:** Deklarieren über `templateFields` (je Einstellungsfeld),
`templateVariableCatalog` (statisch, Pflicht bei `templateVariables`) oder
`templateVariables(db, channelId)` (dynamisch), dazu `templateVariableGroup` und
zweisprachige `picker`-Texte. Auflösen über `resolveTemplateValues(names,
context)`; parametrisierte Werte wie `{currency.convert USD EUR}` über
`resolveTemplateParameter`. `templateUnavailableText` ist der zweisprachige
Rückfalltext.

```ts
templateVariableGroup: { label: { de: "Sonne", en: "Sun" }, icon: { paths: ["M12 3v3"] } },
templateVariableCatalog: [{ name: "sun.set", maxLength: 5, sample: "20:41", picker }],
resolveTemplateValues: async (names, context) => {
  const location = await context.channelLocation();
  return location === null ? {} : { "sun.set": formatSunset(location, context.now) };
},
```

**Grenzen:**

- Neue Variablen sind **punktgetrennt** (`{sun.set}`, `{weather.temp}`). Bare
  Namen sind Textblöcke aus `text_library` (nur dort mit
  `templateVariableNamespace: "text_blocks"`) oder bereits reservierte
  Host-Namen; die Registry lehnt alles andere ab.
- Der Host extrahiert die Namen aus dem Originaltext, fragt nur zuständige
  Provider ab und rendert genau einmal. Eingefügte Werte werden nie erneut als
  Vorlage gelesen; ein Provider liefert nur Name-zu-Zeichenketten-Zuordnungen.
- Kontextwerte kommen aus `ModuleTemplateValueContext` (`channelLocation`,
  `channelTimeZone`, `channelInfo`, `mode`, `secrets` nur lesend,
  `externalFetchBudget`); `mode` unterscheidet `chat`, `preview` und `overlay`.
  Vorschau und Overlay dürfen keinen Zustand schreiben (z. B. keine
  gespeicherte Zufallsauswahl).
- `{date}`, `{time}` und zeitabhängige Bedingungen nutzen die Kanalzeitzone.
- **`nextChangeAt`:** Zeitabhängige Overlaywerte liefert
  `resolveOverlayTemplateValues` als `{ available, targetAt?, targetAts?,
  nextChangeAt? }`. `nextChangeAt` ist der UTC-Zeitpunkt (ISO), ab dem sich der
  Wert ändern kann; der Overlay-Host baut den Text dann neu auf. Browserseitig
  formatierte Werte (Countdowns) werden zusätzlich in
  `dynamicTemplateVariableNames` genannt. Bedingungen melden den Zeitpunkt über
  `addTemplateConditionNextChangeAt` bzw. `resolveTemplateConditionTransitions`.
  Der Host kennt dabei keine Modulnamen.
- Bedingungen für Textblockvarianten: `textBlockConditions` (oder
  `textBlockConditionsForChannel`) mit punktgetrennter Kennung; der aktuelle Wert
  kommt aus `resolveTemplateConditions`, `timeDependent: true` markiert
  zeitabhängige Werte.
- `templateUsageSources` meldet eigene Vorlagentexte für die generische
  Nutzungsanzeige; Module fragen dafür keine Tabellen anderer Module ab.
- Host-Variablen (`src/template-variables.ts`) und Modulvariablen: Eine
  Modulvariable darf innerhalb der Felder des Moduls einen gleichnamigen
  Systemnamen überlagern; Kanalvariablen liegen immer im Namensraum `var.`.

Der Host stellt `/api/channels/:channelId/template-variables` für die
Variablenpicker und `/api/channels/:channelId/games?q=...` für die
Twitch-Kategoriesuche bereit; Module nutzen diese Routen statt die eines
Geschwistermoduls aufzurufen. Eigene Einstellungen eines Moduls gehören auf
dessen Seite (`panel` oder `settingsEditor`), nicht in die Kanaleinstellungen.

### Ereigniszeiten (`eventTimeSources`)

**Zweck:** Ein Modul nennt Zeitpunkte, auf die andere Module planen können
("vor der nächsten Werbepause"), ohne einander zu kennen.

**Einsatz:** `eventTimeSources: [{ id, label: {de, en}, resolve }]`. `resolve`
liefert die künftigen Zeitpunkte als ISO-Strings. Verbraucher rufen
`ModuleAlarmContext.resolveEventTimes(now)` bzw. in Routen `listEventTimeSources`
und `resolveEventTimes` auf; die Kennung erhält vom Host einen Namensraum
(`<moduleId>.<id>`).

```ts
eventTimeSources: [{
  id: "next_ad_break",
  label: { de: "Nächste Werbepause", en: "Next ad break" },
  resolve: async ({ DB, channelId, now }) => (await nextAdAt(DB, channelId, now)) ?? [],
}],
```

**Grenzen:** Nur Zeitpunkte in der Zukunft liefern, keine Modulkennung im
Label. Ändert sich eine Quelle oder die Kanalzeitzone, ruft der Host
`onScheduleInputsChanged` der betroffenen Alarmdefinitionen mit
`event_times` bzw. `channel_time_zone` auf; Verbraucher planen dort neu.

### Inhaltsprüfung (`validateTemplateContent`)

**Zweck:** Ein Verbraucher von Textblöcken (etwa FAQ oder Timer) kann Änderungen
an einem bereits verwendeten Block ablehnen, ohne dass die Textbibliothek ihn
oder seine Tabellen kennt.

**Einsatz:** `validateTemplateContent({ DB, channelId, candidate,
registeredVariables })` liefert eine Liste von `{ reason: "input_dependent",
consumerName }`. Der Host ruft die Prüfung beim Anlegen und Bearbeiten eines
Textblocks mit dem vorgeschlagenen Inhalt auf (in Routen über
`validateTemplateContentMutation`); die Textbibliothek übersetzt die Gründe in
eine lokalisierte Fehlermeldung.

**Grenzen:** Nur maschinenlesbare Gründe und der Name des betroffenen Eintrags,
keine Texte. Eine leere Liste bedeutet "zulässig".

### Chat-Ausgabeziele und Namensnennung

**Zweck:** Chatausgaben wählen, ob sie bei Shared Chat in allen Chats oder nur
im Quellchat erscheinen.

**Einsatz:** `chat` und `announcement` setzen `target: "all_chats"` oder
`"source_only"`; Antworten (`replyToMessageId`) dürfen zusätzlich
`"where_asked"`. Ohne Angabe gilt `source_only`. In Panels bietet
`ChatOutputTargetControl` das Zielmenü (zweisprachig, mit Infoknopf); in
`SettingsEditorSpec` gibt es dafür ein eigenes Bauteil.

```ts
return { actions: [{ kind: "chat", text, target: "source_only" }], diagnostics: [] };
```

**Grenzen:**

- Module kennen weder Twitchs `for_source_only` noch eigene
  Shared-Chat-Logik; der Host reicht den Quellkanal der Nachricht weiter.
- **Namensnennung:** Meldet ein Provider Quellenangaben
  (`addTemplateValueAttribution`, `ModuleResult.attributions`), ergänzt der Host
  sie einmal je Chatnachricht und zeigt sie bei Textblock-Overlays am Element.
  Das Modul platziert sie nicht selbst.
- **Automatisierungsgrenze:** Automatische Chat-Ausgaben laufen durch eine
  gemeinsame Kanalbegrenzung von höchstens einer Nachricht je fünf Sekunden
  (isolatübergreifend). Event-Aktionen ohne freien Platz werden verworfen, nicht
  vorgemerkt; der Host protokolliert `automated_output_rate_limited`. Als
  automatisch gilt jede Ausgabe, außer das Modul setzt `automated: false`
  (direkt angeforderte Befehlsantworten). Alarme senden über
  `ModuleAlarmContext.sendChat` mit Idempotenzschlüssel; bei Ratenbegrenzung
  liefert es `retryable: true`, der Alarm-Handler wirft dann und der Host
  wiederholt ihn (Timer und Chat-Abstimmung tun das); Nachrichten sind auf
  500 Zeichen begrenzt.
- `onDelivery(delivery)` an einer Chataktion meldet `sent`, `rejected`,
  `ambiguous` oder `not_attempted`, damit ein Modul einen Claim (z. B.
  Abkühlzeit) abschließen oder freigeben kann.

### Host-Moderationsaktionen

**Zweck:** Ein Modul beschreibt eine Moderationsmaßnahme; der Host führt sie über
Twitch Helix mit dem Bot-Token aus (`src/worker/moderation.ts`).

**Einsatz:** `{ kind: "timeout", userId, durationSeconds, reason, onSuccess?,
onFailure? }`. `onSuccess`/`onFailure` sind vorgerenderte Chataktionen; der Host
sendet höchstens eine, bei unklarem Helix-Ausgang keine. Die Hilfen
`rollTimeoutSeconds`, `TimeoutDurationRange` und `formatTimeoutDuration` liegen
in `src/modules/contracts/moderation.ts`.

**Grenzen:**

- Dauer 1 bis 1.209.600 Sekunden, Grund höchstens 500 Zeichen. Der Host schützt
  Broadcaster und Bot, verlangt den gespeicherten Moderatorstatus, beachtet die
  kanalgebundene 429-Abklingzeit und wiederholt nie.
- Bei **Stummschaltung oder Pause** wird die Aktion unterdrückt
  (`channel_muted`, `channel_paused`); der Host prüft das vor und nochmals kurz
  vor dem Helix-Aufruf, weil sich die Kanalsteuerung dazwischen ändern kann.
  Aufheben ist davon ausgenommen.
- Alarme, die eine Maßnahme nachholen, rufen `ModuleAlarmContext.executeTimeout`
  auf (Ergebnis `applied`, `rejected`, `ambiguous` oder `suppressed`). Wer
  zeitversetzt handelt, prüft Aktivierung und Zustand dort erneut, statt der
  Planung zu vertrauen (siehe Alarme).
- Der Aktionstyp `ban` ist im Contract vorhanden, aber **derzeit keinem Modul
  oder Panel angeboten**; nur `timeout` ist offen.
- `ModuleRouteVariables.liftModerationBan(channelId, userId, expected)` hebt eine
  Sperre aus einer Modulroute auf. `expected` (Grund, Dauer, Beginn) sichert ab,
  dass nur der erwartete Timeout aufgehoben wird; Twitch bietet keine bedingte
  Löschung, ein Wechsel direkt zwischen Prüfung und Löschung bleibt daher
  möglich.

### Ballot-Speicher

**Zweck:** Flüchtige, personenfreie Abstimmungen im Channel Durable Object
(Chat-Abstimmung, Votekick), ohne einzelne Stimmen in D1 zu speichern.

**Einsatz:** `context.ballots` (Ereignis, Alarm) bzw. `ballots(channelId)`
(Route) ist bereits an Kanal und Modul gebunden:

```ts
const opened = await context.ballots.open(id, 2, expiresAt, {
  passIf: { yes: 0, no: 1, netAtLeast: 5 },
});
if (opened.status === "busy") return busyResult(opened.moduleId);
const choice = ballotChoiceFromMessage(text, 2);        // null unless a lone digit
if (choice !== null) await context.ballots.cast(id, userId, choice);
const { outcome, counts } = await context.ballots.finalize(id); // passed | expired | open | not_open
```

**Grenzen:**

- **Ein offener Ballot je Kanal**, modulübergreifend: `open` meldet `busy` mit
  der Modulkennung des Besitzers; `hasOpenBallot()` fragt die Sperre ab, damit
  ein Panel den Start deaktivieren und erklären kann.
- Stimmen nur über `ballotChoiceFromMessage(text, optionCount)` (einzelne Ziffer
  1 bis 9, höchstens `optionCount`). Ein Nutzer darf umentscheiden, die letzte
  Wahl zählt. Der Ablaufzeitpunkt liegt höchstens 24 Stunden in der Zukunft.
- Die **Passregel** wird beim Öffnen als Daten (`BallotFinalizeRule`) gespeichert
  und bei `finalize` atomar gegen den aktuellen Stand ausgewertet; ein Modul
  rechnet nie selbst nach.
- `finalize` ist **idempotent**: Wiederholen liefert denselben Ausgang. Ein
  finalisierter Ballot bleibt mit eingefrorenem Zählerstand lesbar und weist
  Stimmen mit `not_open` ab. `close` löscht die Ballotdaten und legt einen
  Wiederholungs-Snapshot für wiederholte Closes ab; erst `acknowledgeClosed`
  (nach dem Persistieren des Ergebnisses) entfernt ihn**. Den
  Kanalplatz gibt bereits die terminale Finalisierung frei, ein anderes Modul
  kann also schon vorher einen neuen Ballot öffnen.
- Gespeichert werden nur Zähler, Revision und je Person ein HMAC; Ergebniszeilen
  in D1 enthalten keine einzelnen Wählerkennungen (Votekick speichert zusätzlich
  Ziel und Initiator und löscht sie nach 14 Tagen). Overlays lesen über
  `ModuleOverlayElementContext.readBallot` ausschließlich den Ballot des eigenen
  Moduls.

### Aktive Chatter (`needsActiveChatters`)

**Zweck:** Schwellen, die von der Zahl aktiver Chatter abhängen (Votekick),
ohne dass jedes Modul Chatverläufe mitschreibt.

**Einsatz:** `needsActiveChatters: true` im Modul; dann liefert
`ModuleExecutionContext.activeChatters` `count(windowMs)` (verschiedene Chatter
im Fenster) und `seen(userId)` (erster und letzter Aktivitätszeitpunkt).

```ts
const active = await context.activeChatters.count(10 * 60_000);
const threshold = Math.max(minNetYes, Math.ceil(active * share));
```

**Grenzen:** Der Host speichert Aktivität nur, solange mindestens ein Modul mit
dieser Deklaration im Kanal aktiviert ist. Das ist ein rollendes Fenster pro
Chatter unter einem HMAC mit kanalgebundenem Zufallsschlüssel (spätestens nach
24 Stunden rotiert, dabei werden alle Einträge gelöscht). **Aufbewahrung:** Ein
keyed Host-Alarm löscht Einträge nach 60 Minuten Inaktivität plus
Alarmverzögerung; `stream.offline` löscht sofort. Eine laufende
Chatverarbeitung kann Daten neu anlegen, die der Alarm wieder entfernt.

### Navigation (`navigationCategory`) und Seitenleiste

**Zweck:** Der Host baut die Seitenleiste aus den Modulen; Namen, Texte und
Symbole bleiben beim Modul.

**Einsatz:** Jedes Modul deklariert genau eine `navigationCategory`: `chat`,
`interaction`, `data` oder `twitch`. Der Host gruppiert aktivierte, berechtigte
Module unter den lokalisierten Kategorieüberschriften (nur diese vier Texte
übersetzt der Host) und nutzt den Modulnamen als Eintrag. Eigene
`navigationEntries` (`id`, zweisprachiges `label` und `description`, `iconKind`,
`keywords`) ersetzen Namen und Symbol für Seitenleiste und Spotlight; sie wählen
keine eigene Kategorie. `panelIcon` liefert Pfaddaten für das Symbol.

**Grenzen:** Die frühere Angabe `group: "channel"` entfällt. `showMainSwitch:
false` am Eintrag blendet den Hauptschalter bei dauerhaft verfügbaren Seiten aus;
`mandatory` mit `mandatoryReason` erklärt, warum ein Modul nicht abschaltbar ist.

### Modul-Secrets (`ModuleSecretAccess`)

**Zweck:** Zugangsdaten eines Moduls (z. B. eine Statistik-URL mit Schlüssel)
liegen verschlüsselt pro Kanal und Modul außerhalb von Einstellungen und
Audit-Payload.

**Einsatz:** Routen erhalten `secrets(channelId)`, Alarme `context.secrets`,
Vorlagenprovider nur `status` und `read`. Schreiben und Löschen laufen als
vorbereitete Statements:

```ts
const write = await secrets.prepareWrite(NAME, value, actor, now);
const audit = prepareModuleAudit({ channelId, moduleId, action: "module.secret.replaced",
  before: null, after: { statsUrl: "replaced" } }, now);
const result = await DB.batch([write, audit]);
if ((result[0]?.meta.changes ?? 0) === 0) return managementDenied(context);
```

**Grenzen:**

- Das Schreib- und Löschstatement trägt die **verwaltende Rollenprüfung** (siehe
  `authorizeManagementMutation`) und gehört **im selben D1-Batch** wie sein
  Audit-Statement; eine nicht berechtigte Rolle ändert null Zeilen. Audit-Werte
  sind nur `replaced` oder `removed`, nie der Klartext.
- `readWithVersion(name)` liefert `{ value, version }`. `version` ist die
  gespeicherte verschlüsselte Hülle: wiederholt sich nie (zufällige IV, auch nach
  Löschen und Neuanlegen), verrät nichts und dient nur dem **Gleichheitsvergleich**
  für abhängige Schreibvorgänge (z. B. ein Testergebnis, das nur zur gelesenen
  Fassung passen darf).
- **Nie loggen, nie zurückgeben:** weder Wert noch `version` in Logs, Fehlern,
  Routenantworten, Audits, Ereignisprotokoll oder Moduldaten. Routen melden feste
  Fehlercodes. Dauert eine Route (Body lesen, Netzwerkabruf), prüft sie die
  Verwaltungsberechtigung vor dem Zugriff auf das Secret erneut, wie `belabox`.
- Overlay-`initialState` hat keinen Secret-Zugriff. Die Host-Verschlüsselung
  bindet Hülle an Kanal, Modul und Name; kopierte Zeilen lassen sich nicht lesen.

### BELABOX-Verlauf

Nur ein verbundener Relay-Poll im Intervallmodus bestätigt den aktuellen
Twitch-Stream als BELABOX-Stream. Ab dieser Messung schreibt das Modul
`belabox_minutes` und hält `belabox_streams` laufend aktuell. Vorherige
Erkennungsproben, Deskstreams und Messungen im Modus „bei Bedarf“ erzeugen keine
Verlaufsdaten. Der kumulative Paketverlustzähler wird als Delta summiert; sinkt
er, zählt der neue Stand als Reset.

Die Live-Panelreihe kommt aus dem begrenzten Zehn-Minuten-Puffer in
`belabox_status`; die Streamreihe kommt aus Minutenmittelwerten. Ein
angenommener `stream.offline`-Übergang finalisiert die Zusammenfassung und
berechnet P10 aus den Minutenmittelwerten. Stundenwartung löscht nur
Minutenzeilen nach 30 Tagen. Streamzusammenfassungen bleiben unbegrenzt, weil
sie aggregiert sind und keine Personendaten enthalten (Entscheidung 0003).
Routenabfragen binden `channel_id`; `/history` liefert pro Messpunkt nur
numerische Werte.

### Sofortaktionen (`immediateActions`)

**Zweck:** Eine Karte in der Sofortaktionsleiste des Kanals (Werbung, Raid,
Clip), nur solange das Modul aktiviert ist.

**Einsatz:**

```ts
immediateActions: { requires: ["streamLive"], load: () => import("./panel/immediate-actions") },
```

**Grenzen:** `requires` listet Bedingungen, die der Host selbst auswertet
(derzeit nur `streamLive`); er übergibt `availabilityReason` lokalisiert an die
Karte, die ihre Steuerung entsprechend sperrt. `canManage` übergibt zusätzlich
die Kanalrolle für managementpflichtige Kartenaktionen; die Route prüft die
Berechtigung weiterhin selbst. `load` bleibt ein lazy `import()`,
damit ein deaktiviertes Modul null Bytes kostet. Die Karte ruft Modul- oder Host-Routen auf (Clip und Raid
nutzen `/api/channels/:channelId/clips` bzw. `/shoutout`);
`requires` ist eine reine Verfügbarkeitsprüfung im Dashboard. Voraussetzungen
auf der Serverseite setzt jede Route selbst durch (Berechtigung, Aktivierung)
oder Twitch (etwa ein Clip nur bei laufendem Stream).

### Overlay-Elemente (`overlayElements`)

**Zweck:** Ein Modul liefert Darstellungen für gespeicherte Overlays
(Textblock, Abstimmungsstand, Werbe-Countdown).

**Einsatz:** Pro Element `kind` (`<moduleId>.<name>`, eindeutig), `configVersion`,
`defaultSize`, `defaultConfig`, `parseConfig` und `load`; optional `editor`.
`editorLabel` und `editorDescription` liefern den zweisprachigen Namen und die
einzeilige Beschreibung in der Overlay-Element-Palette. Die Gruppe stammt aus
`navigationCategory` des Moduls; die Elementdeklaration führt keine eigene
Palette-Kategorie ein. `editorDescription` wird für jede Sprache (`de`, `en`)
gesetzt, damit aktivierte und ausgeschaltete Module dieselbe vollständige
Palette-Zeile erhalten.

```ts
overlayElements: [{
  kind: "chat_voting.tally", configVersion: 1, defaultSize: { width: 480, height: 240 },
  defaultConfig: {}, parseConfig, load: () => import("./overlay/tally"),
  editorLabel: { de: "Abstimmungsergebnis", en: "Voting tally" },
  editorDescription: { de: "Live-Balken der Abstimmung.", en: "Live bars for the current vote." },
  initialState: (db, channelId) => readOpenTally(db, channelId),
  mergeRealtimeState: (current, incoming) => ({ ...current, ...incoming }),
}],
```

**Grenzen:**

- **Lazy:** `load` und `editor` sind `import()`-Loader. Eine deaktivierte
  Deklaration bleibt im Entwurf erhalten, rendert nicht und lädt ihren Chunk
  nicht; direkte Imports der Ansicht heben die Bundle-Grenze auf (ESLint
  prüft das). `overlay/` importiert weder Worker- noch Zod-Code.
- **`initialState(db, channelId, config, context?)`** läuft beim Bootstrap nur,
  wenn das Modul im Kanal aktiviert ist, und erhält keinen Secret-Zugriff.
  `initialStateNeedsContext: true` reicht Vorlagen-, Bedingungs- und
  Kanalkontext durch.
- **Echtzeit:** Das Modul sendet Zustandsänderungen mit
  `publishModuleOverlayMessage` bzw. der Aktion `kind: "overlay"`
  (optional mit `recipientConfig`, um nur Overlays mit passender Konfiguration
  zu erreichen). `mergeRealtimeState` führt Teilzustände in den aktuellen Stand
  zusammen, ohne Lebenszyklusdaten zu ersetzen; Zähler tragen eine monotone
  Revision (`chat_voting.tally` nutzt sie, um veraltete Stände zu ignorieren).
  `reloadStateOnModuleMessages` und `reloadStateOnHostEvents`
  (`channel.game.changed`, `stream.state.changed`, `template.data.changed`)
  veranlassen stattdessen ein Neuladen über `initialState`.
- **`previewState(config, language, now)`** (optional) erzeugt einen
  sprachabhängigen Beispielzustand für die Kompositionsvorschau aus Konfiguration,
  Kanalsprache und aktuellem Zeitpunkt.
- Der Host speichert `kind` und Konfiguration als JSON; `parseConfig` validiert
  beim Speichern und liefert `null` bei ungültiger Eingabe.

### Keyed Modul-Alarme (`alarms`)

**Zweck:** Zeitgesteuerte Arbeit (Abstimmung schließen, Timer auslösen) über
die gemeinsame Alarmtabelle des Channel Durable Object, statt eigener
Scheduler.

**Einsatz:** Ein Modul registriert je Handler eine `ModuleAlarmDefinition` mit
stabilem `key`; geplant wird ein **Alarmschlüssel** (eine Instanz, z. B.
`timer:<id>`) mit Fälligkeit. Aus `handleEvent` über
`context.scheduleAlarm(handlerKey, alarmKey, deadline, ownerRevision?)` und
`clearAlarm`, aus dem Handler über `context.schedule(key, deadline)` und `clear`.

```ts
alarms: [{
  key: "close",
  retryDelaysMs: [5_000, 15_000, 60_000],
  handle: async (context, alarmKey) => closeExpired(context, alarmKey),
  onScheduleInputsChanged: async (context, reason) => replan(context, reason),
}],
```

**Grenzen:**

- **Der Host wiederholt jede geworfene Ausnahme.** Er klassifiziert keine
  vorübergehenden Fehler, sondern protokolliert und wiederholt mit
  `retryDelaysMs` (letzter Wert wird unbegrenzt wiederverwendet). Bei veralteter
  Arbeit (gelöschter Eintrag, überholte `ownerRevision`, erledigter Vorgang)
  kehrt der Handler daher einfach normal zurück; ein normaler Rückgang schließt
  nur den unveränderten, beanspruchten Eintrag ab und lässt neuere Pläne
  unberührt. Ein ausdrückliches `clear` trägt `ownerRevision`. Geworfen wird nur,
  wenn eine Wiederholung gewollt ist. Deshalb muss der
  Handler **idempotent** sein und jeden Zustand selbst prüfen, statt dem Alarm zu
  vertrauen.
- `ownerRevision` verhindert, dass ein veralteter Alarm einen neu geplanten
  überschreibt: Handler vergleicht sie mit der Revision der eigenen Zeile.
- `ModuleAlarmContext` bietet `DB`, `secrets`, `ballots`, `storage`
  (`get`/`put`/`delete`, auf das Modul beschränkt), `renderTemplate`,
  `sendChat` (siehe Ausgabegrenze; `stillValid` prüft unmittelbar vor dem Senden
  erneut, ob die Ausgabe noch gelten soll), `executeTimeout`,
  `publishModuleOverlayMessage` und `resolveEventTimes`.
- `onScheduleInputsChanged(context, reason)` plant dauerhafte Pläne neu bei
  `event_times`, `channel_time_zone` und `activation`. **`activation`** deckt den
  Fall ab, dass ein Modul oder der Kanal ausgeschaltet war: der Host stellt ein
  Ereignis nur an aktivierte Module zu, ein `stream.online` im
  ausgeschalteten Zustand erreicht das Modul nie. Eine Kanalpause hält
  Dispatch an nicht verpflichtende Module an; `mandatory`-Module (etwa
  `channel_events` mit `stream.online`) erhalten Ereignisse trotzdem.
- Routen können einen Handler sofort ausführen
  (`runModuleAlarm(channelId, moduleId, handlerKey, alarmKey)`); dort gibt es
  keine automatische Wiederholung.
- **Externe Datenquellen:** Alarme mit externen Abrufen verwenden das gemeinsame
  `ModuleAlarmContext.externalFetchBudget`. Erwartbare Anbieterfehler werden als
  modulinterner Zustand gespeichert und nicht geworfen, wenn der Host sie weder
  loggen noch mit seinem Alarm-Backoff wiederholen soll. Phasenwechsel können
  über `ModuleAlarmContext.writeDiagnostics` in das Ereignisprotokoll geschrieben
  werden; Details bleiben dabei auf feste Codes begrenzt.

### Host-Variablen und Kanalvariablen

`src/template-variables.ts` deklariert Namen, Kontexte, Gruppen und maximale
Ausgabelängen der Systemvariablen; die zweisprachigen Beschreibungen und
Beispiele liegen in `src/dashboard/locale.ts`. Der Host übergibt `renderTemplate`
und die kanalgebundene Funktion `readChannelVariables` über den
`ModuleExecutionContext`. Der Renderer sucht zuerst die Token im Originaltext
und fragt nur die dafür nötigen Quellen ab: Ein Text ohne Token löst weder einen
D1-Lesezugriff auf Variablen noch eine Helix-Anfrage aus, und Kanalvariablen
werden mit einer einzigen `channel_id`-gebundenen Abfrage gelesen.

Variablenaktionen von Textbefehlen liegen in `text_commands` und werden vom Host
vorbereitet. Die Aktualisierung teilt sich den Claim-Batch des Befehls und läuft
vor dem Claim; dieser prüft ihr `changes()`-Ergebnis. Die Abkühlzeit sichern
Prädikate in der Variablenaktualisierung selbst, eine Ablehnung ändert den
Wert daher nie. Revisionsprüfung, Alias-Index und Reihenfolge der
Abkühlzeit-Aktualisierung bleiben erhalten.

## Aktivierung und Bundles

Ein Modul wird pro Kanal über das Panel aktiviert, nicht per Hand-SQL: Ein Broadcaster
oder Verwalter des Kanals ruft `GET /api/channels/:channelId/modules` auf, um die
Registry mit dem gespeicherten Zustand jedes Moduls zu sehen, und schaltet es über
`PATCH /api/channels/:channelId/modules/:moduleId` mit `{ "enabled": true }` ein oder
aus. Ein `operator` darf die Liste lesen, aber nicht schreiben. Beim Einschalten
schreibt der Worker `defaultSettings` des Moduls in `channel_modules.settings`; Einstellungen
liest der Host über `GET /api/channels/:channelId/modules/:moduleId/settings` und
schreibt sie über `PATCH` derselben Route (mit `settings` und `revision` im Body, Prüfung gegen
`settingsSchema`, Verwalter-Berechtigung und Revisionskonflikt); für eigene
Formulare ist `module.panel` bzw. `module.settingsEditor` vorgesehen. Ein Modul kann zusätzlich über den Aktivierungshook einmalige, eigene
Initialdaten anlegen. Das erfordert keinen Deploy.

Für ein Modul, dessen Einstellungen sich vollständig aus den Naht-Bauteilen
zusammensetzen (Zahl, Text, Vorlage, Segment, Kartenwahl, Schalterkarte,
Chat-Ausgabeziel), muss
kein eigenes Formular geschrieben werden: `module.settingsEditor` nimmt
stattdessen eine `SettingsEditorSpec<Settings>`-Deklaration entgegen — lazy wie
`panel`, in `modules/<id>/panel/settings-editor.ts`, damit ein ausgeschaltetes
Modul weiterhin null Bytes kostet. Der Host rendert daraus in
`module-panels.tsx` den `EditorShell` samt Laden, Speichern, Server-Hinweisen,
409-Konflikt und der lesenden Fassung für Rollen ohne Recht — einmal gebaut,
nicht je Modul. Hat `settingsSchema` mindestens einen Schlüssel, verlangt ein
Guard-Test (`module-settings-editor-guard.test.ts`) die Deklaration; ein leeres
Schema (etwa Kanalereignisse) bleibt ohne Editor. `panel` bleibt daneben für
Module mit eigenem Zustand oder Sofortaktionen (Werbung); wo beide stehen,
erscheint `panel` oben und der `settingsEditor` darunter.

Jede Validierung, die das Speichern blockiert, muss einen sichtbaren Feldfehler
liefern. `EditorShell.invalidFields` verwendet `{ id, label, message, sectionId }`
für die Feldliste in der Speicherleiste, die Tab-Fehlerpunkte und den Fokus auf
das erste fehlerhafte Feld. Die Liste und `SettingsEditor.fieldErrors` müssen
daher dieselbe Validierung abbilden.

## Referenzmodule

Die folgenden Module zeigen die Fähigkeiten im Zusammenspiel; Details ihrer Fachlogik stehen hier, nicht im Contract.

### Astronomie-, Wetter- und Währungsquellen

Die Sonnendatenquelle liegt eigenständig unter `src/modules/sun/`. Sie nutzt
Open-Meteo-Geocoding über den Host für die Standortsuche. Der Host speichert
Name, Koordinaten und Standortzeitzone in `channels` und stellt sie Sun über
`ModuleTemplateValueContext.channelLocation` und
`ModuleTemplateConditionContext.channelLocation` schreibgeschützt bereit.
Sonnenaufgang, Sonnenuntergang, bürgerliche Dämmerung, Sonnenhöchststand,
Tageslänge sowie goldene und blaue Stunde berechnet das Modul bei jeder
Auflösung lokal mit NOAA-Gleichungen nach Meeus. Die Ausgabezeiten folgen
weiterhin der Kanalzeitzone. Bei Polartag bzw. Polarnacht liefert die Höhenwinkel-Phase
weiterhin `golden_hour` oder `blue_hour` vorrangig; sonst gilt Tag bzw. Nacht; fehlende Ereigniszeiten verwenden den konfigurierbaren
zweisprachigen Fehlertext.

Die Monddatenquelle unter `src/modules/moon/` berechnet Mondphase, Beleuchtung
und Mondauf- sowie -untergang lokal mit den niedrigpräzisen Meeus-Reihen. Beide
Astronomiemodule lesen Standort und Zeitzonen ausschließlich über den
schreibgeschützten Host-Contract; das Moon-Modul speichert nur seine eigenen
zweisprachigen Fehlertexte.

Die Wetterdatenquelle `src/modules/weather/` verwendet den Kanalstandort aus
dem schreibgeschützten Contract oder einen Ort aus dem Befehlsargument.
MET Norway ist der Standardanbieter; Open-Meteo lässt sich je Kanal auswählen.
Beide Adapter liefern dieselbe normalisierte Wetterstruktur. Der Cache trennt
Anbieter und auf vier Nachkommastellen gerundete Koordinaten. MET Norway wird
bis zum Ablaufzeitpunkt des Anbieters zwischengespeichert, mit einer Obergrenze
von 24 Stunden als Sicherheitsnetz; Open-Meteo nutzt höchstens 15 Minuten.
Quellen, Lizenz
und Nutzungsgrenze stehen auf der Wetterseite. Die allgemeine Host-Ausführung
ergänzt gemeldete Namensnennungen einmal je Chatnachricht und zeigt sie bei
Textblock-Overlays am Element an.

Die Währungsdatenquelle `src/modules/currency/` stellt den parameterisierten
Vorlagenwert `{currency.convert USD EUR}` für Textbefehle bereit. Der Betrag
kommt aus dem ersten Befehlsargument, Wechselkurse werden je Währungspaar
zwischengespeichert und die Ausgabe richtet sich nach der Kanalsprache. Wetter
und Währung sind eigenständige Module und werden ausschließlich über Contract
und Registry eingebunden.

### Eigene API-Quellen

`src/modules/api_source/` ergänzt die Datenquellen über Contract und Registry.
Broadcaster und Manager eines Kanals können höchstens 20 Quellen anlegen. Der
Name besteht aus Kleinbuchstaben, Ziffern und Unterstrichen und beginnt mit
einem Buchstaben. Eine Quelle enthält eine HTTPS-URL und optional einen
JSONata-Ausdruck. In Texten und Textblöcken wird sie als
`{api_source.value sunset}` verwendet. Eine nichtleere JSONata-Quelle lässt
sich außerdem als boolesche Bedingung für Textblockvarianten auswählen.

Beispiele ohne JavaScript:

- **Sonnenuntergang:** URL
  `https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&daily=sunset&timezone=Europe%2FBerlin`, Ausdruck
  `$substring($.daily.sunset[0], 11, 5)`, Quelle `sunset`.
- **USD nach EUR:** URL
  bei einer JSON-Antwort mit `rates.EUR` und `amount` zum Beispiel
  `$formatNumber($.rates.EUR * $.amount, '#,##0.00') & ' EUR'`, Quelle
  `usd_eur`.

JSONata 2.2.2 ist als exakte Abhängigkeit festgeschrieben. Ausdrücke sind auf
512 Zeichen begrenzt; ihr AST wird beim Speichern und erneut vor jeder
Auswertung geprüft. Die Sicherheitsgrenze ist eine AST-Knotentyp-Allowlist:
erlaubt sind Feldpfade mit optionalen nichtnegativen Ganzzahlindizes wie
`$.daily.sunset[0]`, Zeichenketten-, Zahlen-, Boolesche- und Null-Literale,
`+`, `-`, `*`, `/`, `%`, Vergleiche, `and`, `or`, `&`, `?:` und direkte Aufrufe
der festgelegten Funktionen `$string`, `$number`, `$boolean`, `$not`, `$exists`,
`$length`, `$substring`, `$substringBefore`, `$substringAfter`, `$uppercase`,
`$lowercase`, `$trim`, `$contains`, `$join`, `$sum`, `$max`, `$min`, `$average`,
`$count`, `$round`, `$floor`, `$ceil`, `$abs`, `$formatNumber`, `$fromMillis`,
`$toMillis`, `$now`, `$split` und `$replace`. Die Prozedur eines Aufrufs muss
ein unverziertes allowlistiertes `$name` sein; alle Argumente werden rekursiv
geprüft. Es sind höchstens 64 AST-Knoten und 12 Ebenen erlaubt. Arrays und
Objekte, andere Prädikate, Wildcards, `**`, Sortierung, Gruppierung,
Transformationen, Blöcke, Bindings, Lambdas, partielle Anwendung,
Funktionsverkettung, Regexliterale und alle nicht ausdrücklich freigegebenen
Knotentypen oder Eigenschaften werden zurückgewiesen. Eine Funktions-Blockliste
reicht nicht: sie übersieht Konstrukte und Kind-Eigenschaften außerhalb der
Funktionsargumente, etwa das Prädikat an `$join` in `$join[$pad(...)](...)`.
Damit können JSON-Antworten nicht als neue Ausdrücke ausgewertet werden und der
synchrone Regex-Pfad steht nicht zur Verfügung. Es gibt keine vom Nutzer
bereitgestellten Funktionen oder Bindings. Die JSON-Eingabe ist
höchstens 64 KiB, 64 Ebenen und 20.000 Knoten groß; Sequenzen sind auf 1.000
Elemente begrenzt. `$split` liefert höchstens 1.000 Teile. `$join` und
`$replace` begrenzen erzeugte Zeichenketten bereits beim Aufbau auf 2.000
Zeichen. `$replace` erfordert ein Zeichenkettenmuster und ein festes
Ganzzahllimit von höchstens zehn Treffern. Die fertige Vorlagenausgabe bleibt
ebenfalls auf 2.000 Zeichen begrenzt.

Die JSONata-Option für ein 10-ms-Timeout wird nicht verwendet: Sie prüft nur
zwischen Auswertungsschritten und kann dadurch auch einfache Ausdrücke unter
Last zurückweisen, ohne eine harte CPU-Garantie zu geben. Je Vorlagenlauf
werden höchstens zehn verschiedene Quellen-Ausdruck-Paare
ausgewertet; wiederholte Platzhalter verwenden dasselbe Ergebnis. Der
kombinierte CPU-Test rendert verschachtelte Textblöcke, zwei Bedingungen und
drei JSONata-Ausdrücke mit höchstens drei Netzwerkabrufen. Seine CPU-Messung
läuft in Node und ist keine Workers-CPU-Garantie.

Die URL-Regeln lassen nur HTTPS auf Standardport 443 zu. Zugangsdaten in der
URL, Fragmente und IP-Literale sind gesperrt; ebenso lokale, private,
reservierte, Cloudflare- und eigene Hostnamen. Weiterleitungen werden höchstens
drei Mal manuell verfolgt und bei jedem Sprung erneut geprüft. Antworten werden
über den gemeinsamen begrenzten JSON-Reader auf 64 KiB beschränkt. Pro Kanal
sind 100 echte HTTP-Aufrufe je Stunde und pro Vorlagenlauf höchstens drei
ausgehende HTTP-Aufrufe einschließlich Weiterleitungen erlaubt. Antworten
werden nach einem Hash aus Kanal-ID und URL standardmäßig 60 Sekunden und
höchstens fünf Minuten zwischengespeichert. `private`, `no-store` und
`no-cache` verhindern das Speichern; `max-age` gilt innerhalb derselben
TTL-Grenzen. Der Overlay-Host plant für Werte und Bedingungen nach 60 Sekunden
eine erneute Auflösung.

Die verbleibende DNS-Rebinding-Grenze steht in Entscheidung 0013. Ein
DNS-Name kann nach der Prüfung auf eine interne IP-Adresse aufgelöst werden;
Workers `fetch` legt die aufgelöste IP nicht offen und erlaubt nicht, sie für
die Verbindung festzuhalten.

### FAQ

Das FAQ-Modul unter `src/modules/faq/` wird direkt nach `text_commands` in der
Registry aufgeführt und nutzt denselben Chat-Event-Typ. Die Dispatch-Reihenfolge
folgt der Registry, damit Befehle vor automatischen Antworten verarbeitet
werden. Das Modul ignoriert jede Nachricht mit Befehlspräfix und vergleicht
Schlüsselwörter und Wortgruppen ohne Beachtung von Groß-/Kleinschreibung oder
Akzenten, mit `ß`/`ẞ` als `ss`. Buchstaben- und Ziffernseiten müssen an einer
Unicode-Wortgrenze liegen; Symbolseiten wie Emojis dürfen überall stehen. Vor
der Auswahl des ersten Treffers werden Spieleignung und bekannter Spielstatus
geprüft. Ein kurzer pro-Kanal-Cache hält die vorbereiteten, normalisierten
Matcher; lokale Schreibvorgänge leeren ihn sofort, und Cache-Einträge laufen
nach fünf Sekunden ab. Die Abkühlzeit beträgt mindestens 30 Sekunden. D1
reserviert sie vor dem Senden; bei Erfolg oder unklarem Ausgang bleibt sie
bestehen, bei sicherem Nichtversand wird sie freigegeben.

FAQ-Einträge wählen einen Textbaustein, eine optionale Spielauswahl, eine
Abkühlzeit (mindestens 30 Sekunden) und eines der drei gemeinsamen Chat-Ziele. `source_only` bleibt der
Standard. Antwortbausteine werden beim Speichern sowie über den generischen
`validateTemplateContent`-Contract bei späteren Textbibliotheksänderungen auf
Befehls-Eingabevariablen geprüft. Panel-Test, Aktivierung und Reihenfolge sind
kanalgebundene Modulrouten; Änderungen werden mit Audit-Einträgen gespeichert.
Das Datenmodell lässt einen späteren Regex-Matcher zu, aber die erste
Panel-Version kennt nur Schlüsselwörter und Wortgruppen.

### Chat-Abstimmung

Das Modul `src/modules/chat_voting/` startet Ja/Nein-, 1-bis-5- und
2-bis-9-Optionen-Abstimmungen über das Panel oder `!vote yesno`, `!vote scale`
und `!vote <n>`. Nur Moderatoren und Broadcaster können Chatbefehle starten
oder beenden; die Panel-Aktion steht allen Kanalmitgliedern offen. Stimmen
Ziffernstimmen werden nur bei einer exakten Ziffer über den kanalgebundenen
Ballot im Channel Durable Object gezählt; Freitext-Stimmen verwenden dessen
generischen Term-Ballot. Ein Nutzer kann seine Stimme ändern; die letzte Wahl
zählt. Pro Kanal bleibt höchstens ein Ballot offen, auch wenn ein anderes Modul
ihn gestartet hat.

Die Modulroute startet und beendet Abstimmungen, und ein einzelner
Modul-Alarm schließt sie nach dem optionalen Timer oder spätestens nach vier
Stunden. Die Ergebniszeile `chat_votes` speichert nur Voreinstellung,
Beschriftungen und aggregierte Zähler; einzelne Abstimmende werden nicht in D1
gespeichert. Das Overlay-Element `chat_voting.tally` lädt den offenen Stand
beim Start und nimmt Zähler mit monotoner Revision entgegen. Panel und Overlay
bleiben lazy geladen.

Die Presets `!vote 01` und `!vote 12` zählen ausschließlich Nachrichten, die
genau aus der jeweiligen Ziffer bestehen; `0` gilt nur bei `01`. Im Panel sind
die beiden Beschriftungspaare frei änderbar. `!vote text`, `!vote text word`
und `!vote text message` starten Freitext-Abstimmungen: `word` (Standard)
zählt das erste normalisierte Wort, `message` die normalisierte Nachricht mit
höchstens 25 Zeichen. Pro Zuschauer zählt die letzte gültige Stimme. Das Panel
zeigt alle Begriffe, das Overlay die fünf häufigsten mit Anzahl und Prozent.
Neue Begriffe bleiben dort als `?` verborgen, bis ein Moderator sie im Panel
freigibt. Die Freigabe lädt zuerst die aktuelle Twitch-Liste blockierter
Begriffe; kann Twitch diese Liste nicht liefern, bleibt der Begriff im Overlay
verborgen. Der generische Ballot-Contract speichert Stimmen pro Abstimmung nur
unter einem gehashten Zuschauerschlüssel und begrenzt die Zahl verschiedener
Begriffe auf 200; weitere Stimmen fließen in den Zähler „weitere“.

Das Panel zeigt auf breiten Ansichten Konfiguration und Ergebnis nebeneinander;
auf schmalen Ansichten stehen alle Steuerelemente oberhalb des Ergebnisses.
Typen stehen in einem gruppierten `Select` mit Chat-Eingabehinweisen. Die
Beschriftungsfelder sind pro Taste und gelten nur für diese Abstimmung;
`/current` liefert ihre vorbelegten Standardwerte, `/start` nimmt die
verwendeten Beschriftungen an. Die Einstellungen bleiben die Quelle für
Standardwerte und Chatbefehle. Während eines Ballots bleibt die gesperrte
Konfiguration mit den Werten des laufenden Ballots sichtbar. Dauer ist eine
Auswahl aus Offen, 1, 2 oder 5 Minuten und eigener Dauer bis vier Stunden; das
Sekundenfeld erscheint nur für die eigene Dauer.

Die Ergebniszeilen stehen beim Start fest: eine je gespeicherter Beschriftung,
bei Freitext genau fünf. Stimmen erscheinen als 12-px-Balken mit Zahl und
Prozent in festen Spalten; Ergebniszahl und Zeit stehen im Kopf. Scheitert das
Einplanen eines manuellen Schlusses, stellt das Modul den vorherigen
Schließgrund wieder her; Fehler im Alarmhandler werden vom Host mit Backoff
erneut versucht. Der Host stellt `ModuleBallotAccess.hasOpenBallot()` als
generische Abfrage der kanalweiten Sperre bereit, damit das Panel auch einen
Votekick erklären und den Start deaktivieren kann, ohne ein anderes Modul zu
importieren. Leere Beschriftungen verwenden Platzhalterwerte als Vorschau und
bleiben optional; ungültige eigene Beschriftungen werden erst nach Interaktion
markiert. Der Wert `autoCloseSeconds: 0` zeigt „Aus“ im Panel.

### Textbefehle

Das erste Modul ist `src/modules/text_commands/`. Es ist in der Registry als
`text_commands` eingetragen, abonniert `channel.chat.message` und definiert
seine Tabellen in der zentralen D1-Kette unter `migrations/`. Der D1-Adapter
dieses Moduls nutzt kanalgebunden `text_commands`, `text_command_aliases`
und `text_command_user_cooldowns`.

Ein Textbefehl der Art `timeout` speichert eine optionale Antwort bei Erfolg,
einen Timeout-Bereich von 1 bis 1.209.600 Sekunden, einen optionalen Grund und
einen optionalen Ersatztext bei Ablehnung. Leere Antwort- und Ersatztexte
erzeugen keine Chataktion.
Der Dienst zieht die Dauer einmal mit `rollTimeoutSeconds` und dem vom Host
bereitgestellten `secureRandomInteger`; derselbe Wert steuert die Host-Aktion
und die Variablen `{timeout.seconds}` sowie `{timeout.duration}` in Antwort,
Grund und Ersatztext. Für Broadcaster und Moderatoren wird nur der Ersatztext
gerendert. Dauer, Grund und Ersatztext liegen auf der vorhandenen Befehlstabelle
und werden gemeinsam mit der Kanalvariablenaktion und dem Audit-Eintrag
gespeichert. Migration `0031_text_command_timeout_kind.sql` wandelt vorhandene
Antwortbefehle mit Timeoutaktion in `timeout` um und bewahrt ihre übrigen Felder.
Migration `0033_text_command_silent_timeout.sql` erlaubt leere Erfolgstexte für
`timeout`-Befehle, während Antworttext für andere Arten weiter erforderlich bleibt.

Textbefehle werden im Panel angelegt, bearbeitet und entfernt. Jede Zeile hat
eine Art (`text`, `list`, `shoutout` oder `timeout`), einen Schalter und eine Mindeststufe
(`everyone`, `subscriber`, `vip`, `moderator` oder `broadcaster`). Die Art `list`
zählt beim Auslösen alle eingeschalteten Zeilen auf. Die angelegten Befehle
werden kanalbezogen als `!<name>` ausgelöst. Der Host löst Systemvariablen und
`{var.<name>}`-Kanalvariablen erst bei der Ausgabe auf; Helix- und D1-Lookups
bleiben lazy und lesen nur die angeforderten Werte. Ein Befehl kann zusätzlich
eine Kanalvariable atomar im Claim-Batch ändern. Revision-CAS und die indizierte
Alias-Tabelle bleiben Teil der bestehenden Befehlsmutationen.

Das Antwortfeld bietet am Textanfang `/timeout {user} <seconds|min-max>
[reason]`, `/announce <text>` und `/shoutout {target}` an. Beim Speichern werden
gültige Formen in Art, Antwortart und Timeoutfelder umgewandelt und aus dem
Antworttext entfernt. Zur Laufzeit wird kein Slash-Befehl geparst; gerenderte
`{args}`-Werte können daher keine Aktion auslösen.

Ein Chatbefehl, dessen gesamte Konfiguration aus Name, Mindeststufe, Abkühlzeit, Vorlage und genau einer Host-Aktion besteht, ist eine Art der Textbefehle; eine Funktion mit eigenem Zustand oder eigenen Ereignissen gehört in ein eigenes Modul.

### BELABOX-Bitraten- und Verbindungsalarme (#323)

`src/modules/belabox/domain/alert.ts` hält den Alarmablauf als reine Funktion
`advanceAlert(state, sample, settings, now)` fest. Halte- und Erholungszeiten
werden gegen Zeitstempel erfolgreicher Relay-Messungen gerechnet; `now` dient
nur der Chat-Abkühlzeit. Eine bestätigte BELABOX-Verbindung ist Voraussetzung
für Alarme und Abrufhinweise. Ein Stream ohne erfolgreiche Encoder-Verbindung
bleibt im Probe-Modus und erzeugt keinen Disconnect- oder Abrufhinweis.

Die Einstellungen beginnen bei 1.000 kbps für den Niedrig- und 2.000 kbps für
den Erholungsschwellwert. Haltezeiten müssen mindestens dem Abrufintervall
entsprechen. Weil der bestehende Abrufstandard 15 Sekunden beträgt, startet
`holdSeconds` ebenfalls bei 15 Sekunden; bei einem 5-Sekunden-Intervall ist
der kürzere 10-Sekunden-Wert zulässig. Die drei Chatvorlagen werden beim
Aktivieren passend zur Kanalsprache gesetzt; Migration
`0041_belabox_alerts.sql` ergänzt auch Bestandskonfigurationen sprachgerecht.
Die Vorlagen nutzen deklarierte
`{belabox.bitrate}`- und `{belabox.down_for}`-Variablen.

Der Statusadapter speichert ausschließlich normalisierte Stichproben und den
Alarmzustand; rohe Relay-Antworten bleiben flüchtig. Die Alarmmeldung läuft
über `ModuleAlarmContext.sendChat` mit stream- und episodenbezogenem
Idempotenzschlüssel sowie einer erneuten Phasenprüfung direkt vor der Ausgabe.
Abruffehler senden nie Chat; ein dauerhafter Hinweis erscheint erst nach drei
aufeinanderfolgenden Fehlern. Die Modulansicht reserviert dafür eine feste
Statuszeile. „Jetzt prüfen“ testet die gespeicherte URL über `/test` und
aktualisiert den Sample-Stand. Die Sofortaktion wird nur bei live erkanntem
Stream aus ihrem lazy Modul-Loader geladen. Phasenwechsel verwenden ausschließlich die festen
Diagnosecodes `belabox.alert_started`, `belabox.alert_escalated` und
`belabox.alert_recovered` mit numerischen Schwell- und Zeitwerten.

### Votekick

`src/modules/votekick/` nutzt den gemeinsamen Ballot-Speicher und die
Aktivitätsübersicht der letzten zehn Minuten. VIPs, Moderatoren und Broadcaster
können `!votekick <login>` starten; Broadcaster, Moderatoren und der Bot sind
geschützte Ziele. Der Host prüft Moderatoren mit dem Scope `moderation:read`
und dem Broadcaster-Token. Die Ja-Stimme des Starters zählt sofort. Die
Schwelle ist das Maximum aus Mindest-Netto-Ja-Stimmen und aufgerundetem Anteil
aktiver Chatter.
Ein erfolgreicher Ballot gibt dem Host eine Timeoutaktion mit fester oder
zufälliger Dauer bis 3.600 Sekunden. Ein registrierter Modul-Alarm beendet
abgelaufene Abstimmungen; die generische stündliche Modulwartung löscht rohe
Ziel-ID, Ziel-Login und Starter-ID nach 14 Tagen. Das Panel kann laufende
Ballots abbrechen und nur einen noch aktiven, passenden Votekick-Timeout
aufheben. Vor dem Aufheben vergleicht der Host den aktuellen Twitch-Eintrag
mit Moderator, Ballot-ID, Dauer und Ablaufzeit. Twitch bietet für das Löschen
keine bedingte Sperr-ID; eine Änderung direkt zwischen Prüfung und Löschung
kann daher nicht atomar ausgeschlossen werden.

## Checkliste für ein neues Modul

- [ ] **Contract:** `id`, `navigationCategory`, `settingsSchema`, `defaultSettings`; nur benötigte optionale Felder (`eventSubTypes`, `routes`, `panel` oder `settingsEditor` lazy, `defaultEnabled` bewusst gewählt). Bei Secrets, Ballots oder aktiven Chattern die jeweilige Deklaration und den Zugriff nur über den Kontext nutzen.
- [ ] **Registry:** Wert in `MODULES` in `src/modules/registry.ts` eintragen, an der Stelle, die die Dispatch-Reihenfolge verlangt; die Registry-Validierung (Variablen, Overlay-`kind`, Ereigniszeiten) läuft grün.
- [ ] **Migrationen:** Tabellen in der zentralen Kette unter `migrations/`, immer mit `channel_id`; für Bestandskanäle bei `defaultEnabled` eine Backfill-Migration; Schreibvorgänge mit `authorizeMutation` und Audit im selben D1-Batch.
- [ ] **Zweisprachige Kataloge:** Modulname in `src/dashboard/module-labels.ts`, Panel- und Fehlertexte, Picker-Texte, Navigationseinträge, Bedingungen und Ereigniszeit-Labels jeweils mit `de` und `en`. Deutsche Texte nur in den dafür freigegebenen Katalogdateien (`tests/unit/german-guard.test.ts`).
- [ ] **Panel:** `.module-stack`-Hülle, Bauteile aus `src/dashboard/ui`, jede blockierende Validierung als sichtbarer Feldfehler; `settingsEditor`, sobald `settingsSchema` Schlüssel hat.
- [ ] **Tests:** Domain und Service als Unit-Tests, Routen mit Rollen (Operator darf nicht verwalten), Mandantentrennung über `channelId`. **Bei Secrets zusätzlich Leak-Tests:** ein Sentinel-Wert darf in Logs, Routenantworten, Audits, Ereignisprotokoll und Moduldaten für jeden Ausgang (Erfolg, Fehler, Timeout) nirgends auftauchen (Vorbild: `tests/unit/belabox.test.ts`, `tests/unit/module-secrets.test.ts`). Alarmhandler idempotent und mit überholtem Zustand prüfen.
- [ ] **Doku:** Fachliche Besonderheiten in diesem Leitfaden, Architekturwirkung in `docs/ARCHITECTURE.md` (verlinken statt wiederholen), Betrieb in `docs/OPERATIONS.md`. Nur Platzhalter und fiktive Logins, keine echten Namen oder Secrets.
- [ ] **Vor dem Push:** `pnpm run check`.

## Grenzen

Module importieren einander nicht. Dadurch bleiben Settings, Domainregeln, Persistenz und UI eines Slices unabhängig austauschbar. Gemeinsame, modulübergreifende Verträge gehören in `src/modules/contract.ts`; fachliche Regeln gehören nicht in diesen Host-Contract. Der Worker kennt nur Host, Registry und die von der Registry bereitgestellten Schnittstellen.
