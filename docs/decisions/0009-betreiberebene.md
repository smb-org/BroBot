# Betreiberebene über den Kanälen

**Stand:** 20. September 2026
**Status:** entschieden
**Betrifft:** Auth, Panel, Zustimmungsstrecke, Mitgliederverwaltung
**Beitrag zu:** [#17](https://github.com/smb-org/BroBot/issues/17), umgesetzt in
[#115](https://github.com/smb-org/BroBot/issues/115)

## Kurzfazit

Über den Kanälen steht eine **Betreiberebene**. Sie erkennt sich an einer
Allowlist von Twitch-User-IDs in einem Cloudflare-Secret, nicht an einem
zweiten Anmeldemittel. Sie darf drei Dinge: einen Kanal freigeben, ihn zur
**Vollzustimmung** markieren und `verwalter` oder `bediener` zuweisen. Für
alles Weitere macht sich der Betreiber sichtbar zum `verwalter` des Kanals.

Ein markierter Kanal erteilt beim ersten Anmelden **alle** Broadcaster-Scopes
auf einmal. Wer den Dialog abbricht, bekommt keine Sitzung.

## 1. Warum überhaupt

Die Zustimmungsstrecke lädt Berechtigungen bedarfsweise nach: Ein Modul
deklariert seine Scopes, das Panel fordert sie an, wenn das Modul eingeschaltet
wird. Das ist sparsam und entspricht [0002](0002-twitch-scopes-und-token-handling.md).

In der Praxis trägt es nicht. Ein Streamer ist einmal erreichbar — beim
Einrichten. Danach ist jede Nachforderung ein Telefonat, das nicht stattfindet.
Die Folge ist kein Sicherheitsgewinn, sondern ein Modul, das dauerhaft aus
bleibt, und ein Betreiber, der den Grund erklären muss.

**Die Betreiberebene existiert bereits.** Sie heißt `wrangler d1 execute`, und
[OPERATIONS.md](../OPERATIONS.md) beschreibt sie als Schritt 5: Kanalzeile und
Broadcaster-Mitgliedschaft von Hand anlegen. Wer das Cloudflare-Konto besitzt,
kann heute schon alles. Diese Entscheidung schafft also keine neue Macht. Sie
gibt der vorhandenen eine Oberfläche, die protokolliert, was sie tut, und die
Tippfehler abfängt, die heute stillschweigend drei Stellen brechen.

## 2. Woran ein Betreiber erkannt wird

Ein Secret `BETREIBER_USER_IDS` enthält ein JSON-Array von Twitch-User-IDs.
Wer sich regulär über Twitch anmeldet und dessen ID darin steht, ist Betreiber.
Es gibt kein zweites Passwort und kein Bearer-Token.

**Der Grund ist die Reichweite der Anwendung.** Eine Tabelle `betreiber` in D1
wäre bequemer und joinbar — aber die Anwendung könnte sie beschreiben. Ein
einzelner Schreibfehler an irgendeiner Stelle wäre dann Totalkompromittierung.
Das Secret liegt außerhalb: Kein Pfad im Worker kann einen Betreiber
hinzufügen, nur `wrangler secret put`.

Ein eigenes Geheimnis wäre die schlechteste Wahl. Es brächte eine zweite
Anmeldestrecke ohne CSRF-Schutz, ohne Sitzungswiderruf und ohne die stündliche
Token-Prüfung — und weil es geteilt wäre, wüsste das Audit nie, **wer**
gehandelt hat. Die bestehende OAuth-Strecke mitzubenutzen verkleinert die
Angriffsfläche, statt sie zu vergrößern.

Das Secret ist pflichtig, ein leeres Array `[]` ist gültig. Pflichtig deshalb,
weil ein vergessenes Secret sonst stillschweigend „kein Betreiber" ergäbe statt
einer Meldung auf `/healthz`.

Widerruf: ID entfernen, greift ab dem nächsten Request; zusätzlich die
Sitzungen des Kontos widerrufen. Betreiberkonten führen Twitch-2FA. Das kann
die Anwendung nicht erzwingen, deshalb steht es im Betriebshandbuch.

## 3. Kein Durchgriff auf Kanaldaten

`requireChannelAuthorization` bleibt **unverändert**. Der Betreiber hat keine
Mitgliedszeile, also antworten ihm alle Routen unter
`/api/channels/:channelId/…` weiterhin mit 403. Es gibt kein
`if (istBetreiber) return next()` — das wäre genau die Hintertür, die diese
Entscheidung vermeiden will.

Stattdessen ein eigener, schmaler Router `/api/betreiber/*` hinter einem
eigenen Guard. Er bietet ausschließlich die Handlungen aus Abschnitt 4 und
mountet keine Modulrouten.

**Will der Betreiber mehr, wird er Mitglied.** Er weist sich selbst `verwalter`
zu — eine protokollierte Handlung, die in der Mitgliederliste steht und die der
Broadcaster jederzeit rückgängig machen kann. Die Anwesenheit eines Betreibers
in einem fremden Kanal ist damit **immer eine sichtbare Zeile**, nie ein
unsichtbarer Durchgang.

## 4. Was der Betreiber darf

| Handlung | Grenze |
|---|---|
| Kanal freigeben | Die Broadcaster-Zeile wird aus der Kanal-ID abgeleitet, nie frei gewählt |
| Vollzustimmung setzen oder lösen | — |
| `verwalter`/`bediener` hinzufügen, ändern, entfernen | Die Zielrolle `broadcaster` ist ausgeschlossen, auch im SQL |
| Kanalübergreifende Übersicht lesen | — |
| Betreiberhandlungen aller Kanäle lesen | Das Werkzeug für den Schadensfall |

Die Rolle `broadcaster` fasst der Betreiber **nie** an. Damit bleibt die Regel
„nur ein Broadcaster vergibt Broadcaster" unberührt. Die einzige Stelle, an der
eine Broadcaster-Zeile durch ihn entsteht, ist die Kanalfreigabe — und dort ist
die Person durch die Kanal-ID bestimmt, nicht wählbar.

Nicht dabei: Module schalten, Overlay-Token, Moduleinstellungen.

## 5. Sichtbar für den Broadcaster

`audit_log` bekommt eine Spalte `actor_kind` (`mitglied` oder `betreiber`).
Jede Betreiberhandlung schreibt in den `audit_log` **des betroffenen Kanals**,
mit der echten Twitch-ID des Betreibers.

Der Broadcaster muss sehen können, dass jemand von außen seine Mitgliederliste
geändert hat, und wer. Nach [0006](0006-rollenschwellen.md) lesen alle drei
Rollen das Audit; das Abzeichen „Betreiber" steht neben dem Akteur.

## 6. Vollzustimmung: Merker und Zwang

**Der Merker ist eine Spalte an `channels`.** Der scheinbare Widerspruch —
markieren, bevor der Kanal existiert — löst sich auf: `channel_id` ist die
Twitch-User-ID des Broadcasters und über Helix bekannt, lange bevor er sich je
angemeldet hat. Die Freigabe legt die Zeile an und setzt den Merker in einem
Schritt. Eine eigene Tabelle hätte nur eine zweite Wahrheit geschaffen.

**Die Liste ist abgeleitet, nicht gespeichert:** die Vereinigung der
Login-Scopes mit den Broadcaster-Scopes aller registrierten Module. Kommt
später ein Modul mit einem neuen Scope hinzu, gilt ein markierter Kanal
automatisch als unvollständig und wird beim nächsten Anmelden nachgezogen. Die
Betreiberübersicht zeigt das, bevor es jemand merkt.

Der Zwang wirkt zweistufig:

1. **Der Einladungslink wählt den Dialog.** `/auth/login?kanal=<login>` startet
   für markierte Kanäle mit der vollen Liste. Der Parameter trifft keine
   Berechtigungsentscheidung — er wählt nur, welcher Dialog erscheint; die
   Liste kommt vom Server.
2. **Der Callback erzwingt das Ergebnis.** Fehlt im zurückgegebenen **Token**
   ein Scope der vollen Liste, wird nichts gespeichert und keine Sitzung
   angelegt; stattdessen läuft sofort eine zweite Autorisierung mit voller
   Liste. Kommt auch die unvollständig zurück, endet der Vorgang mit klarem
   Fehler statt in einer Schleife.

Geprüft wird das **Token**, nicht die gespeicherte Scope-Liste. Die ist derzeit
nicht verlässlich — siehe [#116](https://github.com/smb-org/BroBot/issues/116).

Twitch zeigt den Dialog nur für noch nicht erteilte Scopes. Für einen
Broadcaster, der bereits alles erteilt hat, bleibt die Prüfung unsichtbar.

**Wer abbricht, kommt nicht ins Panel.** Das ist gewollt: Der Anruf kommt dann
sofort, statt nie.

## 7. Der Vollumfang

Twitchs Zustimmung ist **ganz oder gar nicht** — ein Streamer kann in einem
Dialog keine Teilmenge abwählen. „Vollzustimmung erzwingen" heißt deshalb
technisch nur: die vollständige Liste in die Authorize-URL schreiben.

Zwölf Broadcaster-Scopes, alle am 20. September 2026 gegen die rohe
Scope-Referenz von Twitch geprüft:

| Scope | Wofür |
|---|---|
| `channel:read:ads` | Werbeplan lesen (#22) |
| `channel:manage:ads` | Werbung starten und verschieben (#22) |
| `channel:manage:polls` | Umfragen (#8) |
| `channel:manage:predictions` | Predictions (#8) |
| `channel:read:redemptions` | Einlösungen von Kanalpunkten lesen (#21) |
| `channel:manage:redemptions` | Belohnungen anlegen und einlösen (#21) |
| `channel:read:goals` | Creator-Goals für das Overlay (#7) |
| `channel:manage:broadcast` | Titel, Kategorie, Stream-Marker (#11) |
| `channel:read:vips` | VIP-Liste lesen |
| `channel:manage:vips` | VIP-Rolle vergeben |
| `channel:manage:raids` | Raid im Namen des Kanals starten |
| `channel:manage:schedule` | Sendeplan pflegen |

**Bei Umfragen und Predictions gibt es keinen Leseweg.** Schon das Beobachten
per EventSub verlangt den `manage`-Scope; die `read`-Varianten taugen nur für
Helix-Abfragen. Wer #8 baut, hält die Schreibrechte zwangsläufig.

Der Preis ist zu benennen: Ein gestohlenes Broadcaster-Token kann Titel und
Kategorie des Kanals öffentlich verfälschen, einen Raid auf einen beliebigen
Kanal auslösen, Werbung erzwingen, Umfragen und Predictions im Namen des
Streamers starten und deren Auszahlung fehlleiten sowie die Kanalpunkte-
Ökonomie verändern. Kein Zugriff auf Geld, Abonnements, Bits, Spenderdaten,
E-Mail-Adressen oder private Nachrichten.

**Bewusst ausgeschlossen, dauerhaft:** `channel:read:stream_key` (erlaubt, unter
dem Namen des Kanals zu senden), `channel:manage:videos` (löscht VODs
unwiderruflich), `channel:manage:moderators` (ein gestohlenes Token könnte sich
selbst dauerhaft Zugriff verschaffen), `channel:read:subscriptions`,
`bits:read`, `channel:read:charity`, `user:read:email`, die Blocklisten- und
Whisper-Scopes sowie die Legacy-IRC-Scopes. Die Grenze verläuft bei Geld,
personenbezogenen Daten Dritter und Selbstermächtigung.

## 8. Was offen bleibt

Cloudflare Access als Pfad-Regel vor der Betreiberoberfläche wäre ein echter
zweiter Faktor gegen ein übernommenes Twitch-Konto. Gegen einen Angriff im
selben Ursprung hilft es nicht. Es lohnt ab der zweiten Betreiberperson; bis
dahin trägt die 2FA-Pflicht aus Abschnitt 2.
