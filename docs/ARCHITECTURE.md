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

Der spätere Ereignisfluss ist: EventSub → Worker → fachliches Modul → Channel Durable Object → Overlay. Ein Durable Object wird deterministisch aus dem `channelId`-Namen angesprochen. Der Worker bleibt das Gateway für HTTP und die Module; der DO hält den kanalbezogenen Echtzeitraum.

## Modulsystem

Ein Modul ist ein Feature-Slice unter `src/modules/<id>/` mit `contracts/`, `domain/`, `service.ts`, `repository.ts`, `adapters/`, `overlay/` und `panel/`. Sein `BotModule`-Contract beschreibt Settings, Migrationen, EventSub-Typen, Commands, Routen sowie ein lazy Overlay und eine optionale lazy Panel-Ansicht.

`src/modules/registry.ts` ist die einzige Stelle, die alle Module kennt. Später mountet der Worker die registrierten Router unter `/api/modules/<id>`. Ein Modul wird aktiviert, indem in `channel_modules` eine Zeile für den jeweiligen `channel_id` und `module_id` mit `enabled = 1` steht. Dafür ist kein Deploy erforderlich.

Das Overlay und das Panel laden ihre Quellen über einen `import()`-Promise. Dadurch kann Vite beide Ansichten in eigene Chunks schneiden; ein deaktiviertes Modul kostet in keinem der beiden Bundles Bytes. Direkte Imports wären deshalb bewusst zu vermeidende Bundle-Kopplungen.

ESLint schützt die Grenze: Overlay-Ansichten importieren weder Worker-, Service-, Repository- oder Adaptercode noch Zod. Panel-Ansichten importieren weder Worker-, Repository- noch Adaptercode; Zod und der Service sind dort für Formulare und ausgelöste Anwendungsfälle erlaubt. Module importieren keine Geschwistermodule. Der Worker importiert kein React.

### Panel

Das Admin- und Mod-Panel ist die primäre Bedienoberfläche. Sein Grundgerüst gehört dem Host; die konkrete Ansicht kommt pro Modul optional über den `BotModule`-Contract hinzu. Overlay- und Panel-Ansichten werden lazy geladen, damit ein deaktiviertes Modul in keinem der beiden Bundles Gewicht trägt.

Serverdaten bleiben autoritativ: Eine Live-Nachricht meldet nur, dass sich etwas geändert hat; den aktuellen Stand lädt das Panel über die API nach.

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

### OBS-Overlay-Nachweis

Der Overlay-Zugang wird als langer, zufälliger Token in einer URL mit
Fragment ausgegeben. In der ausgelieferten Umgebung ist der kanonische Pfad
`/overlay#token=...`; lokal unter Vite bleibt der HTML-Einstieg
`/overlay.html#token=...`. Die Ausgabe-URL verwendet `/overlay`, damit
Cloudflare Assets nicht den weiterleitenden Alias `/overlay.html` verwenden. Das
Fragment wird vom Browser weder beim HTTP-Request an den Worker gesendet noch
in den `Referer`-Header übernommen. Deshalb gelangt der Token nicht über den
initialen Seitenrequest oder an verlinkte Ziele. Die Overlay-Seite liest ihn
lokal und verwendet ihn nur als `Authorization: Bearer`-Header für
`GET /api/overlay/status`; ein OAuth- oder Twitch-Token steht nie in der
Overlay-URL. Dieser Header ist ein Secret und darf ebenfalls nicht
protokolliert werden.

Diese Wahl schützt nicht vor Zugriff auf die OBS-Konfiguration: OBS speichert
die vollständige Browserquellen-URL einschließlich Fragment im Klartext in
der Szenensammlung. Wer Zugriff auf die Szenensammlung hat, hat damit Zugriff
auf das Overlay. Die Ausgabe- und Widerrufs-Routen sind deshalb
kanalgebunden und durch den gemeinsamen Session-, CSRF- und
Mitgliedschafts-Guard geschützt.

D1 speichert nur den mit `OVERLAY_TOKEN_PEPPER` gebildeten HMAC-Hash. Der
Token gehört genau zu dem Kanal, der beim Guard aus dem Routenparameter
ermittelt wird; der Status-Endpunkt ermittelt den Kanal ausschließlich aus
dem Token. `expires_at` ist standardmäßig `NULL`, weil eine OBS-Quelle über
Monate unverändert bleiben kann. Ein Ablaufzeitpunkt ist für zeitlich
begrenzte Freigaben optional. `last_used_at` wird nur bei der ersten Nutzung
oder nach mindestens fünf Minuten aktualisiert, damit regelmäßige
HTTP-Statusabrufe keine fortlaufenden D1-Schreibvorgänge erzeugen.

Der Status-Endpunkt liefert `CF_VERSION_METADATA.id`. Damit stammt die
angezeigte Version aus dem laufenden Deployment und nicht aus einem statischen
Bild oder einer im Overlay-Bundle fest eingetragenen Versionszeichenkette.

## Verbindliche Architekturentscheidungen

1. **Kein `BROADCASTER_ID`-Secret.** Der Kanal kommt aus Route und Session; die Freigabe erfolgt über eine Zeile in `channels`, nicht über einen Konfigurationswert. So wird ein Kanal nicht durch einen geheimen Konfigurationswert mit der Identität des Benutzers verwechselt.
2. **`channelId` ist der Mandantenschlüssel.** Jede Tabelle trägt `channel_id`; derselbe Schlüssel bildet den Durable-Object-Namen. Der Bot unterstützt den Mehrkanalbetrieb mit kanalweiser Drosselung; offene Selbstanmeldung und Abrechnung sind nicht vorgesehen.
3. **`twitch_connections` ist eine eigene Tabelle.** Eine Broadcaster-Verbindung gehört zu Kanal und Zweck (`broadcaster`) und speichert Scopes sowie Ablauf. Der `bot`-Wert bleibt im Check-Ausdruck für einen späteren kanalbezogenen Bot erhalten, wird aber in #18 nicht verwendet: Der laufende Bot autorisiert sich einmal global in `bot_identity`, weil ein rotierendes Refresh-Token nicht je Kanal dupliziert werden darf.
4. **Login-Tokens und Sessions bleiben getrennt.** `twitch_login_identity` hält die verschlüsselten Login- und Refresh-Tokens je Twitch-User; `auth_sessions` hält nur die kurzlebige, serverseitig widerrufbare Sitzung. Kein Token gelangt in Cookie oder Browser-Speicher.
5. **`channel_members` existiert ab Tag 1.** Autorisierung fragt immer, ob ein User in genau diesem Kanal zugelassen ist. Eine globale Rolle außerhalb des Kanalmandanten gibt es nicht.

6. **Administrative Mitgliedsänderungen werden atomar auditiert.** Die
   Migration `0002_autorisierung.sql` begrenzt die Rollen per SQLite-`CHECK`.
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

Die Autorisierung ist ausdrücklich: Nur eine Zeile mit Rolle in `channel_members` berechtigt zur Bedienung. Eine Twitch-Moderatorrolle berechtigt nicht. Auch Twitch-Nutzer ohne Rolle im Kanal sind berechtigbar, dann mit ausdrücklicher Sicherheitsabfrage. Moderatoren werden über das Abzeichen in gelesenen Chatnachrichten erkannt und als Vorschlag angeboten; eine Abfrage der Moderatorenliste bei Twitch findet nicht statt, weil sie ein Broadcaster-Token verlangen würde (Begründung in Entscheidung 0002, Abschnitt 6).

Ein Kanal erscheint in der Auswahl eines Nutzers, wenn **zwei** Bedingungen erfüllt sind: Es gibt eine Zugriffszeile in `channel_members`, und der Kanal ist in `channels` freigegeben.

Eine Broadcaster-OAuth-Verbindung ist **keine** Bedingung. Sie ist seit Entscheidung 0002 ein optionaler Schalter je Kanal und wird nur von den Modulen #8, #21 und #22 gebraucht; ein Kanal ist betriebsbereit, sobald der Bot dort gemoddet ist. Hier stand ursprünglich eine dritte Bedingung „der Kanal ist per OAuth verbunden" — sie stammt aus der Zeit vor dieser Entscheidung und hätte betriebsbereite Kanäle aus der Auswahl fallen lassen.

Eine offene Selbstanmeldung ist bewusst nicht vorgesehen. Sie ließe sich ohne Datenmodelländerung ergänzen, bräuchte dann aber Quoten, Missbrauchsschutz sowie Datenexport und -löschung je Mandant.

EventSub-Kontingent und Helix-Rate-Limit gelten pro Client-ID, nicht pro Kanal. Deshalb braucht es eine Drosselung je Kanal, damit ein aktiver Kanal den anderen nicht die Aufrufe wegnimmt.
