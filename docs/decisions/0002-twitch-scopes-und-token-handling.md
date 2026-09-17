# Twitch-Scopes und Token-Handling

**Stand:** 17. September 2026
**Status:** Vorlage — zur Entscheidung, siehe [#2](https://github.com/smb-org/BroBot/issues/2)
**Betrifft:** `twitch_connections`, den OAuth-Flow aus #18, jedes Modul, das Helix aufruft

---

## 1. Kurzfazit

1. **Es gibt drei Token, nicht zwei** — Login, Bot und Broadcaster. Sie unterscheiden sich vor allem darin, wie teuer ein nachträglicher Scope ist.
2. **Der Bot postet als eigener Bot-Account**, nicht als Broadcaster. Zuschauer müssen Bot-Nachrichten vom Streamer unterscheiden können, und ein Broadcaster-Token, das auch Chat schreibt, bündelt zwei Zwecke in einem Geheimnis.
3. **Ein Kanal ist betriebsbereit, sobald der Bot dort gemoddet ist.** Die Broadcaster-Verbindung ist kein Fundament, sondern ein optionaler Schalter je Kanal. Sie wird erst gebaut, wenn ein Modul sie belegt braucht.
4. **EventSub läuft über Webhook mit App-Token.** Das passt zum Worker, der kein dauerhaft laufender Prozess ist. WebSocket-Transport scheidet aus, weil er einen offenen Prozess und ein User-Token verlangt.

---

## 2. Drei Token, drei Kostenprofile

| | Wer autorisiert | Wie oft | Ein Scope mehr kostet |
|---|---|---|---|
| **Login** | jeder Panel-Nutzer | bei jedem Login | nichts — der nächste Login holt ihn |
| **Bot** | der Bot-Account | **einmal insgesamt**, nicht pro Kanal | eine einzige Neu-Autorisierung |
| **Broadcaster** | jeder Broadcaster | **einmal pro Kanal** | jeder Broadcaster erneut durch den Zustimmungsdialog |

Daraus folgt die Regel für die Scope-Auswahl: beim Login egal, beim Bot großzügig, beim Broadcaster diszipliniert. Jeder Broadcaster-Scope steht sichtbar im Zustimmungsdialog — eine Liste aus Lesezugriffen liest sich anders als eine mit `channel:manage:broadcast` oder `channel:read:stream_key`.

Im laufenden Betrieb taucht der Broadcaster in keinem Ablauf auf. Er autorisiert einmal beim Einrichten; danach signiert der Worker die Aufrufe mit dem gespeicherten Token, und bedient wird vom Mod im Panel.

---

## 3. Scope-Listen

### Login

```
user:read:moderated_channels     Kanal-Vorbelegung beim Anmelden
```

`user:read:email` wird **nicht** angefragt. Get Users liefert die Identität ohne ihn; er schaltet nur ein Feld frei, das wir nicht brauchen.

### Bot — hier großzügig

```
user:bot                         Vorbedingung für Chat lesen und senden
user:read:chat                   channel.chat.message  (#10, #11, #12)
user:write:chat                  Senden: Shoutout, Clip-Link, Déjà-vu-Antwort
moderator:manage:shoutouts       Send a Shoutout  (#9)
moderator:manage:announcements   hervorgehobenes Danke  (#9)
clips:edit                       Create Clip  (#11)
moderator:read:chatters          Get Chatters — aktive Chatter für #14
moderator:read:followers         Follow-Ereignisse für die Timeline  (#14)
moderator:read:shoutouts         erkennt Shoutouts des vorhandenen Bots  (#5)
moderator:manage:chat_messages   Déjà-vu-Antwort anpinnen  (#12)
```

Dazu unter Vorbehalt, siehe Abschnitt 4:

```
channel:manage:polls             Polls anlegen und beenden  (#8)
channel:manage:predictions       Predictions anlegen und beenden  (#8)
```

**Bewusst nicht:** die gesamte Moderationsfläche — AutoMod, Banns, Blocked Terms, Warnings, Unban-Requests, Shield Mode, Suspicious Users. Moderation bleibt laut #5 beim vorhandenen Bot. Ebenso Whispers, Emotes, Follows, Blocked Users, Chat-Farbe, Analytics und Guest Star.

### Broadcaster — optional je Kanal, erst wenn gebraucht

Es gibt **keine feste Liste**. Scopes werden **je Modul** angefragt, wenn der Broadcaster das Modul im Panel einschaltet — er ist in dem Moment ohnehin anwesend. Dadurch bleibt jeder einzelne Dialog klein und selbsterklärend, statt beim Einrichten eine lange Liste auf Vorrat zu zeigen.

| Modul | Scopes |
|---|---|
| #22 Werbepausen-Ankündigung | `channel:read:ads`, optional `channel:manage:ads` |
| #21 Channel Points als Auslöser | `channel:read:redemptions`, `channel:manage:redemptions` |

Mehr ist derzeit nicht vorgesehen. Jedes optionale Modul bringt seine Scopes selbst mit und **deaktiviert sich sichtbar**, wenn sie fehlen — nicht stillschweigend.

**Bewusst gestrichen:** `bits:read`, `channel:read:subscriptions`, `channel:read:hype_train`. Sie standen in einem früheren Entwurf als „Timeline-Extras" — **kein Epic fordert sie**. #14 nennt aktive Zuschauer, Viewerzahl, Nachrichtenrate, Wortfrequenz-Baseline, Clips, Emote-Spitzen, Stream-Abbrüche und Bitrate. Nichts davon braucht diese Scopes. Subs, Gift-Subs und Raids erreichen den Bot ohnehin über `channel.chat.notification`, das am selben `user:read:chat` hängt.

**Ebenfalls gestrichen:** `channel:bot`. Er würde dem Bot erlauben, ohne Mod-Rolle zu schreiben — aber ohne Mod-Rolle scheitern Shoutout, Announcement und Get Chatters ohnehin. Die Mod-Rolle ist Betriebsvoraussetzung, wie bei anderen Twitch-Bots auch; ein Bot, der nur noch reden kann, ist kein brauchbarer Zustand. Überwacht wird sie über Abschnitt 9.

**Bewusst nicht:** `channel:read:stream_key`, `channel:edit:commercial`, `channel:manage:raids`, `channel:manage:schedule`, `channel:manage:videos`, `channel:*:vips`, `channel:read:charity`, `channel:read:editors`, `channel:manage:extensions`, `channel:manage:moderators`, `channel:moderate`, Guest Star.

**Zurückgestellt, nicht verworfen:** `channel:manage:broadcast` für einen Stream-Marker beim Clip-Auslöser (#11), `channel:read:goals` und `channel:read:hype_train` für Overlay-Anzeigen, sobald die Strecke aus #7 steht. Alle drei erst mit einem konkreten Modul.

**Nachziehen statt vorhalten:** `channel:manage:clips` beziehungsweise `editor:manage:clips` für VOD-Clips. Die stehen in #11 ausdrücklich außerhalb des Epics.

**Legacy, nie:** `chat:read`, `chat:edit`, `whispers:read` — IRC und PubSub. Wir fahren EventSub plus Helix.

---

## 4. Annahme zu #8 — ausdrücklich ungeprüft

**Angenommen wird:** Der Bot-Account kann mit `channel:manage:polls` und `channel:manage:predictions` als Moderator des Kanals Polls und Predictions des Broadcasters anlegen und beenden.

Grundlage ist der Guide-Text unter `dev.twitch.tv/docs/api/polls/`: „The broadcaster's moderators or editors can create or manage the broadcaster's polls." Derselbe Satz steht sinngleich im Predictions-Guide.

**Dagegen spricht:** Die Endpoint-Referenz sagt bei allen vier Endpunkten „This ID must match the user ID in the user access token", es gibt keinen `moderator_id`-Parameter, und der einzige auffindbare Erfahrungsbericht im Entwicklerforum endet mit genau diesem Fehler.

**Deshalb gilt:** Die Annahme wird durch einen echten API-Aufruf geprüft, bevor #8 gebaut wird — ein `POST /helix/polls` mit dem Token eines gemoddeten Zweitaccounts gegen eine fremde `broadcaster_id`. Die dafür nötige Twitch-App steht ohnehin vor #18 an.

**Fällt die Prüfung negativ aus**, wandern die beiden Scopes aus der Bot- in die Broadcaster-Liste und #8 setzt eine verbundene Broadcaster-Autorisierung voraus. Weil die Broadcaster-Verbindung ohnehin als optionaler Schalter vorgesehen ist, kostet das einen Scope-Nachtrag, keinen Umbau. Auf die übrigen Module hat der Ausgang keinen Einfluss.

---

## 5. Was der Broadcaster freischaltet

Ein Kanal läuft, sobald der Bot gemoddet ist. Verbindet der Broadcaster zusätzlich, kommt hinzu:

Die Verbindung ist kein Schalter für Auswertungsqualität, sondern für **optionale Module**: #22 Werbepausen-Ankündigung und #21 Channel Points als Auslöser. Beides sind Funktionen, die ein Streamer sofort versteht — deutlich greifbarer als „genauere Auswertung".

Keines der geplanten Pflichtmodule hängt daran. Die Verbindung entsteht, wenn jemand eines der optionalen Module einschaltet — oder mit #8, falls die Prüfung aus Abschnitt 4 negativ ausfällt. In Phase 1 sowie für #9, #10, #11, #12 und #13 entsteht sie nicht.

**Bewusst nicht als Modul vorgesehen**, obwohl technisch möglich: Stream-Key lesen, VODs löschen, Sendeplan pflegen, Moderatoren verwalten, Werbung auslösen, Raids starten. Der Stream-Marker beim Clip-Auslöser (`channel:manage:broadcast`) ist ein Kandidat für #11, aber kein eigenes Modul; Goals und Hype Train im Overlay warten, bis die Strecke aus #7 steht.

---

## 6. Keine Moderator-Vorschlagsliste

Get Moderators verlangt `moderation:read` **und** den Broadcaster-Token. Der Scope `moderator:read:moderators` klingt nach einer Alternative, schaltet aber keinen API-Endpunkt frei, sondern nur EventSub-Ereignisse. Der Chat-Befehl `/mods` steht seit Februar 2023 in der IRC-Deprecation-Liste.

**Stattdessen:** Der Bot liest den Chat ohnehin. Jedes `channel.chat.message`-Ereignis trägt die Abzeichen des Absenders, darunter das Moderator-Abzeichen. Moderatoren werden dadurch nebenbei erkannt, ohne einen einzigen zusätzlichen Scope.

Wer nie schreibt, fehlt in dieser Liste — das ist hinnehmbar, weil #16 ohnehin vorsieht, beliebige Twitch-Nutzer zu suchen und mit ausdrücklicher Sicherheitsabfrage hinzuzufügen. Die Berechtigung selbst bleibt unverändert: autorisiert ist nur, wer eine Zeile in `channel_members` hat.

---

## 7. Token-Erneuerung

- Der Worker ist ein **Confidential Client** — das Client-Secret liegt in einem Worker-Secret und erreicht keinen Browser. Dadurch laufen Refresh-Tokens nicht nach 30 Tagen ab, anders als bei einem Public Client.
- **Refresh-Tokens rotieren:** Jeder Refresh gibt einen neuen aus. Der alte wird im selben Schreibvorgang ersetzt, sonst entsteht bei einem Fehlschlag eine Verbindung ohne gültigen Refresh-Token.
- Twitch verlangt, Tokens **beim Start und danach stündlich** über `/oauth2/validate` zu prüfen. Daraus folgt ein **Cron-Trigger** in `wrangler.jsonc`, den es heute noch nicht gibt. Derselbe Lauf erneuert Tokens, die in weniger als einer Stunde ablaufen, und prüft den Moderatorstatus des Bots.
- Ein erneuter Login wird nur nötig, wenn der Nutzer die App entzieht, sein Passwort ändert oder **wir einen neuen Scope brauchen**. Nur der dritte Fall ist vermeidbar — deshalb die Disziplin in Abschnitt 3.
- **Bei Widerruf kein Endlos-Retry.** Die Verbindung wird als getrennt markiert, die Ursache festgehalten, und das Panel zeigt den Zustand mit einem Weg zur erneuten Verbindung.

---

## 8. EventSub

- **Transport Webhook**, signiert mit `TWITCH_EVENTSUB_SECRET`. Das Secret ist bereits vorgesehen.
- Für Abonnements mit Scope-Anforderung muss der in der Bedingung genannte Nutzer die App **vorher autorisiert haben** — auch wenn das Abonnement selbst mit App-Token angelegt wird. Wo Twitch eine Delegation an Moderatoren vorsieht, trägt die Bedingung ein eigenes `moderator_user_id`-Feld, etwa bei `channel.follow`. Fehlt dieses Feld, gibt es keinen Mod-Weg.
- `channel.raid` und `stream.online` brauchen **keine** Autorisierung. Für Nutzer, die die App nicht autorisiert haben, zählen solche Abonnements allerdings gegen das Kostenkontingent der Client-ID — bei wenigen Kanälen unkritisch, bei vielen ein Thema.
- **Widerruf kommt als Benachrichtigung** über denselben Webhook, mit Status `authorization_revoked` — es gibt keinen zweiten Callback dafür. Der Worker markiert die Verbindung als getrennt, räumt die zugehörigen Abonnements ab und legt sie nicht neu an.
- Abonnements werden beim Verbinden eines Kanals angelegt und beim Trennen entfernt, nicht bei jedem Deploy. Kontingent und Rate-Limit gelten pro Client-ID, nicht pro Kanal — ein aktiver Kanal darf den anderen nichts wegnehmen.
- **Conduits sind vorgemerkt, nicht eingeplant.** Sie lohnen sich bei vielen Kanälen; bei der erwarteten Größenordnung kostet die Zusatzschicht mehr, als sie spart.

### Abonnements überleben Deploys — Ausfälle trotzdem aktiv suchen

Abonnements liegen bei Twitch und hängen an der Callback-URL. Ein Deploy fasst sie nicht an. Antwortet der Callback aber wiederholt nicht rechtzeitig mit 2xx, schaltet Twitch das Abo mit Status `notification_failures_exceeded` ab.

Twitch meldet das über eine Revocation-Nachricht auf demselben Webhook. **Darauf allein darf man sich nicht verlassen:** Die Meldung geht an genau den Callback, der gerade als unerreichbar gilt, und wird laut Doku einmal gesendet. Ob sie wiederholt wird, wenn auch sie scheitert, ist nicht dokumentiert. Die Statuswerte `moderator_removed`, `chat_user_banned` und `beta_maintenance` tauchen in der Revocation-Liste zudem gar nicht auf.

**Deshalb beides:**

1. **Revocation-Handler** — Nachrichtentyp `revocation`, Grund aus `subscription.status`, mit 2xx antworten, Abo in der Datenbank als tot markieren.
2. **Stündlicher Abgleich** im selben Cron-Lauf wie die Token-Erneuerung: `GET /helix/eventsub/subscriptions` mit App-Token, ohne Filter, durchpaginiert, gegen den Soll-Zustand aus freigegebenen Kanälen mal aktivierten Modulen. Fehlende anlegen, verwaiste löschen, abgeschaltete neu anlegen.

Der Abgleich kann den Ausfall nicht verpassen: Abgeschaltete Webhook-Abos bleiben **mindestens zehn Tage** in der Liste sichtbar, samt Grund. Die Seitengröße ist nicht zugesichert, also Cursor-Schleife statt einer Seite. `total` ist laut Doku eine Näherung — ausgewertet wird `data`.

Nicht dokumentiert und deshalb keine Grundlage für Annahmen: wie viele Fehlschläge über welchen Zeitraum zur Abschaltung führen, der genaue Callback-Timeout, die Retry-Kurve und das Zeitfenster der Callback-Verifizierung.

### Die Callback-URL ist unveränderlich

Für Abonnements gibt es nur Create, Get und Delete — **kein Update**. Ein Wechsel der Callback-URL erzwingt, alle Abos unter der neuen URL neu anzulegen, neu verifizieren zu lassen und die alten zu löschen. Die Doku warnt ausdrücklich, dass alte Abos sonst weiter an die alte URL senden.

Daraus folgt: **eine stabile Callback-Domain ab Tag 1**, gebildet aus `PUBLIC_ORIGIN`. Keine Preview-URL, kein `workers.dev`. `workers_dev` und `preview_urls` stehen in `wrangler.jsonc` bereits auf `false`.

### Das Secret hängt am einzelnen Abonnement

Das HMAC-Secret wird beim Anlegen im `transport`-Objekt gesetzt, taucht in keiner Antwort wieder auf und lässt sich nachträglich nicht ändern. Eine Rotation erzwingt damit das Neuanlegen aller Abonnements.

**`TWITCH_EVENTSUB_SECRET` wird deshalb als Liste geführt**, nach demselben Muster wie `SESSION_COOKIE_KEYS`: Der erste Eintrag signiert neue Abonnements, die weiteren werden beim Verifizieren noch akzeptiert. Der stündliche Abgleich baut die Abos danach rollierend um, statt alle auf einmal zu kippen. Ein eigenes Secret je Abonnement in der Datenbank wäre die Alternative — sie kostet mehr Verwaltung und bringt bei dieser Größenordnung nichts dazu.

### Was der Handler einhalten muss

- Das HMAC wird über den **rohen** Body gebildet: `request.text()` vor jedem Parsen, nie `request.json()` vor der Signaturprüfung.
- Die Antwort auf die Verifizierungs-Challenge ist der **rohe String**, kein JSON. Frameworks, die automatisch JSON serialisieren, brechen die Einrichtung.
- Sofort mit 2xx antworten, die Verarbeitung über `waitUntil` entkoppeln.
- Zeitstempel sind RFC3339 **mit Nanosekunden**; `Date.parse()` verträgt das nicht zuverlässig.
- Deduplizierung über `Twitch-Eventsub-Message-Id`; das dokumentierte Replay-Fenster beträgt zehn Minuten, die Aufbewahrung der IDs also mindestens ebenso lange.
- Der Callback muss HTTPS auf Port 443 sein; Weiterleitungen werden nicht verfolgt.

### Kosten

Ein Abonnement kostet nichts, wenn der betroffene Nutzer die Anwendung autorisiert hat. Da ein Kanal ohnehin über OAuth eingerichtet wird, liegen unsere Abos bei `cost: 0`. Eine feste Obergrenze je Client-ID ist nicht dokumentiert, nur `max_total_cost` — der Wert wird aus der Antwort gelesen, nicht fest verdrahtet. Harte Regel daneben: höchstens drei Abonnements mit derselben Kombination aus Typ und Bedingung.

---

## 9. Moderatorstatus des Bots

Die Moderatorrolle des Bots ist **Betriebsvoraussetzung**, nicht Komfort: Ohne sie scheitern Shoutout, Announcement, Chatter-Liste und — je nach Ausgang von Abschnitt 4 — auch #8, ohne das Problem anzuzeigen. Der Bot prüft seinen eigenen Status **ohne Broadcaster-Token**: Get Moderated Channels mit seinem eigenen Token, gefiltert auf den Zielkanal. Das läuft im stündlichen Cron-Lauf mit und wird im Panel sichtbar.

---

## 10. Folgen

- Kein Schema-Umbau nötig: `twitch_connections` trägt Kanal, Zweck, Scopes und Ablauf bereits. Die Broadcaster-Zeile bleibt für viele Kanäle schlicht leer.
- `wrangler.jsonc` braucht einen Cron-Trigger für Validierung, Erneuerung, Mod-Status-Prüfung und den EventSub-Abgleich.
- `TWITCH_EVENTSUB_SECRET` wird eine Liste. Das betrifft `scripts/verify-deployment-config.mjs`, die Secret-Listen in `wrangler.jsonc` und die Prüfung in `src/worker/index.ts`.
- #18 legt Login und Bot-Verbindung an. Die Broadcaster-Verbindung entsteht erst mit dem Modul, das sie belegt braucht.
- #16 verliert die Moderator-Vorschlagsliste; erkannt wird über Chat-Abzeichen.
- Die Broadcaster-Verbindung trägt #21 und #22. Beide Module deaktivieren sich sichtbar, wenn sie fehlt.
- Vor #8 steht der API-Test aus Abschnitt 4.
