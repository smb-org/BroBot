# Betriebshandbuch

## Erstaufsetzen

1. In der [Twitch Developer Console](https://dev.twitch.tv/console/apps) eine Twitch-Anwendung anlegen. Client-ID und Client-Secret gehören in den sicheren Betreiberbestand. Die spätere OAuth-Callback-URL muss unter `PUBLIC_ORIGIN` auf `/auth/twitch/callback` zeigen.
2. Für jede Umgebung eine D1-Datenbank erzeugen, zum Beispiel:

   ```bash
   pnpm exec wrangler d1 create brobot-local
   pnpm exec wrangler d1 create brobot-staging
   pnpm exec wrangler d1 create brobot-production
   ```

   Die Ausgabe liefert je Datenbank eine `database_id`. Die drei deutlich als Platzhalter eingetragenen Null-UUIDs in `wrangler.jsonc` durch die jeweiligen IDs ersetzen. Danach die Migration mit Wrangler ausführen, sobald die Datenbank verfügbar ist.
3. Für Schlüssel jeweils erzeugen:

   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

   Für `SESSION_COOKIE_KEYS` und `SESSION_ENCRYPTION_KEYS` jeweils einen
   eigenen aktiven Schlüsselring mit optionalen `retired`-Einträgen verwenden.
   `TWITCH_EVENTSUB_SECRET` hat dasselbe Format; sein aktiver Eintrag signiert
   neue Abonnements, ausgemusterte Einträge werden während der Rotation noch
   gelesen. Für `OVERLAY_TOKEN_PEPPER` einen einzelnen, getrennten Wert und
   für die übrigen Variablen echte Betreiber-Secrets festlegen. Die
   Beispieldateien zeigen die genaue JSON-Struktur.
4. Für lokal `.dev.vars.example` nach `.dev.vars` kopieren und die Platzhalter ersetzen. Für Staging und Production `.env.staging` beziehungsweise `.env.production` aus dem sicheren Betreiber-Backup bereitstellen.
5. Einen neuen Kanal gibt der Betreiber frei, indem er ihn in `channels` anlegt
   und den Broadcaster in `channel_members` einträgt. Der Bot wird anschließend
   als reine Twitch-Aktion gemoddet. Der Betreiber autorisiert den Bot einmal
   über `GET /auth/bot/login`; diese Autorisierung wird nicht je Kanal kopiert.
   Eine Broadcaster-Autorisierung entsteht erst mit einem Modul, das sie
   benötigt.

## Overlay-Nachweis in OBS

Das Overlay ist eine technische Deployment-Anzeige, kein fachliches Modul. Es
zeigt nach einem erfolgreichen HTTP-Statusabruf die Version aus
`CF_VERSION_METADATA`.

### Migration und Token ausgeben

Vor dem ersten Rollout die D1-Migrationen `0003_overlay_tokens.sql` und
`0004_moderator_status_check_lock.sql` in jeder Zielumgebung anwenden. Der
Pepper bleibt ein Secret und wird nicht in die
Browserquelle oder in die URL geschrieben.

Die Ausgabe erfolgt mit einer angemeldeten Panel-Session. Zuerst über
`GET /api/csrf` ein CSRF-Token beziehen; es muss im
`__Host-brobot_csrf`-Cookie und im Header `X-CSRF-Token` zurückgesendet werden.
Danach ohne Ablaufzeit ausgeben:

```bash
curl -sS -X POST https://<öffentlicher-origin>/api/channels/<channelId>/overlay-tokens \
  -H 'Cookie: __Host-brobot_session=<session-cookie>; __Host-brobot_csrf=<csrf-token>' \
  -H 'X-CSRF-Token: <csrf-token>' \
  -H 'Content-Type: application/json' \
  --data '{}'
```

Die Antwort enthält eine `tokenId`, die vollständige `overlayUrl` und
`"expiresAt": null`. In der ausgelieferten Umgebung zeigt die `overlayUrl` auf
den kanonischen Pfad `/overlay#token=...`; `/overlay.html` ist dort nur der
weiterleitende Alias. Die `overlayUrl` genau einmal kopieren und in OBS
einsetzen; der Klartext-Token wird nicht erneut angezeigt oder gespeichert.
Für eine zeitlich begrenzte Freigabe kann statt `{}` ein zukünftiger Zeitpunkt
angegeben werden:

```json
{ "expiresAt": "2030-01-15T12:00:00.000Z" }
```

Die URL enthält den Token im Fragment (`#token=...`), nicht in einer Query.
Browser senden das Fragment nicht an den Worker. OBS speichert die komplette
URL einschließlich Fragment jedoch in der Szenensammlung im Klartext; diese
Szenensammlung ist deshalb wie ein Secret zu schützen. Twitch- oder
OAuth-Tokens gehören niemals in diese URL.

### Browserquelle einrichten

1. In OBS eine **Browserquelle** anlegen und die ausgegebene `overlayUrl`
   eintragen.
2. Als Startgröße sind ungefähr **420 × 72 Pixel** sinnvoll. Die Quelle kann
   später kleiner oder größer gezogen werden; der Inhalt bleibt ohne eigene
   Hintergrundfläche.
3. In den Browserquellen-Einstellungen den Haken für **transparenten
   Hintergrund** setzen beziehungsweise die Hintergrundfarbe auf **transparent**
   stellen, falls die OBS-Version diese Option so bezeichnet. Kein eigenes CSS
   mit einer Hintergrundfarbe ergänzen.
4. Die Quelle bei Bedarf aktualisieren oder die Szene neu laden. Eine
   erfolgreiche Quelle zeigt klein `Version <Deployment-ID>`.

### Token widerrufen

Mit der `tokenId` aus der Ausgabe widerruft der Betreiber genau diesen Zugang.
Der Widerrufsgrund wird gespeichert:

```bash
curl -sS -X POST https://<öffentlicher-origin>/api/channels/<channelId>/overlay-tokens/<tokenId>/revoke \
  -H 'Cookie: __Host-brobot_session=<session-cookie>; __Host-brobot_csrf=<csrf-token>' \
  -H 'X-CSRF-Token: <csrf-token>' \
  -H 'Content-Type: application/json' \
  --data '{"reason":"OBS-Szenensammlung ersetzt"}'
```

Der Standardtoken läuft nicht ab. Das Betriebsmittel für eine nicht mehr
gewünschte Quelle ist der einzelne Widerruf; ein optionaler Ablauf ist nur für
bewusst befristete Freigaben vorgesehen. `last_used_at` wird höchstens einmal
je fünf Minuten aktualisiert und eignet sich damit als grobes Lebenszeichen,
ohne jeden Statusabruf als D1-Schreibvorgang zu speichern.

### Schwarze oder leere Quelle diagnostizieren

- Prüfen, ob die Browserquelle exakt die ausgegebene URL inklusive `#token=...`
  verwendet. Den Token nicht in eine Query verschieben und nicht durch einen
  Twitch- oder OAuth-Token ersetzen.
- Die Quelle aktualisieren beziehungsweise die Option zum Neuladen beim
  Szenenwechsel einmal aktivieren. Bei einem widerrufenen, optional
  abgelaufenen oder anderweitig ungültigen Token bleibt die Fläche vollständig
  leer; das Fehlen der Versionsanzeige ist das Signal.
- Prüfen, ob der Worker erreichbar ist und `/api/overlay/status` mit dem
  gültigen Token den Status `200` liefert. Für diesen Test den Token nicht in
  Logs, Tickets oder Screenshots kopieren.
- Eine eigene OBS-CSS-Regel mit schwarzem `body`-Hintergrund entfernen. Die
  Seite setzt `html`, `body`, `#root` und die gerenderte Fläche selbst auf
  transparent.
- Wenn die Version fehlt, zuerst Deployment und D1-Migration prüfen. Ohne
  `0003_overlay_tokens.sql` kann der Worker keine Overlay-Zugänge validieren;
  ohne gültige `CF_VERSION_METADATA`-Bindung kann keine aktuelle
  Deployment-ID angezeigt werden.

Die Secrets sind in `wrangler.jsonc` nur als Namen unter `secrets.required` dokumentiert. Die aktuelle Wrangler-Konfiguration akzeptiert dieses Feld und nutzt es auch für die Typgenerierung; Secret-Werte werden ausschließlich über Secret-Bindings beziehungsweise lokale Env-Dateien bereitgestellt.

## Umgebungsvariablen und Bindings

**Konfigurationsvariablen** (stehen als `vars` in `wrangler.jsonc`, sind keine Secrets, landen im Repo):

| Name | Bedeutung |
|---|---|
| `APP_ENV` | `local`, `staging` oder `production`; unterscheidet Umgebungsverhalten und wird vom Deploy-Preflight geprüft |
| `TIMEZONE` | IANA-Zeitzone, zum Beispiel `Europe/Berlin` |
| `TWITCH_BOT_LOGIN` | Öffentlicher Twitch-Login des einzigen Bot-Accounts; der Bot-Callback akzeptiert keine andere Identität |

**Secrets** (nur als Namen unter `secrets.required` in `wrangler.jsonc`; Werte kommen aus `.dev.vars` beziehungsweise `.env.staging`/`.env.production`):

| Name | Bedeutung | Format |
|---|---|---|
| `TWITCH_CLIENT_ID` | Client-ID der Twitch-Anwendung | Zeichenkette aus der Developer Console |
| `TWITCH_CLIENT_SECRET` | Client-Secret derselben Anwendung; trägt den OAuth-Austausch | Zeichenkette aus der Developer Console |
| `TWITCH_EVENTSUB_SECRET` | Schlüsselring für die HMAC-Signaturprüfung eingehender EventSub-Webhooks | JSON `{"active":{"id":"...","key":"..."},"retired":[...]}` |
| `PUBLIC_ORIGIN` | öffentliche Origin der Umgebung; bestimmt OAuth-Redirect und Overlay-URLs | absolute URL ohne Schrägstrich am Ende |
| `SESSION_COOKIE_KEYS` | Schlüsselsatz für die Signatur der Session-Cookies | JSON `{"active":{"id":"...","key":"..."},"retired":[...]}`, Schlüssel 32 Byte base64url |
| `SESSION_ENCRYPTION_KEYS` | Schlüsselsatz für die Verschlüsselung der Session-Inhalte | wie oben, eigener Wert |
| `OVERLAY_TOKEN_PEPPER` | Pepper für die Hashes widerrufbarer Overlay-Tokens | 32 Byte base64url |

Die vier Schlüsselwerte (`TWITCH_EVENTSUB_SECRET`, `SESSION_COOKIE_KEYS`,
`SESSION_ENCRYPTION_KEYS` und `OVERLAY_TOKEN_PEPPER`) werden mit dem im
Erstaufsetzen dokumentierten `openssl`-Befehl erzeugt und sind je Umgebung und
je Zweck unterschiedlich — niemals denselben Wert doppelt verwenden.

Bei `SESSION_COOKIE_KEYS`, `SESSION_ENCRYPTION_KEYS` und
`TWITCH_EVENTSUB_SECRET` signiert beziehungsweise verschlüsselt nur
`active` neu. Ein Eintrag unter `retired` bleibt so lange erhalten, bis keine
alten Cookies oder EventSub-Abonnements mehr existieren. Die Rotation wird
danach durch Entfernen des alten Eintrags abgeschlossen.

**Bindings** (keine Umgebungsvariablen, sondern Cloudflare-Ressourcen aus `wrangler.jsonc`):

| Binding | Ressource |
|---|---|
| `DB` | D1-Datenbank der Umgebung |
| `CHANNEL` | Durable-Object-Namespace `ChannelObject`, ein Objekt je Kanal |
| `ASSETS` | statische Dashboard- und Overlay-Dateien aus `dist/client` |
| `CF_VERSION_METADATA` | Versionsmetadaten des Deployments |

`/healthz` prüft eine im Worker hinterlegte Liste (`REQUIRED_SECRET_NAMES`) und meldet einen Namen als fehlend, wenn der zugehörige Wert leer ist, noch einen Platzhalter (`replace-with`, `example.invalid`) enthält oder ein bekanntes Format verletzt — niemals den Wert selbst. `pnpm run config:verify` stellt sicher, dass diese Liste im Worker, `secrets.required` in `wrangler.jsonc` (alle Umgebungen) und das Verify-Script selbst übereinstimmen; weichen sie voneinander ab, schlägt die Prüfung fehl.

## Lokale Entwicklung

```bash
cp .dev.vars.example .dev.vars
pnpm install
pnpm run dev
```

Das Dashboard ist unter `http://localhost:5173/` und das Overlay lokal unter
`http://localhost:5173/overlay.html` erreichbar. In der ausgelieferten Umgebung
ist `/overlay` der kanonische Pfad; `/overlay.html` ist dort nur der
weiterleitende Alias. Lokale Cloudflare-Bindings werden durch Vite/Wrangler
simuliert. Die Beispielwerte sind absichtlich keine produktiven Secrets.

## Prüfung und Deployment

Vor jedem Deployment:

```bash
pnpm install --frozen-lockfile
pnpm run check
```

Vor dem ersten Rollout dieser Version die D1-Migrationen in jeder Zielumgebung
anwenden. Der Worker darf erst danach ausgerollt werden, weil `0001` die
Session-, OAuth- und Token-Tabellen, `0002` die feste Rollenmenge sowie das
Audit-Log, `0003` die Overlay-Token-Tabelle und `0004` die kanalbezogene
Sperre für manuelle Moderatorstatus-Prüfungen anlegen:

```bash
pnpm exec wrangler d1 migrations apply brobot-local
pnpm exec wrangler d1 migrations apply brobot-staging --remote --env staging
pnpm exec wrangler d1 migrations apply brobot-production --remote --env production
```

Bei späteren Releases gilt dieselbe Reihenfolge: Migration anwenden, danach
den Worker deployen. Die Befehle verändern ausschließlich die angegebene D1-
Datenbank; die Betreiberdateien mit Secrets werden dabei nicht gelesen.

Staging und Production werden lokal mit den jeweiligen Betreiberdateien ausgerollt:

```bash
pnpm run deploy:staging
pnpm run deploy:production
```

Die Skripte prüfen vor dem Deploy Umgebung, Worker-Namen, `APP_ENV`, Secret-Namen und Platzhalter. Sie verwenden die vollständige Wrangler-Umgebung; `env.*` erbt Bindings nicht automatisch.

Nach einem Deploy prüfen:

```bash
curl -i https://<öffentlicher-origin>/healthz
```

`200` bedeutet, dass die erwarteten lokalen Bindings vorhanden sind. Bei `503` enthält die Antwort ausschließlich die Namen fehlender Bindings, niemals deren Werte.

## Twitch-Login und Bot-Verbindung

`GET /auth/login` startet den Panel-Login mit dem Scope
`user:read:moderated_channels`. Twitch leitet immer auf
`PUBLIC_ORIGIN/auth/twitch/callback` zurück. Die Session ist ein verschlüsseltes
und signiertes `HttpOnly`-Cookie; ihre D1-Zeile bleibt beim Logout als
widerrufen nachvollziehbar. `POST /auth/logout` widerruft die Zeile und löscht
die Cookies; der Request benötigt das Token aus `GET /api/csrf` zusätzlich als
`X-CSRF-Token` und im `__Host-brobot_csrf`-Cookie. Access- und Refresh-Token dieses
Logins liegen verschlüsselt in
`twitch_login_identity`, nicht in der Session. Der stündliche Lauf validiert
und erneuert sie; bei einem Widerruf werden die zugehörigen Sessions
serverseitig widerrufen.

Die Betreiberaufgabe `GET /auth/bot/login` verwendet denselben Callback, legt
aber keine Session an. Sie schreibt die globale Ein-Zeilen-Identität in
`bot_identity`. Access- und Refresh-Token liegen dort nur verschlüsselt. Eine
Zeile in `twitch_connections` wird für diesen globalen Bot nicht angelegt.

Der Scheduled-Handler läuft in jeder Umgebung stündlich. Er validiert den
Bot-Token über Twitch, erneuert Token mit weniger als einer Stunde Restlaufzeit
und ersetzt Access- und Refresh-Token in einem D1-Schreibvorgang. Danach prüft
er den Bot über Get Moderated Channels für alle Zeilen in `channels` und hält
den Status in `bot_channel_status` fest. Abgelaufene OAuth-Transaktionen
werden im selben Lauf entfernt.

Bei `invalid_grant` oder einer widerrufenen Autorisierung wird der globale
Status mit Ursache `revoked` gespeichert. Der Scheduled-Handler versucht einen
solchen Zustand nicht endlos erneut; der Betreiber startet zur erneuten
Autorisierung wieder `/auth/bot/login`.

Die Scope-Entscheidung in `docs/decisions/0002-twitch-scopes-und-token-handling.md`
führt `user:read:moderated_channels` bewusst sowohl für Login-Tokens als auch
für den Bot-Token auf. Der stündliche Lauf nutzt diesen Bot-Scope für Get
Moderated Channels und speichert den Moderatorstatus je freigegebenem Kanal.

## Secret-Rotation

Eine Rotation erfolgt durch Aktualisieren der sicheren Betreiberdatei und erneutes Ausführen des passenden Deploy-Skripts. Cookie-, Verschlüsselungs- und Overlay-Schlüssel getrennt erzeugen. Der bisherige Wert darf weder in Logs noch in Tickets oder Git landen. Vor dem Rotieren sicherstellen, dass die neue Datei im Betreiber-Backup gesichert ist.

`.env.staging` und `.env.production` sind ignoriert und werden aus dem Betreiber-Backup bereitgestellt. Ihre Inhalte gehören niemals in Terminalausgaben, Tickets, Pull Requests oder das Repository. Gleiches gilt für `.dev.vars`.

## Sicherheits- und Betriebsgrenzen

- Ein Kanal wird durch eine Zeile in `channels` freigegeben; dafür gibt es bewusst keine Konfigurationsvariable.
- `channelId` darf nicht durch eine globale Rolle oder eine globale Token-Tabelle ersetzt werden.
- Die alte Twitch- oder Session-Autorisierung bei einem Incident bewusst über die vorgesehenen Secrets rotieren.
- Vor einem öffentlichen Betrieb die aktuellen Cloudflare-Quoten und Wrangler-Dokumentation erneut prüfen.
