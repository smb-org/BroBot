# Token-Wahl je Endpunkt: App, Bot, Broadcaster

**Stand:** 21. September 2026
**Status:** entschieden
**Betrifft:** jeden Helix-Aufruf, `chat.ts`, `shoutout.ts`, Betreiberebene
**Beitrag zu:** [#22](https://github.com/smb-org/BroBot/issues/22),
[#11](https://github.com/smb-org/BroBot/issues/11),
[#150](https://github.com/smb-org/BroBot/issues/150)

## Kurzfazit

**Das App-Token ist der Standard.** Ein Nutzertoken nimmt nur, wer muss.

Bisher gab es dafür keine Regel. Das App-Token entstand für EventSub
([0005](0005-eventsub-transport.md)), weil Webhook nichts anderes zulässt; jeder
sendende Aufruf griff danach zum Bot-Nutzertoken, ohne dass das je entschieden
worden wäre. Diese Entscheidung schließt die Lücke, bevor der nächste Aufruf
sie erneut errät.

Drei Gründe für den App-Weg:

1. **Das Bot-Abzeichen im Chat hängt daran.** Twitch vergibt es nur für
   Nachrichten über die Send-Chat-Message-API mit App-Token.
2. **Keine Abhängigkeit von der Token-Erneuerung.** Ein App-Token wird aus
   Client-ID und Secret jederzeit neu geholt; ein scheiternder Wartungslauf
   kann den Chat nicht stilllegen.
3. **Es ist der Weg, den Twitch für Chatbots vorsieht.** Das Ausnahme-Muster
   („Requires one of the following") existiert genau dafür.

## 1. Token und Zustimmung sind zwei verschiedene Dinge

- **Nutzertoken** weist ein konkretes Twitch-Konto aus.
- **App-Token** weist unsere Anwendung aus, also die Client-ID.
- **Zustimmung** ist das, was ein Konto unserer Client-ID einmal erteilt hat.

Ein App-Token trägt **selbst keine** Nutzer-Scopes. Die Endpunkte, die es
zulassen, prüfen die zuvor erteilten Zustimmungen der beteiligten Konten. Die
Formulierung ist in der Referenz überall gleich:

> „An app access token where the application, **through a prior authorization**,
> has the `X` scope for the user represented by the `Y` query parameter."

**Daraus folgt:** Der Bot-Login bleibt Pflicht. Ohne ihn gibt es keine
Zustimmung, auf die sich das App-Token stützen könnte. Was entfällt, ist nur,
das dabei entstandene Zugriffstoken bei jedem Aufruf zu benutzen.

Alle Zustimmungen müssen zur **selben Client-ID** gehören.

Scopes und Kanalrollen sind ebenfalls getrennt: Ein `moderator:`-Scope macht
den Bot nicht zum Moderator. Die Moderatorrolle bleibt Betriebsvoraussetzung
([0002](0002-twitch-scopes-und-token-handling.md) Abschnitt 9).

## 2. Drei Kategorien

Twitch hält eine feste Formel durch. Im gesamten API-Verzeichnis:

| Formulierung | Endpunkte |
|---|---|
| „Requires **one of the following**" — App-Token möglich | 27 |
| „Requires **a user access token**" — nur Nutzertoken | 54 |
| „Requires **an app access token**" — nur App-Token | 43 |

Das ist kein Zufall und keine lückenhafte Doku. Wer einen neuen Aufruf baut,
liest diese Zeile, statt zu schließen.

### Kategorie 1 — App-Token möglich

Alles, was der Bot **als Bot** tut:

| Funktion | Endpunkt |
|---|---|
| Chatnachricht, Ansage, Shoutout, Anpinnen | `chat/messages`, `chat/announcements`, `chat/shoutouts` |
| Bann, Timeout, Entbannen, Nachricht löschen | `moderation/bans`, `moderation/chat` |
| Chat-Einstellungen, AutoMod, Shield Mode, Warnungen, Sperrbegriffe | `chat/settings`, `moderation/automod`, `moderation/shield_mode`, `moderation/warnings`, `moderation/blocked_terms` |
| Werbung starten, Werbeplan lesen, Snooze | `channels/commercial`, `channels/ads`, `channels/ads/schedule/snooze` |
| Chatter-Liste, eigener Moderatorstatus, Follower | `chat/chatters`, `moderation/channels`, `channels/followers` |

„Möglich" heißt: Die nötigen Zustimmungen **und** Rollen müssen vorliegen.

### Kategorie 2 — nur Nutzertoken, das des **Bots**

Genau einer im geplanten Umfang:

| Funktion | Endpunkt | Scope |
|---|---|---|
| Clip erstellen ([#11](https://github.com/smb-org/BroBot/issues/11)) | `POST /helix/clips` | `clips:edit` |

Ein App-Weg existiert nicht. Das Bot-Konto braucht deshalb dauerhaft ein
brauchbares Nutzertoken — zusätzlich zu dem Login, der die Zustimmungen trägt.

### Kategorie 3 — nur Nutzertoken, das des **Broadcasters**

Jeder dieser Endpunkte sagt denselben Satz: *„This ID must match the user ID in
the user access token."* Weder App- noch Bot- noch Editor-Token genügen.

| Funktion | Endpunkt | Scope |
|---|---|---|
| Titel und Kategorie ändern | `PATCH /helix/channels` | `channel:manage:broadcast` |
| Raid starten und abbrechen | `/helix/raids` | `channel:manage:raids` |
| Sendeplan | `/helix/schedule/segment`, `/helix/schedule/settings` | `channel:manage:schedule` |
| Umfragen, Predictions ([#8](https://github.com/smb-org/BroBot/issues/8)) | `/helix/polls`, `/helix/predictions` | `channel:manage:polls`, `channel:manage:predictions` |
| Kanalpunkte ([#21](https://github.com/smb-org/BroBot/issues/21)) | `/helix/channel_points/...` | `channel:manage:redemptions` |
| VIPs, Moderatoren, Unban-Anträge | `/helix/channels/vips`, `/helix/moderation/moderators`, `/helix/moderation/unban_requests` | entsprechend |
| Whisper | `POST /helix/whispers` | `user:manage:whispers` |

**Das ist genau der Funktionsumfang, den die Betreiberebene braucht.** Er
steht und fällt mit einem gültigen Broadcaster-Token — siehe Abschnitt 5.

## 3. Titel und Kategorie ändern, im Einzelnen

Weil es der erste Aufruf dieser Kategorie sein wird:

```
PATCH https://api.twitch.tv/helix/channels?broadcaster_id=<kanal>
```

- Nutzertoken des Broadcasters, Scope `channel:manage:broadcast`
- Die Nutzer-ID im Token muss `broadcaster_id` entsprechen
- Kategorie als `game_id`, **nicht** als Name
- Titel nicht leer, höchstens 140 Zeichen
- Nur die Felder senden, die sich ändern sollen
- Erfolg ist HTTP 204 ohne Inhalt

**Wer auslöst und wer ausführt, sind zwei verschiedene Personen.** Ein
`manager` oder `operator` darf die Aktion im Panel auslösen, wenn unsere
eigene Rollenprüfung ([0006](0006-rollenschwellen.md)) es erlaubt; ausgeführt
wird sie mit der Zustimmung des Broadcasters. Das Ereignisprotokoll hält
deshalb **beide** fest — die auslösende Person und den Kanal. Der Broadcaster
bestätigt nicht jede einzelne Änderung.

Sein Token wird **niemals** an Panel-Nutzer, Overlays oder den Browser
ausgeliefert. Das gilt ohne Ausnahme und unabhängig von der Rolle.

## 4. Unterschiede im Verhalten

### Bot-Abzeichen

> „For a chatbot to display the Chat Bot Badge when sending a message, it must
> meet the following requirements: A message sent by the chatbot must use the
> Send Chat Message API. **A message sent by the chatbot must use an App Access
> Token.** […] Due to these requirements, chatbots that utilize User Access
> Tokens will not appear in chat with the Chat Bot Badge."

Dazu braucht der Bot `channel:bot` vom Broadcaster oder Moderatorstatus, und er
darf nicht selbst der Broadcaster sein. Beides ist erfüllt.

Das Gegenstück in der Zuschauerliste — Einordnung unter **Chat Bots** — hängt am
`channel.chat.message`-Abo mit App-Token. Das erfüllen wir bereits, weil
Webhook nichts anderes zulässt.

### Shared Chat

- Nutzertoken: Nachricht geht an **alle** Kanäle der Sitzung, nicht änderbar
- App-Token: standardmäßig nur an den Quellkanal
- `for_source_only: false` stellt das alte Verhalten her — **nur** mit
  App-Token setzbar; mit Nutzertoken antwortet Twitch mit 400

Wir setzen `for_source_only: false` ausdrücklich, damit die Umstellung das
Verhalten nicht still ändert.

### Ratenbegrenzung

> „Your app is given **a bucket for app access requests and a bucket for user
> access requests**. For requests that specify a user access token, the limits
> are applied per client ID per user per minute."

Zwei getrennte Töpfe. Heute zieht der EventSub-Abgleich aus dem App-Topf und
das Chatten aus dem Bot-Topf; nach der Umstellung teilen sie sich einen.

**Bekannter Punkt, heute folgenlos.** Bei wenigen Kanälen spielt es keine
Rolle. Wird es eng, ist die Antwort Staffelung des stündlichen Abgleichs, nicht
ein Rückzug auf das Nutzertoken — das Abzeichen bekommt man nicht anders.

Das Senden selbst ist davon unabhängig gedeckelt: **20 Nachrichten je 30
Sekunden je Bot-Konto**, unabhängig von der Token-Art. Ein App-Token hebt diese
Grenzen nicht auf.

## 5. Lebenszyklus — und die Lücke, die dabei auffiel

- **App-Token:** über Client-ID und Secret neu anfordern, kein Nutzer beteiligt
- **Nutzertoken:** über das Refresh-Token erneuern
- Ein **abgelaufenes Token** ist kein widerrufener Zugriff. Beides muss
  getrennt behandelt werden
- Ein **neuer Scope** braucht eine neue Zustimmung des Kontos
- Ein **widerrufener Zugriff** braucht eine vollständig neue Autorisierung

Für Funktionen der Kategorie 1 muss das ursprüngliche Nutzertoken nicht als
Arbeitsmittel gepflegt werden — es ist dort nur noch **Nachweis**, dass die
Zustimmung lebt. Für Kategorie 2 und 3 bleibt es Arbeitsmittel.

**Offener Mangel:** Broadcaster-Token werden heute nur aufgefrischt, solange
eine aktive Sitzung besteht (`listLoginIdentities`). Für Kategorie 3 ist das zu
wenig — die Funktion scheitert still bei jedem Broadcaster, der gerade nicht im
Panel ist. Festgehalten in [#150](https://github.com/smb-org/BroBot/issues/150);
zu beheben, **bevor** der erste Aufruf dieser Kategorie entsteht.

## 6. Regeln für neue Aufrufe

- **Die Token-Art wird je Endpunkt an der Referenz nachgelesen**, nicht aus
  einem Nachbaraufruf übernommen. Die Zeile „Requires…" ist die Quelle.
- Zustimmung und Kanalrolle werden **getrennt** geprüft. Ein Scope ist keine
  Rolle.
- Vor einem Aufruf der Kategorie 2 oder 3 wird `token_scopes_json`
  ([#116](https://github.com/smb-org/BroBot/issues/116)) geprüft, damit ein
  fehlender Scope ein sichtbarer Zustand ist und kein 401 im Betrieb.
- Bei 401 höchstens **einmal** kontrolliert erneuern und wiederholen. Fehlende
  Rechte werden nicht durch Token-Wechsel in einer Schleife behandelt.
- Panel-Aktionen werden serverseitig autorisiert und protokolliert.
- Keine Tokens und kein Client-Secret an Browser oder Overlay.

## 7. Was sich dadurch ändert

`chat.ts` und `shoutout.ts` stellen auf das App-Token um. Die Umstellung ist
für Zuschauer sichtbar — der Bot bekommt sein Abzeichen —, ändert am
Nachrichteninhalt aber nichts.

Die Grundlage dieser Entscheidung ist die API-Referenz vom 21. September 2026,
Abschnitt für Abschnitt ausgewertet, nicht aus dem Gedächtnis. Ändert Twitch
eine Zeile, ändert sich die Zuordnung — deshalb steht in Abschnitt 6 an erster
Stelle, dass nachgelesen und nicht übernommen wird.
