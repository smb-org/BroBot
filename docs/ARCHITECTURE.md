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
wie ein Passwort zu schützen.

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
