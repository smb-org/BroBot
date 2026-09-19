# EventSub-Transport und Chat-Berechtigung

**Stand:** 19. September 2026
**Status:** entschieden
**Betrifft:** Host, Twitch-Anbindung, Auth-Scopes

## Kurzfazit

Twitch-Ereignisse kommen über **Webhook** herein, nicht über
EventSub-WebSocket. Das verlangt ein **App Access Token**, das BroBot bisher
nicht besitzt. Die dritte Bedingung für `channel.chat.message` erfüllen wir
über den Scope **`channel:bot`** vom Broadcaster, nicht über den
Moderatorstatus des Bots.

## 1. Webhook statt WebSocket

Twitch lässt die Wahl nicht offen, sobald die Token-Art feststeht. Wörtlich
aus der EventSub-Dokumentation, Abschnitt „Managing Subscriptions":

> When subscribing to events using webhooks, you must use an app access token.
> The request fails if you use a user access token.

> When subscribing to events using WebSockets, you must use a user access
> token only. The request fails if you use an app access token.

`channel.chat.message` ist über Webhook zulässig; die Dokumentation führt für
diesen Typ ausdrücklich ein Webhook-Beispiel.

Webhook passt zur Plattform. Ein Worker ist zustandslos und lebt nur für die
Dauer einer Anfrage; ein Rückruf über HTTPS ist genau dieses Modell.
`PUBLIC_ORIGIN` und `TWITCH_EVENTSUB_SECRET` sind bereits vorhanden und
werden bisher nicht genutzt.

Der WebSocket-Weg bräuchte eine dauerhaft offene Verbindung und damit ein
Durable Object je Kanal, mit Hibernation, Keepalive, Reconnect-Nachrichten und
Sitzungswechsel. Das ist auf Workers deutlich mehr bewegliche Mechanik, und
die Fachlogik des `ChannelObject` ist noch nicht begonnen. Vor allem aber: Ein
hängender Verbinder fällt ohne eigene Überwachung gar nicht auf — der Kanal
verstummt einfach. Ein ausbleibender Webhook-Aufruf ist demgegenüber an der
Abo-Liste bei Twitch nachweisbar.

**Preis:** Der Client-Credentials-Fluss für ein App Access Token kommt neu
hinzu, samt Zwischenspeicher und Erneuerung. Außerdem müssen Abos je Kanal
selbst angelegt, abgeglichen und aufgeräumt werden, statt dass eine Verbindung
sie implizit hält.

## 2. `channel:bot` statt Moderatorstatus

Für `channel.chat.message` verlangt Twitch:

> Requires `user:read:chat` scope from the chatting user. If app access token
> used, then additionally requires `user:bot` scope from chatting user, and
> either `channel:bot` scope from broadcaster or moderator status.

`user:read:chat` und `user:bot` stehen bereits in `BOT_SCOPES`. Für die dritte
Bedingung gäbe es den Moderatorstatus praktisch geschenkt: `bot_channel_status`
wird stündlich gepflegt, und für Shoutouts und Ansagen muss der Bot ohnehin
Moderator sein.

Wir nehmen trotzdem `channel:bot` in die `LOGIN_SCOPES`. Der Moderatorstatus
ist ein Zustand, den jemand im Twitch-Dashboard nebenbei entfernen kann, ohne
BroBot zu meinen. Dann sterben sämtliche Chat-Abos des Kanals — und zwar
stumm, denn ein nicht eintreffendes Ereignis sieht aus wie ein ruhiger Chat.
Eine ausdrücklich erteilte Berechtigung verschwindet nicht als Nebenwirkung
einer anderen Handlung.

**Preis:** Bestehende Zugänge tragen den Scope nicht und müssen erneut
zustimmen. Das Panel muss fehlende Zustimmung je Kanal erkennen und
nachfordern können; ein Kanal, dem sie fehlt, darf nicht einfach nicht
funktionieren.

## 3. Der Eingang prüft, bevor er liest

Signatur, Zeitstempel und Message-ID werden geprüft, bevor der Nutzkörper
ausgewertet wird. Die Signatur wird zeitkonstant verglichen; Nachrichten älter
als zehn Minuten werden abgelehnt; dieselbe Message-ID führt genau einmal zur
Verarbeitung. Ohne Deduplizierung wäre jede Wiederholung durch Twitch eine
doppelte Modulaktion — bei einem Chatcommand also eine doppelte Nachricht.

## 4. Widerruf ist ein sichtbarer Zustand

Twitch widerruft Abos, wenn eine Berechtigung entzogen wird oder der Rückruf
dauerhaft scheitert. Ein Widerruf hinterlässt einen Eintrag, den das Panel
zeigt. Andernfalls unterscheidet sich ein widerrufenes Abo für den Betreiber
nicht von einem ruhigen Chat — dieselbe stille Abwesenheit, die schon
Entscheidung 0004 als Problem benennt.
