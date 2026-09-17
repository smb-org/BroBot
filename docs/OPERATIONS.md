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

   Für `SESSION_COOKIE_KEYS`, `SESSION_ENCRYPTION_KEYS` und `OVERLAY_TOKEN_PEPPER` getrennte Werte verwenden. Zusätzlich `TWITCH_EVENTSUB_SECRET` und die übrigen Werte als echte Betreiber-Secrets festlegen.
4. Für lokal `.dev.vars.example` nach `.dev.vars` kopieren und die Platzhalter ersetzen. Für Staging und Production `.env.staging` beziehungsweise `.env.production` aus dem sicheren Betreiber-Backup bereitstellen.
5. Einen neuen Kanal gibt der Betreiber frei, indem er ihn in `channels` anlegt. Anschließend verbindet der Broadcaster den Kanal per OAuth.

Die Secrets sind in `wrangler.jsonc` nur als Namen unter `secrets.required` dokumentiert. Die aktuelle Wrangler-Konfiguration akzeptiert dieses Feld und nutzt es auch für die Typgenerierung; Secret-Werte werden ausschließlich über Secret-Bindings beziehungsweise lokale Env-Dateien bereitgestellt.

## Umgebungsvariablen und Bindings

**Konfigurationsvariablen** (stehen als `vars` in `wrangler.jsonc`, sind keine Secrets, landen im Repo):

| Name | Bedeutung |
|---|---|
| `APP_ENV` | `local`, `staging` oder `production`; unterscheidet Umgebungsverhalten und wird vom Deploy-Preflight geprüft |
| `TIMEZONE` | IANA-Zeitzone, zum Beispiel `Europe/Berlin` |

**Secrets** (nur als Namen unter `secrets.required` in `wrangler.jsonc`; Werte kommen aus `.dev.vars` beziehungsweise `.env.staging`/`.env.production`):

| Name | Bedeutung | Format |
|---|---|---|
| `TWITCH_CLIENT_ID` | Client-ID der Twitch-Anwendung | Zeichenkette aus der Developer Console |
| `TWITCH_CLIENT_SECRET` | Client-Secret derselben Anwendung; trägt den OAuth-Austausch | Zeichenkette aus der Developer Console |
| `TWITCH_EVENTSUB_SECRET` | gemeinsames Geheimnis für die HMAC-Signaturprüfung eingehender EventSub-Webhooks | frei gewählte Zufallszeichenkette, mindestens 10 Zeichen |
| `PUBLIC_ORIGIN` | öffentliche Origin der Umgebung; bestimmt OAuth-Redirect und Overlay-URLs | absolute URL ohne Schrägstrich am Ende |
| `SESSION_COOKIE_KEYS` | Schlüsselsatz für die Signatur der Session-Cookies | JSON `{"active":{"id":"...","key":"..."}}`, Schlüssel 32 Byte base64url |
| `SESSION_ENCRYPTION_KEYS` | Schlüsselsatz für die Verschlüsselung der Session-Inhalte | wie oben, eigener Wert |
| `OVERLAY_TOKEN_PEPPER` | Pepper für die Hashes widerrufbarer Overlay-Tokens | 32 Byte base64url |

Die drei Schlüsselwerte (`SESSION_COOKIE_KEYS`, `SESSION_ENCRYPTION_KEYS`, `OVERLAY_TOKEN_PEPPER`) werden mit dem im Erstaufsetzen dokumentierten `openssl`-Befehl erzeugt und sind je Umgebung und je Zweck unterschiedlich — niemals denselben Wert doppelt verwenden.

**Bindings** (keine Umgebungsvariablen, sondern Cloudflare-Ressourcen aus `wrangler.jsonc`):

| Binding | Ressource |
|---|---|
| `DB` | D1-Datenbank der Umgebung |
| `CHANNEL` | Durable-Object-Namespace `ChannelObject`, ein Objekt je Kanal |
| `ASSETS` | statische Dashboard- und Overlay-Dateien aus `dist/client` |
| `CF_VERSION_METADATA` | Versionsmetadaten des Deployments |

`/healthz` prüft eine im Worker hinterlegte Liste (`REQUIRED_SECRET_NAMES`) und meldet einen Namen als fehlend, wenn der zugehörige Wert leer ist oder noch einen Platzhalter (`replace-with`, `example.invalid`) enthält — niemals den Wert selbst. `pnpm run config:verify` stellt sicher, dass diese Liste im Worker, `secrets.required` in `wrangler.jsonc` (alle Umgebungen) und das Verify-Script selbst übereinstimmen; weichen sie voneinander ab, schlägt die Prüfung fehl.

## Lokale Entwicklung

```bash
cp .dev.vars.example .dev.vars
pnpm install
pnpm run dev
```

Das Dashboard ist unter `http://localhost:5173/` und das Overlay unter `http://localhost:5173/overlay.html` erreichbar. Lokale Cloudflare-Bindings werden durch Vite/Wrangler simuliert. Die Beispielwerte sind absichtlich keine produktiven Secrets.

## Prüfung und Deployment

Vor jedem Deployment:

```bash
pnpm install --frozen-lockfile
pnpm run check
```

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

## Secret-Rotation

Eine Rotation erfolgt durch Aktualisieren der sicheren Betreiberdatei und erneutes Ausführen des passenden Deploy-Skripts. Cookie-, Verschlüsselungs- und Overlay-Schlüssel getrennt erzeugen. Der bisherige Wert darf weder in Logs noch in Tickets oder Git landen. Vor dem Rotieren sicherstellen, dass die neue Datei im Betreiber-Backup gesichert ist.

`.env.staging` und `.env.production` sind ignoriert und werden aus dem Betreiber-Backup bereitgestellt. Ihre Inhalte gehören niemals in Terminalausgaben, Tickets, Pull Requests oder das Repository. Gleiches gilt für `.dev.vars`.

## Sicherheits- und Betriebsgrenzen

- Ein Kanal wird durch eine Zeile in `channels` freigegeben; dafür gibt es bewusst keine Konfigurationsvariable.
- `channelId` darf nicht durch eine globale Rolle oder eine globale Token-Tabelle ersetzt werden.
- Die alte Twitch- oder Session-Autorisierung bei einem Incident bewusst über die vorgesehenen Secrets rotieren.
- Vor einem öffentlichen Betrieb die aktuellen Cloudflare-Quoten und Wrangler-Dokumentation erneut prüfen.
