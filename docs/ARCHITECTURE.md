# Architektur

Die vollständige Stack-Entscheidung liegt in [Decision 0001](decisions/0001-stack-und-plattform.md). Dieses Dokument beschreibt, wie sie für das Grundgerüst von BroBot umgesetzt wird.

## Laufzeit und Datenfluss

Eine Cloudflare-Worker-Deployment-Einheit liefert die statischen React-Dateien und später API-, EventSub- und WebSocket-Routen aus. Das Gerüst beantwortet bereits `/healthz` und reicht alle anderen Anfragen an Static Assets weiter.

```text
Twitch EventSub
      │ Webhook
      ▼
Worker / Hono ───────► D1
      │                 │ Konfiguration und Verbindungen
      │ channelId
      ▼
Channel Durable Object (SQLite + WebSocket-Hibernation)
      │ WebSocket
      ▼
OBS-/StreamElements-Overlay
```

Der Ereignisfluss für Chatmodule ist: EventSub → Worker → Akteurauflösung aus
`channel_members` → fachliches Modul → Host-Executor → Twitch-Chat. Ein
Durable Object wird deterministisch aus dem `channelId`-Namen angesprochen und
bleibt für die spätere Echtzeitstrecke zuständig. Der Worker bleibt das Gateway
für HTTP und die Module.

## Modulsystem

Ein Modul ist ein Feature-Slice unter `src/modules/<id>` mit `contracts/`,
`domain/`, `service.ts`, `repository.ts`, `adapters/`, `overlay/` und
`panel/`. Das erste konkrete Modul ist `src/modules/text_commands/`. Es
ergänzt den Contract um den vom Host aufgelösten `ModuleEvent.actor`, den
`ModuleExecutionContext` für den eigenen D1-Adapter und typisierte Props für
seine lazy Panel-Ansicht. Sein Schema liegt, wie bei jedem Modul mit eigenen
Tabellen, in der zentralen D1-Kette unter `migrations/`.

`src/modules/registry.ts` ist die einzige Stelle, die alle Module kennt. Der
Worker mountet registrierte Router kanalbezogen unter
`/api/channels/:channelId/modules/<id>`. Ein Modul wird aktiviert, indem in
`channel_modules` eine Zeile für den jeweiligen `channel_id` und `module_id`
mit `enabled = 1` steht. Dafür ist kein Deploy erforderlich.

Module stellen Vorlagenwerte über `resolveTemplateValues(names, context)` und
deklarierte Variablen über `templateFields` oder `templateVariables` bereit.
Der Host extrahiert die Namen aus dem ursprünglichen Text, sammelt passende
Werte und rendert genau einmal; eingefügte Werte werden nicht erneut gelesen.
Neue Host- und Datenquellenvariablen sind punktgetrennt (`{sun.set}`), einfache
Namen wie `{welcome}` bezeichnen Textblöcke. Bereits vorhandene einfache
Hostnamen bleiben reserviert. Nur der markierte Textblock-Provider darf solche
Blocknamen registrieren und verschachtelte Blöcke intern auflösen.

Picker und Twitch-Kategoriesuche verwenden die Host-Routen
`/api/channels/:channelId/template-variables` und
`/api/channels/:channelId/games?q=...`; Module rufen keine Routen anderer
Module auf. Die Kanalzeitzone liegt in der Host-Tabelle `channels` und gilt
für `{date}`, `{time}` sowie zeitabhängige Textblockbedingungen.

Die Sonnendatenquellen `src/modules/sun/` und `src/modules/moon/` ergänzen den
Contract um eigene Templatewerte. Der Standort
ist eine Host-Kanaleinstellung in `channels`; der Host stellt ihn Modulen über
den Contract schreibgeschützt bereit. Die Standortsuche verwendet Open-Meteo-
Geocoding; der Dialog zeigt dazu die von der CC-BY-4.0-Lizenz geforderte
Namensnennung neben den Suchergebnissen. Sonnenaufgang, Sonnenuntergang,
Morgendämmerung, Sonnenhöchststand, Tageslänge sowie goldene und blaue Stunde
berechnet das Sun-Modul lokal mit den NOAA-Gleichungen nach Meeus. Das Moon-Modul
berechnet Mondphase, Beleuchtung und Mondauf- sowie -untergang lokal mit den
niedrigpräzisen Meeus-Reihen, sodass tägliche
Berechnungen keinen externen Dienst benötigen. D1 hält je Kanal genau die
beiden lokalen Datumszeilen für heute und morgen. Der Durable-Object-Alarm
erneuert sie um 00:15 Uhr in der Kanalzeitzone; ein vorhandener gültiger
Eintrag bleibt bei einem Fehler bis zu seinem Ablauf nutzbar. Polartag und
Polarnacht sind als Zustände gespeichert, statt nicht existierende
Ereigniszeiten zu schätzen. Beide Module lesen Standort und Kanalzeitzone über
den schreibgeschützten Contract; eigene Moduleinstellungen enthalten nur die
zweisprachigen Fehlertexte.

Die Wetterdatenquelle unter `src/modules/weather/` liest den Kanalstandort über
denselben schreibgeschützten Contract. Ein Ortsname im auslösenden Textbefehl
überschreibt ihn und wird über Open-Meteo-Geocoding aufgelöst. Der Adapter
normalisiert MET Norway (Standard) und Open-Meteo (pro Kanal auswählbar) auf
dieselbe Wetterstruktur; der Cache ist nach Anbieter und auf vier
Nachkommastellen gerundeten Koordinaten getrennt und berücksichtigt die
Ablaufzeit des Anbieters. Die Wetterseite nennt Quellen, Lizenz und
Nutzungsgrenze. Der Host hängt die vom Modul gemeldete Namensnennung generisch
einmal an Chatnachrichten mit Wetterwerten an und reserviert dafür Platz im
Nachrichtenlimit; Textblock-Overlays zeigen dieselbe Namensnennung am Element.

Die Währungsdatenquelle unter `src/modules/currency/` stellt
`{currency.convert USD EUR}` für Textbefehle bereit. Der Betrag kommt aus dem
Befehlsargument, der Wechselkurs wird je Währungspaar zwischengespeichert und
die Ausgabe folgt der Kanalsprache. Beide Datenquellen besitzen eigene
Tabellen und Einstellungen; sie werden ausschließlich über den
Modul-Contract und die Registry eingebunden.

Das Modul `src/modules/api_source/` lässt Broadcaster und Manager je Kanal bis
zu 20 benannte HTTPS-JSON-Quellen mit optionalem JSONata-Ausdruck pflegen.
`{api_source.value sunset}` gibt den ausgewerteten Wert aus; derselbe Ausdruck
kann als boolesche Textblockbedingung gewählt werden. Die API-Beispiele und
Sicherheitsgrenzen stehen in `src/modules/README.md` und Entscheidung 0013.
Die URL-Sicherheitsprüfung liegt im Modul, HTTP-Aufrufe laufen manuell über
höchstens drei validierte Weiterleitungen, und der Worker gibt weder Cookies
noch Zugangsdaten weiter. D1 speichert Antworten nach URL-Hash und zählt
Netzwerkaufrufe je Kanal und Stunde. Ein Vorlagenlauf teilt sein Budget von
drei externen HTTP-Aufrufen mit allen verschachtelten Blöcken und Bedingungen.
Das Modul ist über Contract und Registry angeschlossen.

Migration `0016_text_library.sql` führte Textblöcke und zunächst eine
Bibliothekszeitzone ein. `0017_text_library_variant_choices.sql` ergänzte den
Zufallswahlindex je Variante. Migration `0018_template_value_providers.sql`
überführt die gespeicherten Zeitzonen in die Kanaleinstellungen, entfernt die
Bibliothekseinstellung und benennt gespeicherte Ads-Platzhalter auf
`{ads.duration}` und `{ads.seconds}` um. Migration `0019_sun_data_source.sql`
aktiviert die Sonnendatenquelle für bestehende Kanäle und legte zunächst
Standort- und Sonneneinstellungen im Modul an. Migration
`0020_channel_location.sql` verschiebt den Standort in die Host-Tabelle
`channels`; `sun_settings` enthält danach nur noch die Fehlertexte des
Sonnenmoduls. Migration `0021_moon_data_source.sql` aktiviert die Monddatenquelle
für bestehende Kanäle und legt ihre Fehlertexteinstellungen an.

Migration `0022_weather_currency_data_sources.sql` legt die Anbietereinstellungen
und getrennte Wetter- sowie Wechselkurs-Caches an und aktiviert beide Quellen
für bestehende Kanäle.

Migration `0023_timers.sql` legt kanaleigene Zeitgeber an und aktiviert das
Modul für bestehende Kanäle. Zeitgeber planen ihre Läufe über den registrierten
Durable-Object-Alarmhandler. Der Channel Durable Object zählt Chatnachrichten
und speichert Ausführungsschlüssel sieben Tage lang atomar vor dem Chatversand;
die gemeinsame Versandgrenze ergänzt Namensnennungen und begrenzt Ausgaben auf
500 Zeichen. Ereigniszeiten kommen über den generischen
`eventTimeSources`-Contract, den Sun- und Ads-Modul bereitstellen. Der
Zeitgeber kennt weder deren Modulnamen noch deren Tabellen. Er rendert
Textblöcke über die allgemeine Vorlagenpipeline und lehnt beim Speichern Blöcke
mit chatbefehlabhängigen Variablen ab.

Ein Modul kann `needsActiveChatters` deklarieren. Während es im Kanal aktiviert
ist, ergänzt der bestehende Chat-Aktivitätsaufruf im Channel Durable Object je
Person den ersten und letzten Aktivitätszeitpunkt unter einem HMAC mit
streameigenem Zufallsschlüssel. `ModuleExecutionContext.activeChatters` bietet
die Fensterzählung und die Aktivitätsabfrage. Beim Streamende löscht der Host
Schlüssel und Einträge; ein eigener Host-Alarm erzwingt dieselbe Löschung
spätestens 24 Stunden nach Streambeginn. Die Speicherung nutzt den bestehenden
Chat-Aktivitätsaufruf und fügt keinen zweiten Schreibaufruf je Chatnachricht hinzu.

Migration `0025_chat_output_targets.sql` ergänzt Textbefehle und Zeitgeber um
ein Chat-Ausgabeziel; bestehende Zeilen erhalten `source_only`. Auch neue
Ereignistexte verwenden standardmäßig dieses Ziel. Der gemeinsame
`ChatOutputTarget`-Contract kennt `all_chats`, `source_only` und für
Antwortaktionen `where_asked`. Der Host übersetzt das Ziel für Chatnachrichten
und Ankündigungen in `for_source_only`. Bei `where_asked` entscheidet
`source_broadcaster_user_id`: eine eigene Nachricht bleibt im eigenen Chat,
eine Nachricht aus einem Partnerkanal wird an alle Teilnehmer gespiegelt.
Fehlender Herkunftskanal gilt als eigener Chat. Außerhalb von Shared Chat hat
die Einstellung keine Wirkung. Ziele sind je Textbefehl, Ereignistext,
Raid-/Werbetext und Zeitgeber konfigurierbar; Wetter- und Währungsantworten
verwenden das Ziel des Textbefehls. Änderungen an gespeicherten Zielen werden
mit den jeweiligen Modulmutationen auditiert. Auto-Antworten (#245) können
denselben Contract und dieselbe Host-Versandgrenze verwenden.

Migration `0026_api_sources.sql` legt benannte Quellen, den URL-Cache und das
stündliche Kanalkontingent an; sie aktiviert das Modul für bestehende Kanäle.

Migration `0027_faq.sql` legt kanalgebundene FAQ-Einträge mit geordneter
Schlüsselwort-/Wortgruppenliste, Textbaustein, Abkühlzeit, optionalen Spielen
und Chat-Ausgabeziel an. Das FAQ-Modul steht in der Registry direkt hinter
`text_commands`; die Dispatch-Reihenfolge folgt der Registrierung statt der
nicht festgelegten D1-Zeilenfolge. Befehlspräfixe werden vor dem FAQ-Matcher
übersprungen, und die verbundene Bot-Kennung schließt eigene Nachrichten aus.
Der Matcher faltet Groß-/Kleinschreibung und Akzente, prüft Unicode-Wortgrenzen
und nutzt einen kurzlebigen Cache bereits normalisierter Begriffe je Kanal.
Eine Aktualisierung im Panel leert diesen Cache sofort; andere Worker-Isolate
laden Änderungen spätestens nach fünf Sekunden. Die Abkühlzeit wird nicht aus
dem Cache übernommen, sondern je Eintrag mit einem bedingten D1-Update atomar
beansprucht. Die Messung mit 100 Einträgen folgt dem bestehenden
10-ms-CPU-Maßstab für Chat-Vorlagen. Das Datenmodell reserviert einen
Matcher-Typ für Regex; die erste Oberfläche speichert und wertet aber nur
Schlüsselwörter und Wortgruppen aus.

Das Overlay und das Panel laden ihre Quellen über einen `import()`-Promise. Dadurch kann Vite beide Ansichten in eigene Chunks schneiden; ein deaktiviertes Modul kostet in keinem der beiden Bundles Bytes. Direkte Imports wären deshalb bewusst zu vermeidende Bundle-Kopplungen.

ESLint schützt die Grenze: Overlay-Ansichten importieren weder Worker-, Service-, Repository- oder Adaptercode noch Zod. Panel-Ansichten importieren weder Worker-, Repository- noch Adaptercode; Zod und der Service sind dort für Formulare und ausgelöste Anwendungsfälle erlaubt. Module importieren keine Geschwistermodule. Der Worker importiert kein React.

### Panel

Das Admin- und Mod-Panel ist die primäre Bedienoberfläche. Sein Grundgerüst gehört dem Host; die konkrete Ansicht kommt pro Modul optional über den `BotModule`-Contract hinzu. Overlay- und Panel-Ansichten werden lazy geladen, damit ein deaktiviertes Modul in keinem der beiden Bundles Gewicht trägt.

Serverdaten bleiben autoritativ: Eine Live-Nachricht meldet nur, dass sich etwas geändert hat; den aktuellen Stand lädt das Panel über die API nach. Das Textbefehle-Panel lädt und mutiert seine Liste über `/api/channels/:channelId/modules/text_commands/commands`; die Ansicht bleibt lazy und führt keinen Worker-, Repository- oder Adaptercode aus.

Sichtbare Panel-Texte eines Moduls stehen gesammelt in dessen Panel-Locale.
Die gemeinsame Sprachauflösung und Datumsformatierung liegt in
`src/dashboard/locale.ts`; neue Ansichten verdrahten kein neues `de-DE`.

### Kanalgebundene API und Schreibschutz

Kanalgebundene API-Routen hängen verbindlich unter
`/api/channels/:channelId/...`. `channelId` kommt aus dem Routenparameter und
ist der Mandantenschlüssel; die Autorisierung prüft genau diesen Kanal in
`channels` und die Mitgliedschaft desselben Session-Benutzers in
`channel_members`. Eine Request-Rolle wird nicht übernommen, und eine
Twitch-Moderatorrolle ersetzt keine Mitgliedschaft. Schreibende Routen
verwenden den gemeinsamen Guard aus `src/worker/auth/guards.ts`, der die
Datenbankrolle in den Hono-Kontext legt.

Für schreibende Browser-Anfragen gibt `/api/csrf` ein signiertes
Double-Submit-Token aus. Das Token ist mit dem vorhandenen
`SESSION_COOKIE_KEYS`-Schlüsselring an die Session gebunden und muss sowohl im
nicht-HttpOnly-Cookie als auch im `X-CSRF-Token`-Header zurückkommen; dadurch
bleibt der Worker zustandslos und `SameSite=Lax` ist nicht die alleinige
Abwehr.

### Gespeicherte Overlays und Browserausgabe

Ein gespeichertes Overlay gehört zu genau einem Kanal. Es enthält Name,
Leinwandgröße, optionale CSS-Regeln und geordnete Elemente mit Position,
Skalierung, Sichtbarkeit und einer Referenz auf eine Kanalvariable. Dashboard
und Editor verwalten diese Daten über
`/api/channels/:channelId/overlays`; Änderungen werden mit Revisionen geprüft
und über `overlay.changed` an verbundene Quellen gemeldet. Der Editor und die
Browserausgabe verwenden dieselbe React-Renderstrecke, damit Vorschau und
Stream denselben Inhalt zeigen.

Für jedes gespeicherte Overlay können Broadcaster und Verwalter benannte
Zugänge ausstellen. Ein Zugang ist an Kanal und Overlay gebunden. D1 speichert
den Pepper-Hash zur Prüfung sowie den
verschlüsselt gespeicherten Token zur erneuten Anzeige. Die vollständige URL
wird nur beim Ausstellen oder erneuten Anzeigen an berechtigte Mitglieder
zurückgegeben; sie enthält den Token im Fragment, das Browser nicht an den
Worker oder als `Referer` senden. OAuth- und Twitch-Tokens kommen nie in diese
URL. Das Fragment bleibt in OBS und den Widget-Einstellungen sichtbar und ist
wie ein Passwort zu schützen. Ausnahme: ein aus einem Alt-Link importierter
Zugang bindet einen bestehenden Token, ohne ein wiederherstellbares Secret
dafür zu speichern; für ihn bleibt **Link erneut anzeigen** dauerhaft leer,
auch ohne Schlüsselrotation.

Die Quelle lädt `GET /api/overlay/bootstrap` mit dem Token als
`Authorization: Bearer`-Header. Der Worker gibt nur das gebundene Overlay und
dessen referenzierte Variablen zurück. Der gemeinsame Canvas rendert die
Komposition oder auf Wunsch ein einzelnes Element an seinem Ursprung. Bei
Laufzeitfehlern bleiben Elementgrenzen transparent; Diagnoseinformationen
erscheinen nicht in der Ausgabe.

Live-Änderungen laufen über `GET /ws/overlay` mit den Subprotokollen
`brobot.v1` und `brobot.token.<token>`. Der Token wird nicht als Socket-Query
übertragen. Der Worker prüft ihn und leitet einen internen Prinzipal mit Kanal-
und Token-ID an das Durable Object des Kanals weiter. Variablenereignisse
aktualisieren die sichtbaren Werte; Änderungen am gespeicherten Overlay lösen
einen Bootstrap aus. Nach einem abnormalen Socket-Schluss prüft der Client den
Bootstrap vor einer Wiederverbindung. Widerruf leert die Ausgabe und beendet
die Verbindung; vorübergehende Ladefehler lassen den letzten erfolgreichen
Frame stehen.

Für `/overlay` und `/overlay.html` erstellt der Worker die CSP aus
`PUBLIC_ORIGIN`. Skripte, Styles, Bilder, Schriften und Verbindungen nennen
diese Origin ausdrücklich, damit auch opake Widget-Sandboxes laden können.
Inline-Styles sind für das gespeicherte Overlay-CSS erlaubt. `default-src
'none'`, `base-uri 'none'` und `form-action 'none'` sperren nicht benötigte
Ressourcen. Overlay-Antworten setzen weder `frame-ancestors` noch
`X-Frame-Options`, damit OBS, StreamElements und Sound Alerts die Ausgabe
einbetten können. Dashboard und API behalten ihre eigenen Header.

### Alte Overlay-Links

Bereits vorhandene ungebundene Tokens bleiben gültig. Ihr Bootstrap liefert
`overlay: null`; Links mit `#token=…&var=<name>&text=<Vorlage>` laden eine
Kanalvariable weiter über `GET /api/overlay/variables/:name` und zeigen genau
ein Element. Auch diese Quellen erhalten Variablenänderungen über den
Overlay-WebSocket. Die alte Route zum Ausstellen weiterer ungebundener Tokens
ist entfernt.

Das Dashboard listet aktive Alt-Links, kann sie widerrufen und sie in ein
gespeichertes Overlay importieren. Beim Import wird der bestehende Token an das
neue Overlay gebunden; der Import übernimmt die ausgewählte Variable und den
Anzeigetext, aber keine OBS-Positionen oder benutzerdefiniertes CSS. Danach
wird der alte Echtzeitkanal geschlossen. Die Token-Prüfung leitet den Kanal
stets aus dem Token-Datensatz ab; ein Zugriff auf eine Variable oder ein
Overlay aus einem anderen Kanal ist damit ausgeschlossen.

## Vorlagenvariablen und Kanalwerte

`channel_variables` speichert benannte Ganzzahlen pro `channel_id`. Der Host
deklariert Systemvariablen in `src/template-variables.ts` und löst Vorlagen
lazy auf: Er durchsucht nur den tatsächlich gerenderten Text und fragt nur
Helix- oder D1-Quellen ab, die dessen Tokens benötigen. Mehrere
Kanalvariablen werden in einer einzelnen, kanalgebundenen Abfrage gelesen.

Textbefehle können eine Kanalvariable innerhalb derselben D1-Batch wie ihre
Claim- und Cooldown-Mutationen ändern. Die Änderung hängt am erfolgreichen
Claim und wird zusammen mit der Antwort gerendert; eine abgelehnte Abkühlzeit
führt zu keiner Änderung. Bestehende Revision-CAS- und Alias-Indizes bleiben
Teil des Befehlsmodells. Migration `0009_channel_variables.sql` legt die
Kanalvariablentabelle an und wandelt die auslaufenden Befehlsarten `uptime`,
`followage` und `game` in normale Textbefehle um.

Die Verwaltungs-API liegt unter
`/api/channels/:channelId/variables`: GET listet Werte und Verwendungen,
POST legt eine Variable an, PATCH benennt sie um oder ändert Metadaten, DELETE
entfernt sie, und POST `/:name/value` setzt oder verschiebt den Wert.
Jede SQL-Abfrage ist an `channel_id` gebunden. Broadcaster und Manager
verwalten Definitionen; alle Kanalrollen dürfen Werte ändern. Eine Umbenennung
schreibt bekannte Vorlagenreferenzen in Textbefehlen und Moduleinstellungen in
derselben D1-Batch um. Eine Variable mit Befehlsaktion lässt sich nicht löschen.

## Verbindliche Architekturentscheidungen

1. **Kein `BROADCASTER_ID`-Secret.** Der Kanal kommt aus Route und Session; die Freigabe erfolgt über eine Zeile in `channels`, nicht über einen Konfigurationswert. So wird ein Kanal nicht durch einen geheimen Konfigurationswert mit der Identität des Benutzers verwechselt.
2. **`channelId` ist der Mandantenschlüssel.** Jede Tabelle trägt `channel_id`; derselbe Schlüssel bildet den Durable-Object-Namen. Der Bot unterstützt den Mehrkanalbetrieb mit kanalweiser Drosselung; offene Selbstanmeldung und Abrechnung sind nicht vorgesehen.
3. **`twitch_connections` ist eine eigene Tabelle.** Eine Broadcaster-Verbindung gehört zu Kanal und Zweck (`broadcaster`) und speichert Scopes sowie Ablauf. Der `bot`-Wert bleibt im Check-Ausdruck für einen späteren kanalbezogenen Bot erhalten, wird aber in #18 nicht verwendet: Der laufende Bot autorisiert sich einmal global in `bot_identity`, weil ein rotierendes Refresh-Token nicht je Kanal dupliziert werden darf.
4. **Login-Tokens und Sessions bleiben getrennt.** `twitch_login_identity` hält die verschlüsselten Login- und Refresh-Tokens je Twitch-User; `auth_sessions` hält nur die kurzlebige, serverseitig widerrufbare Sitzung. Kein Token gelangt in Cookie oder Browser-Speicher.
5. **`channel_members` existiert ab Tag 1.** Autorisierung fragt immer, ob ein User in genau diesem Kanal zugelassen ist. Eine globale Rolle außerhalb des Kanalmandanten gibt es nicht.

6. **Administrative Mitgliedsänderungen werden atomar auditiert.** Die
   Schema-Baseline `0000_baseline.sql` begrenzt die Rollen per SQLite-`CHECK`;
   `tests/unit/sql-role-contract.test.ts` hält den Constraint an `CHANNEL_ROLES`.
   Eine Änderung an `channel_members` und ihr Eintrag in `audit_log` werden in
   einem D1-Batch ausgeführt; ohne erfolgreiche Änderung gibt es keinen Audit-
   Eintrag.

7. **Die Session ist Teil der Mutation, nicht nur des Guards.** Zwischen dem
   Guard und der Mutation liegt das Lesen des Request-Bodys — ein Fenster, das
   ein Client beliebig lange offen halten kann. Deshalb prüft jede schreibende
   Mutation im selben Batch erneut, ob die Session des Akteurs existiert, nicht
   widerrufen und nicht abgelaufen ist, ob die Login-Identität lebt und ob die
   Kanalrolle noch trägt. Das gilt auch für die Ausgabe und den Widerruf von
   Overlay-Token. Eine Prüfung nur im Guard lässt eine widerrufene Session
   dauerhaft Rechte vergeben.

8. **Nur ein `broadcaster` vergibt die Rolle `broadcaster`.** Ein Verwalter
   könnte sonst ein Zweitkonto zum Broadcaster machen und danach den
   ursprünglichen Broadcaster entfernen; der Schutz des letzten Broadcasters
   greift dann nicht, weil zwischenzeitlich zwei existieren. Die Regel steht in
   der SQL-Mutation, nicht nur im Handler. Was ein Verwalter darüber hinaus
   nicht darf, ist noch offen und gehört zu #17.

Diese Entscheidungen halten den ersten Betrieb klein und bewahren trotzdem die notwendige Trennung zwischen Kanal, Benutzer, Twitch-Verbindung und Modulaktivierung.

## Mandantenmodell

`channelId` ist überall der Mandantenschlüssel: Jede persistierende Tabelle führt `channel_id`, und für jeden Kanal gibt es ein eigenes Durable Object. Der Bot läuft gleichzeitig in mehreren Kanälen.

`channel_id` **ist die Twitch-Nutzer-ID des Broadcasters**, nicht ein eigener Schlüssel. Das ist kein Zufall, sondern Voraussetzung: Der Moderatorabgleich liest die Werte direkt aus Twitchs `broadcaster_id` (`src/worker/bot-maintenance.ts`), EventSub-Abos werden über dieselbe ID gebunden, und die Identität des Broadcasters wird über `twitch_login_identity.user_id = channel_id` gefunden. Wer einen Kanal von Hand in `channels` einträgt, muss deshalb die Twitch-ID verwenden; ein frei gewählter Schlüssel bricht diese drei Stellen stillschweigend.

Die Autorisierung ist ausdrücklich: Nur eine Zeile mit Rolle in `channel_members` berechtigt zur Bedienung. Eine Twitch-Moderatorrolle berechtigt nicht. Auch Twitch-Nutzer ohne Rolle im Kanal sind berechtigbar, dann mit ausdrücklicher Sicherheitsabfrage. Moderatoren werden über das Abzeichen in gelesenen Chatnachrichten erkannt und als Vorschlag angeboten; eine Abfrage der Moderatorenliste bei Twitch findet nicht statt, weil sie ein Broadcaster-Token verlangen würde (Begründung in Entscheidung 0002, Abschnitt 6).

Ein Kanal erscheint in der Auswahl eines Nutzers, wenn **zwei** Bedingungen erfüllt sind: Es gibt eine Zugriffszeile in `channel_members`, und der Kanal ist in `channels` freigegeben.

Eine Broadcaster-OAuth-Verbindung ist **keine** Bedingung. Sie ist seit Entscheidung 0002 ein optionaler Schalter je Kanal und wird nur von den Modulen #8, #21 und #22 gebraucht; ein Kanal ist betriebsbereit, sobald der Bot dort gemoddet ist. Hier stand ursprünglich eine dritte Bedingung „der Kanal ist per OAuth verbunden" — sie stammt aus der Zeit vor dieser Entscheidung und hätte betriebsbereite Kanäle aus der Auswahl fallen lassen.

Eine offene Selbstanmeldung ist bewusst nicht vorgesehen. Sie ließe sich ohne Datenmodelländerung ergänzen, bräuchte dann aber Quoten, Missbrauchsschutz sowie Datenexport und -löschung je Mandant.

EventSub-Kontingent und Helix-Rate-Limit gelten pro Client-ID, nicht pro Kanal. Deshalb braucht es eine Drosselung je Kanal, damit ein aktiver Kanal den anderen nicht die Aufrufe wegnimmt.
