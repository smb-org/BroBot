# Betriebshandbuch

## Erstaufsetzen

1. In der [Twitch Developer Console](https://dev.twitch.tv/console/apps) eine Twitch-Anwendung anlegen. Client-ID und Client-Secret gehören in den sicheren Betreiberbestand. Die spätere OAuth-Callback-URL muss unter `PUBLIC_ORIGIN` auf `/auth/twitch/callback` zeigen.
2. Für jede Umgebung eine D1-Datenbank erzeugen, zum Beispiel:

   ```bash
   pnpm exec wrangler d1 create brobot-local
   pnpm exec wrangler d1 create brobot-staging
   pnpm exec wrangler d1 create brobot-production
   ```

   Die D1-IDs sind in `wrangler.jsonc` bereits eingetragen; die früher dokumentierten Null-UUID-Platzhalter sind überholt. Für eine neu angelegte Umgebung die von Wrangler gelieferte `database_id` in der passenden Umgebung eintragen und vor der Migration prüfen. Danach alle Migrationen aus `migrations/` der Reihe nach mit Wrangler ausführen, sobald die Datenbank verfügbar ist.
3. Für Schlüssel jeweils erzeugen:

   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
   ```

   Für `SESSION_COOKIE_KEYS` und `TOKEN_ENCRYPTION_KEYS` jeweils einen
   eigenen aktiven Schlüsselring mit optionalen `retired`-Einträgen verwenden.
   `TWITCH_EVENTSUB_SECRET` hat dasselbe Format; sein aktiver Eintrag signiert
   neue Abonnements, ausgemusterte Einträge werden während der Rotation noch
   gelesen. Für `OVERLAY_TOKEN_PEPPER` einen einzelnen, getrennten Wert und
   für die übrigen Variablen echte Betreiber-Secrets festlegen. Das über
   Client-Credentials bezogene App Access Token wird vom Worker verschlüsselt
   in D1 zwischengespeichert und vor Ablauf erneuert; dafür gibt es kein
   Refresh-Token und kein zusätzliches Secret. Die
   Beispieldateien zeigen die genaue JSON-Struktur.
4. Für lokal `.dev.vars.example` nach `.dev.vars` kopieren und die Platzhalter ersetzen. Die produktiven Staging- und Production-Secrets werden einmalig mit `wrangler secret put` in Cloudflare gesetzt. `.env.staging` und `.env.production` bleiben nur als sicherer Betreiberbestand für den ausdrücklich benannten lokalen Notfallweg erhalten.
5. Einen neuen Kanal gibt der Betreiber frei, indem er ihn in `channels` anlegt
   und den Broadcaster in `channel_members` einträgt. Der Bot wird anschließend
   als reine Twitch-Aktion gemoddet. Der Betreiber autorisiert den Bot einmal
   über `GET /auth/bot/login`; diese Autorisierung wird nicht je Kanal kopiert.
   Eine Broadcaster-Autorisierung entsteht erst mit einem Modul, das sie
   benötigt.

## Overlay einrichten und verwalten

Öffne im Dashboard den gewünschten Kanal und wähle **Overlays**. Erstelle ein
Overlay, lege Leinwandgröße und Namen fest und öffne den Editor, um
Kanalvariablen als Elemente hinzuzufügen. Position, Skalierung, Ebenen und
Sichtbarkeit werden im gespeicherten Overlay verwaltet.

### OBS-Browserquelle

1. Stelle im Overlay unter **Zugänge** einen benannten Zugang aus, zum Beispiel
   „OBS“. Die vollständige URL wird nur beim Ausstellen angezeigt; kopiere sie
   dort oder zeige sie über **Link erneut anzeigen**.
2. Öffne den Einrichtungsassistenten und wähle **OBS**. Entscheide, ob die
   Quelle das ganze Overlay oder ein einzelnes Element ausgibt, und kopiere
   den passenden Link.
3. Lege in OBS eine **Browserquelle** an, füge den Link als URL ein und setze
   Breite und Höhe auf die im Assistenten angezeigten Maße. Lass
   „Browser aktualisieren, wenn Szene aktiv wird“ und „Quelle schließen, wenn
   nicht sichtbar“ ausgeschaltet; die Quelle aktualisiert sich selbst.
4. Lass OBS-„Benutzerdefiniertes CSS“ leer. Passe die Darstellung stattdessen
   im CSS des gespeicherten Overlays an. Die Seite bleibt transparent.

### StreamElements und Sound Alerts

Wähle im selben Einrichtungsassistenten **StreamElements** oder **Sound
Alerts**. Für StreamElements kopiere die HTML-, JS- und Fields-Inhalte in ein
Custom Widget. Für Sound Alerts folge dem Import- oder Custom-Widget-Pfad im
Assistenten und übernimm dieselben Inhalte; der Assistent kennzeichnet den
Importpfad als noch nicht verifiziert. Setze in Fields `brobotAddress`
auf den HTTPS-Ursprung des Overlay-Links und `overlayUrl` auf die vollständige
URL mit Token. Lass das CSS-Feld des Widget-Anbieters leer. Der Assistent
zeigt auch, ob das ganze Overlay oder ein einzelnes Element ausgegeben wird
und welche Platzierung dazu passt.

### Zugänge ersetzen und widerrufen

Jeder gespeicherte Zugang ist kanal- und overlaygebunden. In der Zugangsliste
kannst du ihn erneut anzeigen, ersetzen oder widerrufen. Ersetzen stellt einen
neuen Link aus. Aktualisiere die zugehörige OBS- oder Widget-Quelle mit dem
neuen Link und widerrufe den alten Zugang, sobald die neue Quelle läuft. Beim
Widerruf werden verbundene Echtzeitverbindungen geschlossen; eine Quelle mit
widerrufenem Link bleibt leer. Ein Zugang bleibt gültig, bis er widerrufen
wird oder das zugehörige Overlay gelöscht wird.

### Vorhandene Alt-Links importieren

Die Dashboard-Seite **Overlays** zeigt aktive ungebundene Alt-Links im Bereich
**Alte Links**. Wähle **Importieren** und füge den bisherigen Overlay-Link mit
`#token=…&var=<name>&text=<Vorlage>` ein. Der Import erstellt ein gespeichertes
Overlay mit der ausgewählten Kanalvariable und dem Anzeigetext und bindet den
bestehenden Token daran. Benutzerdefiniertes OBS-CSS und dortige Positionen
werden nicht übernommen. Da derselbe Token mehrere alte Fragment-Links bedient
haben kann, zeigen alle diese Quellen nach dem Import dasselbe gespeicherte
Overlay. Der Import speichert kein wiederherstellbares Secret für den
übernommenen Token; die bestehende OBS- oder Widget-Quelle mit dem alten Link
läuft unverändert weiter, aber der Einrichtungsassistent kann diesen Zugang
danach nicht mehr erneut anzeigen. Um dieselbe Quelle über den Assistenten neu
einzurichten oder eine zusätzliche Quelle anzubinden, stelle einen neuen
benannten Zugang aus (oder ersetze den importierten Zugang) und verwende
dessen Link.

Aktive Alt-Links können im selben Bereich gelistet und widerrufen werden. Neue
ungebundene Links lassen sich nicht mehr ausstellen; neue Quellen erhalten
immer einen Zugang zu einem gespeicherten Overlay.

## Umgebungsvariablen und Bindings

**Konfigurationsvariablen** (stehen als `vars` in `wrangler.jsonc`, sind keine Secrets, landen im Repo):

| Name | Bedeutung |
|---|---|
| `APP_ENV` | `local`, `staging` oder `production`; unterscheidet Umgebungsverhalten und wird vom Deploy-Preflight geprüft |
| `TIMEZONE` | IANA-Zeitzone, zum Beispiel `Europe/Berlin` |
| `TWITCH_BOT_LOGIN` | Öffentlicher Twitch-Login des einzigen Bot-Accounts; der Bot-Callback akzeptiert keine andere Identität |

**Secrets** (nur als Namen unter `secrets.required` in `wrangler.jsonc`; produktive Werte liegen als Secret-Bindings in Cloudflare, lokal kommen sie aus `.dev.vars`):

| Name | Bedeutung | Format |
|---|---|---|
| `TWITCH_CLIENT_ID` | Client-ID der Twitch-Anwendung | Zeichenkette aus der Developer Console |
| `TWITCH_CLIENT_SECRET` | Client-Secret derselben Anwendung; trägt den OAuth-Austausch | Zeichenkette aus der Developer Console |
| `TWITCH_EVENTSUB_SECRET` | Schlüsselring für die HMAC-Signaturprüfung eingehender EventSub-Webhooks | JSON `{"active":{"id":"...","key":"..."},"retired":[...]}` |
| `PUBLIC_ORIGIN` | öffentliche Origin der Umgebung; bestimmt OAuth-Redirect und Overlay-URLs | absolute URL ohne Schrägstrich am Ende |
| `SESSION_COOKIE_KEYS` | Schlüsselsatz für die Signatur der Session-Cookies | JSON `{"active":{"id":"...","key":"..."},"retired":[...]}`, Schlüssel 32 Byte base64url |
| `TOKEN_ENCRYPTION_KEYS` | Schlüsselsatz für verschlüsselte Twitch-Login- und Bot-Tokens | JSON `{"active":{"id":"...","key":"..."},"retired":[...]}`, Schlüssel 32 Byte base64url |
| `OVERLAY_TOKEN_PEPPER` | Pepper für die Hashes widerrufbarer Overlay-Tokens | 32 Byte base64url |

Die vier Schlüsselwerte (`TWITCH_EVENTSUB_SECRET`, `SESSION_COOKIE_KEYS`,
`TOKEN_ENCRYPTION_KEYS` und `OVERLAY_TOKEN_PEPPER`) werden mit dem im
Erstaufsetzen dokumentierten `openssl`-Befehl erzeugt und sind je Umgebung und
je Zweck unterschiedlich — niemals denselben Wert doppelt verwenden.

Bei `SESSION_COOKIE_KEYS` und `TWITCH_EVENTSUB_SECRET` signiert nur `active`
neu. Ein Eintrag unter `retired` bleibt so lange erhalten, bis keine alten
Cookies beziehungsweise EventSub-Abonnements mehr existieren.

Bei `TOKEN_ENCRYPTION_KEYS` verschlüsselt `active` neue Twitch-Tokens sowie
neue Overlay-Zugangs-Secrets. Ein `retired`-Eintrag bleibt erhalten, bis die
Prüfung auf verbleibende Ciphertexte mit seiner `keyId` keinen Treffer mehr
liefert. Die Prüfung muss drei Tokenbestände umfassen: `bot_identity` sowie
`twitch_login_identity`, jeweils für Access- und Refresh-Ciphertext, und
`overlay_tokens.secret_envelope` für die erneut anzeigbaren Overlay-Zugänge.
Erst wenn diese Bestandsprüfung null Treffer ergibt, darf der alte Eintrag aus
dem Ring entfernt werden. Ein fehlgeschlagener Refresh kann einen alten
Ciphertext länger als die normale Übergangszeit erhalten; sieben Tage sind
deshalb keine ausreichende Freigabe allein aufgrund des Alters. Wird ein alter
Schlüssel entfernt, während noch ein `secret_envelope` damit verschlüsselt
ist, schlägt **Link erneut anzeigen** für diesen Zugang fehl.

Der Worker bevorzugt `TOKEN_ENCRYPTION_KEYS`. Während der Übergangsphase
akzeptiert er ersatzweise noch `SESSION_ENCRYPTION_KEYS`, damit ein
schrittweises Secret-Rollout keine Entschlüsselungslücke erzeugt. Dieser
Fallback ist ausdrücklich vorübergehend und wird in einem eigenen späteren
Schritt entfernt; erst danach darf der alte Secret-Name aus dem
Betreiberbestand verschwinden.

### Cloudflare-Secrets, CI und GitHub

Die sieben Anwendungs-Secrets werden je Umgebung einmalig beziehungsweise bei
einer Rotation direkt in Cloudflare gepflegt. `wrangler secret put` fragt den
Wert interaktiv ab; Secret-Werte nicht in Befehlszeilen, Shell-Historien oder
Logs schreiben:

```bash
for environment in staging production; do
  for name in \
    TWITCH_CLIENT_ID \
    TWITCH_CLIENT_SECRET \
    TWITCH_EVENTSUB_SECRET \
    PUBLIC_ORIGIN \
    SESSION_COOKIE_KEYS \
    TOKEN_ENCRYPTION_KEYS \
    OVERLAY_TOKEN_PEPPER; do
    pnpm exec wrangler secret put "$name" --env "$environment"
  done
done
```

Für eine Rotation genügt derselbe Befehl für das betroffene Secret. Bei einem
Schlüsselring den neuen Schlüssel als `active` setzen und den bisherigen
Schlüssel zunächst unter `retired` behalten. Bei `TOKEN_ENCRYPTION_KEYS` vor
dem Entfernen die oben beschriebene Ciphertext-Bestandsprüfung ausführen; erst
bei null Treffern darf der alte Eintrag entfernt werden. Der CI-Deploy überträgt ausschließlich den Code:
Er verwendet weder `--secrets-file` noch `wrangler secret put` und benötigt
keine `.env.staging`- oder `.env.production`-Datei. `/healthz` schlägt nach dem
Deploy fehl, wenn ein erwartetes Secret oder Binding in Cloudflare fehlt.

Für den CI-Deploy werden in GitHub nur folgende Werte hinterlegt:

- Repository-Variable `CLOUDFLARE_ACCOUNT_ID` mit der Cloudflare-Account-ID.
- Repository-Secret `CLOUDFLARE_API_TOKEN` mit einem auf diesen Account
  beschränkten API-Token.

Der Token braucht auf **Kontoebene**: **Workers Scripts: Edit**,
**Account Settings: Read** und **D1: Edit** (letzteres für die automatische
Staging-Migration). Dazu eine zweite Richtlinie auf **Zonenebene** für die
Domain mit **Workers Routes: Edit** und **Zone: Read**, weil die Umgebungen
über Custom Domains laufen.

Die Trennung ist wesentlich: Workers Scripts und D1 sind Konto-Berechtigungen.
Hängt man sie an eine Domain-Richtlinie, sind sie wirkungslos, und der Deploy
scheitert mit `No access to the specified service`, obwohl der Haken gesetzt
aussieht. Weitere Berechtigungen (KV, R2, Pages, Container) braucht die
CI-Strecke nicht und sollte sie nicht haben. Anwendungs-Secrets werden von der
CI-Strecke nicht verändert. In GitHub unter **Settings → Environments** die
Umgebung `production` anlegen und dort unter **Required reviewers** die
Freigabepflicht konfigurieren. Der Production-Job ist ausschließlich über
`workflow_dispatch` von `main` startbar und wartet vor dem Deploy auf diese
Freigabe.

**Bindings** (keine Umgebungsvariablen, sondern Cloudflare-Ressourcen aus `wrangler.jsonc`):

| Binding | Ressource |
|---|---|
| `DB` | D1-Datenbank der Umgebung |
| `CHANNEL` | Durable-Object-Namespace `ChannelObject`, ein Objekt je Kanal |
| `ASSETS` | statische Dashboard- und Overlay-Dateien aus `dist/client` |
| `CF_VERSION_METADATA` | Versionsmetadaten des Deployments |

`/healthz` prüft die sieben Secret-Namen aus der im Worker hinterlegten Liste
(`REQUIRED_SECRET_NAMES`), die Ressourcen-Bindings `DB`, `CHANNEL`, `ASSETS` und
`CF_VERSION_METADATA`, `PUBLIC_ORIGIN` als absolute Origin sowie die jüngste
D1-Migration samt ihrem Schema-Sentinel. Bei Fehlern meldet die Antwort nur
Namen wie `PUBLIC_ORIGIN`, `DB` oder `DB_SCHEMA`, niemals Secret-Werte. Die
Prüfung liest das Schema mit einem einzelnen Metadaten-Read und schreibt nichts.
`pnpm run config:verify` stellt sicher, dass die Secret-Liste im Worker,
`secrets.required` in `wrangler.jsonc` (alle Umgebungen) und das Verify-Script
selbst übereinstimmen; weichen sie voneinander ab, schlägt die Prüfung fehl.

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

Vor dem ersten Rollout dieser Version alle ausstehenden D1-Migrationen aus
`migrations/` in jeder Zielumgebung anwenden. Der Worker darf erst danach
ausgerollt werden: Er erwartet bereits das Schema, das diese Migrationen
anlegen. Welche Tabellen oder Daten eine Migration betrifft, ergibt sich aus
den SQL-Anweisungen in der jeweiligen Datei — eine Liste hier würde bei jeder
neuen Migration veralten.

**Staging migriert automatisch.** Der Deploy-Workflow wendet ausstehende
Migrationen vor dem Code-Deploy an. Schlägt eine Migration fehl, stoppt der
Job vor dem Code-Deploy und der bisherige Worker bleibt aktiv; bereits
erfolgreich angewandte Migrationen aus demselben Lauf bleiben jedoch im
Schema, D1 rollt nur die fehlgeschlagene Migration selbst zurück.

**Production migriert von Hand.** Das ist Absicht: Bei mehreren ausstehenden
Migrationen kann derselbe Effekt eintreten — nur die fehlschlagende Migration
wird zurückgerollt, bereits erfolgreich angewandte bleiben bestehen —, sodass
das Schema zwischen zwei Ständen landen kann, ohne dass jemand hingesehen
hat. Eine vergessene Migration fängt stattdessen der Healthcheck ab:
`/healthz` lässt den CI-Job nach dem Production-Code-Deploy fehlschlagen, wenn
die jüngste Migration nicht als letzte verzeichnet ist oder eine
Sentinel-Tabelle fehlt; es prüft nicht das gesamte Schema und rollt den
Deploy nicht zurück.

Migration vor dem Deploy, nie danach: Der neue Code erwartet das neue Schema.

```bash
pnpm exec wrangler d1 migrations apply DB
pnpm exec wrangler d1 migrations apply DB --env staging --remote
pnpm exec wrangler d1 migrations apply DB --env production --remote
```

Als Argument akzeptiert Wrangler sowohl den **Bindungsnamen** `DB` als auch
den Datenbanknamen selbst (den beim Anlegen vergebenen Namen); `--env
staging` beziehungsweise `--env production` wählt die Zielumgebung. Die
Befehle verändern ausschließlich die angegebene D1-Datenbank; die
Betreiberdateien mit Secrets werden dabei nicht gelesen.

**Wenn ein Schema von Hand eingespielt wurde**, ohne `migrations apply`,
fehlen möglicherweise Einträge in der Buchführungstabelle `d1_migrations`,
oder die Tabelle existiert noch gar nicht. Der Healthcheck meldet dann ein
fehlendes Schema, obwohl alle Tabellen stehen, und jeder spätere
`migrations apply` scheitert mit `table … already exists`. In diesem Fall vor
dem Nachtragen Existenz und Schema von `d1_migrations` prüfen und nur die
tatsächlich bereits angewandten Dateinamen aus `migrations/`, in der
Reihenfolge ihrer Nummern, verzeichnen:

```bash
pnpm exec wrangler d1 execute DB --env staging --remote \
  --command "INSERT INTO d1_migrations (name, applied_at) VALUES ('0000_baseline.sql', CURRENT_TIMESTAMP), ...;"
```

Staging und Production werden im Normalfall durch GitHub deployed: Staging nach
einem erfolgreichen `quality`-Job bei einem Push auf `main`, Production nur
manuell über `workflow_dispatch` nach der Freigabe der GitHub-Umgebung
`production`. Beide CI-Skripte deployen code-only und bringen keine
Anwendungs-Secrets mit.

Für Erstsetzen der Cloudflare-Secrets sowie für Notfälle bleibt der lokale Weg
mit den sicheren Betreiberdateien erhalten:

```bash
pnpm run deploy:staging:local-with-secrets
pnpm run deploy:production:local-with-secrets
```

Diese beiden Skripte prüfen vor dem Deploy Umgebung, Worker-Namen, `APP_ENV`,
Secret-Namen, die absolute Origin und Platzhalter und übergeben ausnahmsweise mit
`--secrets-file` alle sieben Werte. Die `.env`-Dateien bleiben außerhalb des
Repositories. Die CI-Skripte heißen ausdrücklich
`deploy:staging:ci-code-only` und `deploy:production:ci-code-only`; sie
verwenden keine Secret-Datei. Beide Wege verwenden die vollständige Wrangler-
Umgebung; `env.*` erbt Bindings nicht automatisch.

Nach einem Deploy prüfen:

```bash
curl -i https://<öffentlicher-origin>/healthz
```

`200` bedeutet, dass die erwarteten Secrets und Ressourcen-Bindings vorhanden,
die Origin gültig und das Schema der jüngsten Migration verfügbar ist. Bei
`503` enthält die Antwort ausschließlich Fehlernamen wie `DB`, `CHANNEL`,
`ASSETS`, `CF_VERSION_METADATA`, `PUBLIC_ORIGIN`, `DB_SCHEMA` oder einen der
betroffenen Secret-Namen, niemals Werte.

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
und erneuert sie nur für Identitäten mit mindestens einer aktiven Session:
`auth_sessions.user_id` muss passen, `revoked_at` muss `NULL` sein und
`expires_at` in der Zukunft liegen. Die Prüfung läuft mit höchstens vier
gleichzeitigen Twitch-Aufrufen. Bei einem Widerruf werden die zugehörigen
Sessions serverseitig widerrufen; Identitäten ohne aktive Session werden
nicht künstlich am Leben gehalten.

Die Betreiberaufgabe `GET /auth/bot/login` verwendet denselben Callback, legt
aber keine Session an. Sie schreibt die globale Ein-Zeilen-Identität in
`bot_identity`. Access- und Refresh-Token liegen dort nur verschlüsselt. Eine
Zeile in `twitch_connections` wird für diesen globalen Bot nicht angelegt.

### Wenn die Bot-Scopes erweitert wurden

Die erneute Zustimmung ist eine Betreiberaufgabe und wird genau in dieser
Reihenfolge durchgeführt:

1. Bei Twitch mit dem **eigenen** Konto anmelden.
2. Am Panel anmelden. Dadurch entsteht die Panel-Sitzung, die die Route
   verlangt.
3. Erst jetzt bei Twitch abmelden und mit dem **Bot-Konto** anmelden. Die
   Panel-Sitzung ist ein eigener Cookie und überlebt den Wechsel des Twitch-
   Kontos.
4. `GET /auth/bot/login` aufrufen und den Zustimmungsdialog bestätigen.

Der richtige Dialog listet alle Bot-Scopes auf, nicht nur die beiden Login-
Scopes. Sieht man nur „Lies die Liste von Kanälen, für die du
Moderator-Berechtigungen hast“ und „Tritt dem Chat deines Kanals als
Bot-Nutzer bei“, ist man im Panel-Login gelandet und bei Twitch mit dem
falschen Konto angemeldet.

Die routinemäßige Erneuerung läuft automatisch über den Refresh-Token im
stündlichen Lauf. Manuell ist die Autorisierung nur nötig, wenn Scopes
hinzukommen oder das Refresh-Token ungültig wurde — einmal je Scope-Änderung,
nicht je Kanal.

Der Scheduled-Handler läuft in jeder Umgebung stündlich. Er validiert den
Bot-Token über Twitch, erneuert Token mit weniger als einer Stunde Restlaufzeit
und ersetzt Access- und Refresh-Token in einem D1-Schreibvorgang. Danach prüft
er den Bot über Get Moderated Channels für alle Zeilen in `channels` und hält
den Status in `bot_channel_status` fest. Abgelaufene OAuth-Transaktionen
werden im selben Lauf entfernt. Außerdem räumt er `event_log` auf und löscht
Ereignisse, die älter als 14 Tage sind.

Bei `invalid_grant` oder einer widerrufenen Autorisierung wird der globale
Status mit Ursache `revoked` gespeichert. Der Scheduled-Handler versucht einen
solchen Zustand nicht endlos erneut; der Betreiber startet zur erneuten
Autorisierung wieder `/auth/bot/login`.

Die Scope-Entscheidung in `docs/decisions/0002-twitch-scopes-und-token-handling.md`
führt `user:read:moderated_channels` bewusst sowohl für Login-Tokens als auch
für den Bot-Token auf. Der stündliche Lauf nutzt diesen Bot-Scope für Get
Moderated Channels und speichert den Moderatorstatus je freigegebenem Kanal.

## Secret-Rotation

Eine Rotation erfolgt grundsätzlich mit `wrangler secret put` direkt in der
betroffenen Cloudflare-Umgebung. Cookie- und Token-Schlüssel getrennt erzeugen
und den bisherigen Token-Schlüssel wie oben beschrieben als `retired` behalten.
Vor dem Entfernen des alten Token-Schlüssels die verbleibenden Ciphertexte
prüfen. Der bisherige Wert darf weder in Logs noch in Tickets oder Git landen.
Der lokale Deploy mit `--secrets-file` ist nur der dokumentierte Notfall- und
Erstsetzungsweg.

`OVERLAY_TOKEN_PEPPER` ist kein Schlüsselring und hat keine `retired`-Einträge.
Der Pepper kann aus den bestehenden HMAC-Hashes nicht zurückgerechnet werden;
ein Austausch macht deshalb alle bisher ausgegebenen Overlay-Zugänge
ungültig. Vor der Rotation benötigte ungebundene Alt-Links zuerst importieren.
Danach einen neuen Pepper als Secret setzen, in jedem gespeicherten Overlay
neue Zugänge ausstellen und sämtliche OBS- und Widget-Quellen mit den neuen
Links aktualisieren. Alte Links können nach dem Austausch weder genutzt noch
importiert werden. Alle Quellen prüfen, bevor die Rotation als abgeschlossen
gilt.

Eine Pepper-Rotation darf daher nicht nach der Token-Schlüsselring-Anleitung
mit einem ausgemusterten Eintrag durchgeführt werden.

`.env.staging` und `.env.production` sind ignoriert und werden aus dem Betreiber-Backup bereitgestellt. Ihre Inhalte gehören niemals in Terminalausgaben, Tickets, Pull Requests oder das Repository. Gleiches gilt für `.dev.vars`.

## Sicherheits- und Betriebsgrenzen

- Ein Kanal wird durch eine Zeile in `channels` freigegeben; dafür gibt es bewusst keine Konfigurationsvariable.
- `channelId` darf nicht durch eine globale Rolle oder eine globale Token-Tabelle ersetzt werden.
- Die alte Twitch- oder Session-Autorisierung bei einem Incident bewusst über die vorgesehenen Secrets rotieren.
- Vor einem öffentlichen Betrieb die aktuellen Cloudflare-Quoten und Wrangler-Dokumentation erneut prüfen.
