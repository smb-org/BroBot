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
unformatiert und fällt auf das Browser-Standardaussehen zurück.

Eine Konfigurationsfläche teilt ihren Inhalt in `.config-section`-Abschnitte.
Jeder Abschnitt beginnt mit einer Überschrift in `.section-heading`, die von
einer Haarlinie getrennt wird; Container-Karten gehören nicht zu dieser Welt.
Die Feldhülle trägt genau eine Inhaltsstufe: `config-field--narrow` für
Zahlen und kurze Werte, `config-field--medium` für Namen und Bezeichner oder
`config-field--wide` für Fließtext.

Für wiederkehrende Panel-Inhalte stellt `src/dashboard/ui` `InspectorSection`,
`InspectorFieldRow`, `InspectorActions`, `DangerSection`, `Badge` und
`FilterBar` bereit. Inspektorabschnitte verwenden kurze Haarlinien-Überschriften;
Feldzeilen setzen das Label links und füllen die rechte Kontrollspalte. Hilfen
stehen am Info-Symbol, Speichern und Verwerfen bleiben am Inspektorfuß, und
Lösch- oder Widerrufshandlungen gehören in `DangerSection`. Tabellen zeigen
Status-Badges; ihre Spalten folgen dem Inhalt und kurze Werte werden nicht
abgeschnitten. Module importieren diese Bauteile aus dem UI-Seam; der Host
enthält keine modulabhängigen Sonderfälle.

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
existiert. Zerstörende Handlungen stehen in `DangerSection` und fragen mit
`inspector-confirmation` an Ort und Stelle nach. Eine Liste fehlender
Berechtigungen ist kein Inspektor und trägt `.sub-inspector` nicht.

## Registrierung

1. Das Modulverzeichnis mit der Pflichtstruktur anlegen.
2. Einen `BotModule`-Wert mit `id`, Settings-Schema und Defaults definieren; optionale EventSub-Typen, `handleEvent`, Routen sowie `overlayElements` und/oder Panel nur bei Bedarf ergänzen.
3. Genau diesen Wert in `src/modules/registry.ts` in `MODULES` eintragen. Das ist die einzige globale Kenntnis aller Module.
4. Prüfen: `pnpm run check`.

### Generische Erweiterungspunkte

Module dürfen über `navigationEntries` lokalisierte Einträge für Kanalnavigation
und Spotlight bereitstellen. `group: "channel"` fügt einen Eintrag neben den
Kanalbereichen ein; ohne Angabe erscheint er unter „Module“.
`showMainSwitch: false` blendet bei dauerhaft verfügbaren Modulansichten den
nicht bedienbaren Hauptschalter aus. Der Host baut daraus Modulrouten; Namen,
Texte, Symbole und Suchbegriffe bleiben beim Modul.
Für nicht abschaltbare Module kann `mandatoryReason` den Grund je Sprache
angeben.

Module können Vorlagenwerte über `resolveTemplateValues(names, context)`
bereitstellen und ihre Namen über `templateFields` oder
`templateVariables(db, channelId)` deklarieren. Der Host extrahiert die Namen
aus dem ursprünglichen Text, fragt nur passende Provider ab und rendert den
Text genau einmal. Eingefügte Werte werden dabei nie erneut als Vorlage
eingelesen. Ein Provider liefert eine Zuordnung von Variablenname zu
Zeichenkette; er schreibt nicht den gesamten Vorlagentext um.
Für zeitabhängige Overlaywerte liefert `resolveOverlayTemplateValues` optional
`nextChangeAt` pro Wert. Die Textbibliothek verwendet diese Contract-Angabe
generisch für den nächsten Overlay-Neuaufbau; sie kennt keine Modulanamen.

Neue Host- und Datenquellenvariablen verwenden einen Punkt im Namen, etwa
`{sun.set}`, `{sun.set_in}` oder `{weather.temp}`. Ein einfacher Name wie
`{welcome}` ist ein Textblock aus `text_library`. Bereits vorhandene einfache
Hostnamen bleiben reserviert und können nicht als Blockname angelegt werden.
Ein Blockverweis wie `{welcome}` wird nur erkannt, wenn er im ursprünglichen
Vorlagentext steht. Eingefügte Chatwerte mit demselben Inhalt bleiben Text und
werden nicht nachträglich als Blockverweis interpretiert.
Die Registry prüft Moduldeklarationen: Nur der ausdrücklich markierte
Textblock-Provider darf einfache Namen deklarieren; alle anderen neuen
Modulvariablen müssen punktgetrennt sein. Die Textbibliothek löst verschachtelte
Blöcke selbst auf und nutzt `context.renderTemplate` nur für die darin
enthaltenen Host-Fragmente. Zufallsauswahl wird nur bei Chat-Ausgaben
gespeichert; Vorschau- und Overlay-Aufrufe bleiben lesend.

Der Host stellt `/api/channels/:channelId/template-variables` für die
Variablenpicker aller Module und `/api/channels/:channelId/games?q=...` für die
Twitch-Kategoriesuche bereit. Module verwenden diese gemeinsamen Routen statt
die HTTP-Routen eines Geschwistermoduls aufzurufen. `{date}`, `{time}` und
zeitabhängige Textblockbedingungen verwenden die Zeitzone aus den
Kanal-Einstellungen.

Ein Modul kann über `textBlockConditions` Bedingungen für Varianten von
Textblöcken bereitstellen. Die Kennung ist punktgetrennt; das Modul löst den
aktuellen Wert beim Rendern auf, während die Textbibliothek Definitionen und
Auswahl speichert. Die gemeinsamen Kanaleinstellungen enthalten ausschließlich
Host-Einstellungen wie Kanalzeitzone und Standort. Eigene Moduleinstellungen
gehören auf die Seite des Moduls (`panel` oder `settingsEditor`). Module
bekommen Host-Werte bei Bedarf über den schreibgeschützten Contract.

Die Sonnendatenquelle liegt eigenständig unter `src/modules/sun/`. Sie nutzt
Open-Meteo-Geocoding über den Host für die Standortsuche. Der Host speichert
Name, Koordinaten und Standortzeitzone in `channels` und stellt sie Sun über
`ModuleTemplateValueContext.channelLocation` und
`ModuleTemplateConditionContext.channelLocation` schreibgeschützt bereit.
Sonnenaufgang, Sonnenuntergang, bürgerliche Dämmerung, Sonnenhöchststand,
Tageslänge sowie goldene und blaue Stunde berechnet das Modul bei jeder
Auflösung lokal mit NOAA-Gleichungen nach Meeus. Die Ausgabezeiten folgen
weiterhin der Kanalzeitzone. Bei Polartag gilt die Sonnenphase als Tag, bei
Polarnacht als Nacht; fehlende Ereigniszeiten verwenden den konfigurierbaren
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

`templateUsageSources` meldet eigene Vorlagentexte für generische
Nutzungsanzeigen. Der Host ergänzt seine eigenen Oberflächenquellen; Module
fragen dafür keine Tabellen anderer Module ab.

Module, die Textblöcke ausführen, können `validateTemplateContent` bereitstellen.
Der Host ruft diese Prüfung beim Anlegen und Bearbeiten eines Textblocks mit
dem vorgeschlagenen Inhalt auf. Das Modul liefert maschinenlesbare Gründe und
den Namen des betroffenen Eintrags; die Textbibliothek zeigt daraus eine
lokalisierte Fehlermeldung. So bleiben auch spätere Änderungen an bereits
verwendeten Blöcken validiert, ohne dass ein Modul sein konsumierendes Modul
importiert oder dessen Tabellen kennt.

Das FAQ-Modul unter `src/modules/faq/` wird direkt nach `text_commands` in der
Registry aufgeführt und nutzt denselben Chat-Event-Typ. Die Dispatch-Reihenfolge
folgt der Registry, damit Befehle vor automatischen Antworten verarbeitet
werden. Das Modul ignoriert jede Nachricht mit Befehlspräfix und vergleicht
Schlüsselwörter und Wortgruppen ohne Beachtung von Groß-/Kleinschreibung oder
Akzenten, aber nur an Unicode-Wortgrenzen. Der erste Treffer in der expliziten
Eintragsreihenfolge gewinnt. Ein kurzer pro-Kanal-Cache hält die vorbereiteten,
normalisierten Matcher; lokale Schreibvorgänge leeren ihn sofort, und Cache-
Einträge laufen nach fünf Sekunden ab. Die Abkühlzeit wird nicht aus dem Cache
übernommen, sondern je Eintrag atomar in D1 beansprucht.

FAQ-Einträge wählen einen Textbaustein, eine optionale Spielauswahl, eine
Abkühlzeit und eines der drei gemeinsamen Chat-Ziele. `source_only` bleibt der
Standard. Antwortbausteine werden beim Speichern sowie über den generischen
`validateTemplateContent`-Contract bei späteren Textbibliotheksänderungen auf
Befehls-Eingabevariablen geprüft. Panel-Test, Aktivierung und Reihenfolge sind
kanalgebundene Modulrouten; Änderungen werden mit Audit-Einträgen gespeichert.
Das Datenmodell lässt einen späteren Regex-Matcher zu, aber die erste
Panel-Version kennt nur Schlüsselwörter und Wortgruppen.

Das erste Modul ist `src/modules/text_commands/`. Es ist in der Registry als
`text_commands` eingetragen, abonniert `channel.chat.message` und definiert
seine Tabellen in der zentralen D1-Kette unter `migrations/`. Der D1-Adapter
dieses Moduls nutzt kanalgebunden `text_commands`, `text_command_aliases`
und `text_command_user_cooldowns`.

Der Host mountet registrierte Modulrouten kanalbezogen unter
`/api/channels/:channelId/modules/<id>`. Textbefehle stellen dort die
CRUD-Routen unter `/commands` bereit. Die Host-Middleware prüft Session,
CSRF und Mitgliedschaft und gibt dem Modul anschließend den Akteur, eine
SQL-gebundene Mutationsautorisierung und eine vorbereitete Audit-Funktion für
Moduldatenänderungen weiter. Das Modul entscheidet selbst, ob es diese
Funktion nutzt; der Host erzwingt sie nicht rückwirkend.

## Aktivierung und Bundles

Ein Modul wird pro Kanal über das Panel aktiviert, nicht per Hand-SQL: Ein Broadcaster
oder Verwalter des Kanals ruft `GET /api/channels/:channelId/modules` auf, um die
Registry mit dem gespeicherten Zustand jedes Moduls zu sehen, und schaltet es über
`PATCH /api/channels/:channelId/modules/:moduleId` mit `{ "enabled": true }` ein oder
aus. Ein `operator` darf die Liste lesen, aber nicht schreiben. Beim Einschalten
schreibt der Worker `defaultSettings` des Moduls in `channel_modules.settings`; eine
eigene Route zum Bearbeiten von Einstellungen gibt es bewusst nicht — dafür ist
`module.panel` aus dem Contract vorgesehen, sobald ein Modul eigene Einstellungen
braucht. Ein Modul kann zusätzlich über den Aktivierungshook einmalige, eigene
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

Das gemeinsame `ChatOutputTargetControl` stellt das kompakte Zielmenü für
einzelne Ausgaben bereit. Es bietet „Alle Chats“ und „Nur unser Chat“ sowie für
Antworten „Wo gefragt“. Ein Infoknopf erklärt, dass das Ziel nur bei Shared
Chat greift. Die sichtbaren Texte sind zweisprachig.

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
`actor: null` bedeutet, dass das Ereignis keinen Nutzer enthält.
Bei `channel.chat.message` leitet der Host zusätzlich aus den Twitch-Badges
den eigenständigen `ModuleEvent.chatStatus` ab. `founder` zählt dabei als
`subscriber`; `moderator` und `broadcaster` erfüllen auch niedrigere Stufen.
Ereignisse ohne Chatbezug tragen dort `null`. Ein Modul kann keinen anderen
Kanal angeben — die Mandantentrennung liegt beim Host.

Wirft `handleEvent`, hält das weder den Worker noch die übrigen Module auf. Der
Fehler landet als `host.modul.fehler` im Ereignisprotokoll.

`overlayElements` deklariert pro Element einen eindeutigen, mit der Modulkennung
präfigierten `kind`, eine `configVersion`, `defaultSize`, `parseConfig` und
`load`. Der Render-Code wird mit `import()` geladen; ein optionaler Editor
verwendet ebenfalls einen Lazy Loader. `initialState` erhält D1-Binding,
Kanalkennung und validierte Konfiguration und läuft beim Bootstrap nur, wenn
das Modul im Kanal aktiviert ist. Der Host speichert `kind` und Konfiguration
als JSON; der Parser validiert sie beim Speichern. Eine deaktivierte Deklaration
bleibt im Entwurf erhalten, rendert nicht und lädt ihren Overlay-Chunk nicht.
Direkte Imports der Ansicht würden diese Bundle-Grenze aufheben.

Das optionale Feld `panel` ist eine Funktion, die ein `import()`-Promise
zurückgibt. So kann Vite für die Panel-Ansicht einen eigenen Chunk schneiden;
ein deaktiviertes Modul kostet im Panel-Bundle null Bytes. Panel-Ansichten
erhalten über `ModulePanelProperties` den bereits geprüften `channelId`.

Textbefehle werden im Panel angelegt, bearbeitet und entfernt. Jede Zeile hat
eine Art (`text`, `list` oder `shoutout`), einen Schalter und eine Mindeststufe
(`everyone`, `subscriber`, `vip`, `moderator` oder `broadcaster`). Die Art `list`
zählt beim Auslösen alle eingeschalteten Zeilen auf. Die angelegten Befehle
werden kanalbezogen als `!<name>` ausgelöst. Der Host löst Systemvariablen und
`{var.<name>}`-Kanalvariablen erst bei der Ausgabe auf; Helix- und D1-Lookups
bleiben lazy und lesen nur die angeforderten Werte. Ein Befehl kann zusätzlich
eine Kanalvariable atomar im Claim-Batch ändern. Revision-CAS und die indizierte
Alias-Tabelle bleiben Teil der bestehenden Befehlsmutationen.

A chat command whose complete configuration is its name, minimum tier, cooldown, template, and exactly one host action is a text-command kind; a feature with its own state or events belongs in its own module.

## Host-owned template variables

`src/template-variables.ts` declares the system-variable names, contexts,
groups, and maximum output lengths. The dashboard owns the bilingual system
descriptions and examples in `src/dashboard/locale.ts`. Module variables may
shadow a same-named system variable within that module's template fields;
channel variables always use the separate `var.` namespace.

The host passes `renderTemplate` and a channel-bound `readChannelVariables`
function through `ModuleExecutionContext`. The renderer first discovers tokens
in the source text, then asks only for the sources those tokens require. A text
without tokens makes no variable D1 read or Helix request. Channel variable
reads use one `channel_id`-scoped query for all requested names.

Text-command variable actions are stored in `text_commands` and are prepared by
the host. The action update shares the command claim batch and is gated by the
claim's `changes()` result, so cooldown rejection cannot change the value. The
action preserves command revision checks, alias indexing, and the existing
cooldown update order.

## Aktionen und Begründungen melden

Ein Modul beschreibt gewünschte Aktionen in der geordneten Liste `actions`.
Chat und Overlay sind semantisch getrennte Varianten; die Reihenfolge bleibt
erhalten und neue Aktionsarten können später additiv ergänzt werden. Das Modul
führt die Aktionen nicht selbst aus.

Chat- und Ankündigungsaktionen können `target: "all_chats"` oder
`target: "source_only"` setzen; fehlende Ziele werden vom Host als
`source_only` behandelt. Antwortaktionen dürfen zusätzlich
`target: "where_asked"` nutzen. Dabei wird der Quellkanal der auslösenden
Chatnachricht generisch vom Host an den Sender weitergereicht. Module kennen
weder Twitchs `for_source_only`-Parameter noch implementieren sie eigene
Shared-Chat-Versandlogik. Auto-Antworten (#245) können denselben
`ModuleAction`-Contract verwenden.

Zusätzlich meldet ein Modul eine fachliche Entscheidung über das Feld
`diagnostics`. Das gilt auch dann, wenn es keine Aktion erzeugt. So kann der
Host erklären, warum eine Aktion bewusst unterblieben ist.

```ts
return {
  actions: [{ kind: "chat", text: "Danke für den Raid!", target: "source_only" }],
  diagnostics: [{
    code: "shoutout.suppressed",
    detail: { grund: "raid_erkannt", zuschauer: 8, schwelle: 10 },
  }],
};
```

`code` ist eine stabile, maschinenlesbare Kennung. `detail` enthält nur die
kleinen Werte, die den Grund erklären, und wird vom Host als JSON gespeichert.
Das Modul schreibt weder selbst in `event_log` noch verwendet es eine
Logging-API. Das Modul begründet Nicht-Handeln. Der Host kennt Kanal, Modul,
`triggerId`, auslösenden Nutzer und Zeitpunkt und protokolliert Handeln und
dessen Ausgang mit host-erzeugten Diagnosen wie `chat.gesendet` oder
`shoutout.fehlgeschlagen` samt Ursache. Dieselbe Schreibfunktion übernimmt
auch die Begrenzung und Löschung der Zeilen; ein Executor existiert noch nicht.

## Grenzen

Module importieren einander nicht. Dadurch bleiben Settings, Domainregeln, Persistenz und UI eines Slices unabhängig austauschbar. Gemeinsame, modulübergreifende Verträge gehören in `src/modules/contract.ts`; fachliche Regeln gehören nicht in diesen Host-Contract. Der Worker kennt nur Host, Registry und die von der Registry bereitgestellten Schnittstellen.
