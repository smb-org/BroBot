# Moderationsereignisse lesen, nicht moderieren

**Stand:** 20. September 2026
**Status:** entschieden
**Betrifft:** Bot-Token, EventSub, Modul `kanalereignisse`
**Löst ab:** den Absatz „Bewusst nicht: die gesamte Moderationsfläche" aus
[0002](0002-twitch-scopes-und-token-handling.md)

## Kurzfazit

Bans, Timeouts, Unbans, gelöschte Nachrichten und Warnungen gehören ins
Kanalprotokoll. Sie kommen über **`channel.moderate` Version 2 am Bot-Token** —
nicht über `channel.ban` am Broadcaster-Token. Wo die Abo-Bedingung `read ODER
manage` zulässt, wird **`manage`** geholt: dieselbe Zeile, kein zusätzlicher
Scope, aber die Handlungsfähigkeit für später.

Der Bot **liest** diese Ereignisse. Er moderiert nicht. Dass er es könnte, ist
eine bewusste Folge und wird unten benannt, nicht verschwiegen.

## 1. Warum nicht `channel.ban`

Der naheliegende Weg wäre `channel.ban` und `channel.unban`. Beide verlangen
`channel:moderate` — einen **Broadcaster**-Scope. Das setzt ein
Broadcaster-Token voraus, das es im Code nicht gibt: `OAuthPurpose` kennt
`login` und `bot`. Die Spalte `broadcaster_connection` existiert, aber kein
OAuth-Weg füllt sie mit einem Token samt Scopes.

0002 beschreibt diese dritte Strecke bereits als Absicht („Broadcaster —
optional je Kanal, erst wenn gebraucht"). Gebaut ist sie nicht. Sie für das
Kanalprotokoll zu bauen hieße: Token-Art, Speicherung, Erneuerung, ein
Zustimmungsdialog je Kanal und ein sichtbarer Sperrzustand je Modul — bevor die
erste Zeile Protokoll entsteht.

Dazu kommt ein fachlicher Nachteil: `channel.ban` „sends a notification when a
viewer is **timed out or banned**". Ein Ereignis für beides; Timeout und Bann
wären nur über `ends_at` zu unterscheiden.

## 2. Warum `channel.moderate` stattdessen geht

Die Bedingung von `channel.moderate` ist `broadcaster_user_id` **und**
`moderator_user_id`, und die verlangten Scopes sind ausschließlich
Moderator-Scopes. Die Twitch-Dokumentation sagt für diese Familie: „the user in
`moderator_user_id` must have granted your app (client ID) one of the above
permissions."

Die Zustimmung erteilt also **der Moderator**, nicht der Broadcaster. Der Bot
ist Moderator im Kanal — sein Status wird ohnehin geprüft und im Panel
angezeigt. Die Scopes hängen damit am Bot-Token, wo 0002 ausdrücklich großzügig
sein will („beim Bot großzügig"), statt am teuersten der drei Token.

Obendrein ist es genauer: `channel.moderate` trennt `ban`, `timeout`,
`untimeout`, `unban`, `delete` und — in Version 2 — `warn` als eigene Aktionen
mit eigenen Nutzdaten.

**Version 2**, nicht 1: der Unterschied ist ein Scope (`moderator:*:warnings`)
gegen die Warnungen, und Version 1 wird von Twitch als überholt geführt, sobald
Version 2 steht.

## 3. Was das kostet

`channel.moderate` ist **alles oder nichts**. Eine Teilmenge abonniert nicht;
Twitch verlangt jede Zeile der Bedingung. Das sind acht Scopes, von denen nur
zwei nach „Bann" klingen:

| Scope | Variante | Warum diese Variante |
|---|---|---|
| `moderator:manage:banned_users` | manage | erfüllt die Bedingung und erlaubt später Bannen, Timeouten, Entbannen |
| `moderator:manage:warnings` | manage | erfüllt die Bedingung und erlaubt später Verwarnen |
| `moderator:manage:blocked_terms` | manage | erfüllt die Bedingung, keine Mehrkosten |
| `moderator:manage:chat_settings` | manage | erfüllt die Bedingung, keine Mehrkosten |
| `moderator:manage:unban_requests` | manage | erfüllt die Bedingung, keine Mehrkosten |
| `moderator:manage:chat_messages` | manage | war bereits vorhanden |
| `moderator:read:moderators` | read | die Bedingung lässt hier kein `manage` zu |
| `moderator:read:vips` | read | die Bedingung lässt hier kein `manage` zu |

Die Lesefläche ist damit deutlich größer, als „Bans protokollieren" vermuten
lässt: gesperrte Begriffe, Chat-Einstellungen, Entsperranträge, gelöschte
Nachrichten, Moderatoren- und VIP-Listen.

`moderator:read:moderators` und `moderator:read:vips` stehen in der Bedingung
ohne Oder. Ihre `manage`-Gegenstücke sind Broadcaster-Scopes und kämen nur mit
der Strecke, die diese Entscheidung gerade vermeidet.

## 4. Warum `manage` vor dem ersten Nutzer

Wo die Bedingung `read ODER manage` zulässt, kostet `manage` **nichts
zusätzlich**: dieselbe Zeile, derselbe Dialog, dieselbe Zahl an Scopes.

Der Unterschied fällt später an. Das Bot-Token wird vom Bot-Konto autorisiert.
Kommt ein Scope nach, muss dieses Konto die Anwendung erneut autorisieren — und
bis dahin scheitern die Abos. Die Fähigkeit jetzt zu holen erspart genau diese
zweite Hürde, wenn ein Modul erstmals moderieren soll.

Der Preis ist ehrlich zu benennen: **ein gestohlenes Bot-Token kann bannen,
timeouten, entbannen, verwarnen, gesperrte Begriffe und Chat-Einstellungen
ändern** — in jedem Kanal, in dem der Bot Moderator ist. Vorher konnte es
Nachrichten löschen und Shoutouts senden. Der Schaden wächst von „ärgerlich" auf
„sichtbar für die Zuschauerschaft".

Das ist vertretbar, weil das Token verschlüsselt liegt (siehe
[0003](0003-hash-und-salt-modell.md)), sein Zustand überwacht wird und der
Bot in fremden Kanälen ohne Moderatorrolle ohnehin nichts ausrichtet. Es ist
aber der Grund, warum diese Entscheidung geschrieben steht statt nebenbei zu
passieren.

## 5. Abgrenzung zu #5

[#5](https://github.com/smb-org/BroBot/issues/5) hält fest, dass Moderation
beim vorhandenen Bot bleibt. Das gilt weiter: **kein Modul in diesem Projekt
löst eine Moderationsaktion aus.** Das Modul `kanalereignisse` gibt bei jeder
Ereignisart eine leere Aktionsliste zurück; ein Test sichert das ab.

Was sich verschiebt, ist die Lesefläche — und die Fähigkeit im Token. Soll ein
Modul später tatsächlich moderieren, ist das eine neue Entscheidung mit einer
neuen Begründung, nicht eine Selbstverständlichkeit, die aus dieser hier folgt.

## 6. Was das für den Betrieb heißt

- Das Bot-Konto muss die Anwendung **einmal neu autorisieren**, nachdem die
  Scopes ergänzt wurden. Ein manueller Schritt.
- Bis dahin scheitert das Anlegen der Abos. Der Grund steht als Zustand im
  Panel; das Modul deaktiviert sich sichtbar. Kein stiller Ausfall.
- Verliert der Bot die Moderatorrolle in einem Kanal, wird das Abo dort
  ungültig. Auch das ist ein erkennbarer Zustand, kein Schweigen.
- Der stündliche Abgleich bleibt das Sicherheitsnetz; das sofortige Anlegen beim
  Einschalten aus [#75](https://github.com/smb-org/BroBot/issues/75) gilt
  unverändert.
