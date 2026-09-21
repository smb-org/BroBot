# Werbe-Vorwarnung: Zeitplan holen, Wecker stellen

**Stand:** 21. September 2026
**Status:** entschieden
**Betrifft:** Modul `werbung`, `ChannelObject`, EventSub-Abos, App-Token
**Beitrag zu:** [#22](https://github.com/smb-org/BroBot/issues/22)

## Kurzfazit

Die Ansage bei Werbebeginn steht seit dem ersten Wurf des Moduls. Offen ist die
**Vorwarnung** — „gleich Werbung" *bevor* sie läuft. Dafür gibt es kein
Ereignis; Twitch nennt den nächsten Termin nur auf Nachfrage über **Get Ad
Schedule**.

Drei Festlegungen:

1. **Der Zeitplan wird nicht im Takt abgefragt, sondern bei Anlässen.** Twitch
   erlaubt einen Aufruf je Minute und Kanal; ein Minutentakt wäre also
   dauerhaft am Anschlag und läge trotzdem bis zu 59 Sekunden daneben.
2. **Der Wecker steht im `ChannelObject`.** Aus `next_ad_at` minus Vorlaufzeit
   wird ein Alarm. Sekundengenau, ohne zusätzlichen Cron-Auslöser.
3. **Der Aufruf läuft mit dem App-Token, nicht mit dem Broadcaster-Token.**
   Das ist der wichtigste Befund dieser Entscheidung und steht in Abschnitt 2.

## 1. Warum es kein Ereignis gibt

`channel.ad_break.begin` feuert, wenn die Werbung **läuft**. Für Zuschauer ist
das zu spät: Die Ansage erscheint, während der Bruch schon da ist. Ein
`channel.ad_break.end` gibt es nicht, ein Vorwarnereignis ebenso wenig. Das ist
in #22 belegt und wird hier nicht erneut geprüft.

Die einzige Quelle für den nächsten Termin ist Get Ad Schedule mit
`next_ad_at`, `duration`, `snooze_count`, `snooze_refresh_at`,
`preroll_free_time` und `last_ad_at`. `next_ad_at` ist **leer**, wenn kein
Termin ansteht oder der Kanal nicht sendet — der Normalfall außerhalb des
Streams, kein Fehler.

## 2. Der Aufruf braucht kein Broadcaster-Token

Twitch erlaubt für Get Ad Schedule ausdrücklich zwei Wege (geprüft an der
API-Referenz, nicht aus dem Gedächtnis):

> A user access token that includes the `channel:read:ads` scope. […]
> **An app access token where the application, through a prior authorization,
> has the `channel:read:ads` scope for the user** represented by the
> `broadcaster_id` query parameter.

Für Snooze Next Ad gilt derselbe Satz mit `channel:manage:ads`.

Das ist dieselbe Bauart wie bei EventSub: **erfüllt sein muss die erteilte
Zustimmung, nicht ein Token für eigene Aufrufe.** Damit gilt für die
Werbe-Vorwarnung, was [0002](0002-twitch-scopes-und-token-handling.md) schon
für die Abos festhält — die gespeicherte, vereinigte Scope-Liste des
Broadcasters ist die richtige Grundlage, und der Bot muss für diesen Aufruf
kein fremdes Nutzertoken auspacken, entschlüsseln oder erneuern.

**Folge für [#116](https://github.com/smb-org/BroBot/issues/116):** Die
Vorwarnung ist **nicht** der erste Fall, in dem es darauf ankommt, welche
Scopes das gespeicherte Token trägt. #116 bleibt richtig — die Spalte
beantwortet eine zweite, echte Frage —, aber sie ist keine Voraussetzung für
dieses Modul. Der erste echte Nutzer steht noch aus.

**Folge für den Betrieb:** Ein Kanal ohne `channel:read:ads` bekommt keine
Vorwarnung. Das Modul deaktiviert sich dafür sichtbar, wie #22 es verlangt und
wie es die übrigen optionalen Module tun — nicht stillschweigend.

## 3. Drei Anlässe, den Zeitplan zu holen

Nicht im Takt, sondern wenn sich etwas geändert haben kann:

| Anlass | Warum |
|---|---|
| `stream.online` | Vor dem Stream gibt es keinen Termin. Ohne diesen Anlass hätte die **erste** Werbung des Streams nie eine Vorwarnung. |
| `channel.ad_break.begin` | Nach einer Pause steht die nächste fest. Der Anlass, der den Takt am Laufen hält. |
| Panel öffnet die Modulansicht | Zeigt dem Broadcaster den aktuellen Stand und setzt nebenbei den Wecker neu. |

`stream.online` wird heute **nicht** abonniert. Das Abo kommt mit diesem Modul
dazu; es braucht keinen Scope, seine Bedingung ist allein
`broadcaster_user_id`.

Ein Anlass löst **einen** Aufruf aus. Die Minutengrenze wird dadurch nie
erreicht, außer ein Kanal startet den Stream mehrfach je Minute — dann fällt
ein Aufruf aus und der nächste Anlass holt ihn nach. Ein 429 ist ein normaler
Ausgang und wird als solcher protokolliert, nicht als Fehler behandelt.

## 4. Ein Objekt, ein Wecker, zwei Fristen

Ein Durable Object hat **genau einen** Alarm. Das `ChannelObject` benutzt ihn
heute für die Sicherheitsrunde alle fünfzehn Minuten
([0010](0010-realtime-strecke.md) Abschnitt 7) und löscht ihn, sobald kein
Socket mehr offen ist.

Die Vorwarnung kommt als **zweite Frist** dazu. Damit gilt ab jetzt:

- Fristen liegen in `ctx.storage`, nicht in Klassenfeldern — die
  Hibernation-Invariante aus 0010 Abschnitt 6 bleibt unangetastet.
- Der Alarm steht immer auf der **frühesten fälligen Frist**.
- `alarm()` arbeitet **jede** fällige Frist ab und stellt den Wecker danach auf
  die nächste noch offene.
- Der Wecker wird nur gelöscht, wenn **keine** Frist mehr offen ist. Die
  bisherige Regel „kein Socket, kein Wecker" gilt damit nur noch für die
  Sicherheitsrunde. Eine Vorwarnung darf nicht daran hängen, ob gerade jemand
  das Panel offen hat — der Normalfall ist, dass niemand es offen hat.

Das ist die einzige Stelle, an der dieses Modul das Realtime-Objekt verändert.
Die Sicherheitsrunde behält ihre eigene Frist und ihr eigenes Verhalten; sie
wird nicht mit der Vorwarnung verrechnet.

## 5. Was die Vorwarnung ansagt und wann nicht

Die Vorlaufzeit ist eine Einstellung, kein fester Wert; sinnvolle Werte liegen
zwischen 30 und 300 Sekunden. Der Text ist wie die übrigen Texte des Moduls
eine Einstellung mit Platzhaltern.

Nicht angesagt wird:

- wenn `next_ad_at` leer ist — kein Termin, kein Stream
- wenn der Termin näher liegt als die Vorlaufzeit; eine Vorwarnung „in 3
  Sekunden Werbung" ist keine
- wenn zwischen Wecker und Fälligkeit eine Werbepause begonnen hat; dann ist
  der Termin verbraucht und die Ansage bei Beginn hat ihn schon abgedeckt
- wenn der Broadcaster in der Zwischenzeit gesnoozt hat; Snooze verschiebt um
  fünf Minuten, und der Zeitplan wird nach jedem Snooze neu geholt

Jeder dieser Fälle bekommt einen eigenen Diagnosecode. Eine ausgebliebene
Vorwarnung muss im Ereignisprotokoll erklärbar sein, sonst ist sie ein
Gerücht — dieselbe Begründung wie in [0004](0004-ereignisprotokoll.md) für den
unterdrückten Shoutout.

## 6. Snooze im Panel

Snooze Next Ad verschiebt die nächste automatische Werbung um fünf Minuten und
braucht `channel:manage:ads` — laut #22 und 0002 **optional**. Ist der Scope
nicht erteilt, ist der Knopf sichtbar und deaktiviert mit Begründung, nach der
Regel aus [0006](0006-rollenschwellen.md).

`snooze_count` und `snooze_refresh_at` stehen in derselben Antwort wie der
Termin. Das Panel zeigt beide; ein Knopf, der nur beim Drücken verrät, dass
kein Snooze mehr übrig ist, ist eine Falle.

Die Rollenschwelle: Snooze **wirkt im Stream** und ist damit eine Bedienung,
keine Konfiguration — `bediener` darf sie auslösen, wie er auch ein Modul ein-
und ausschalten darf. Die Vorlaufzeit und die Texte zu ändern, bleibt
`verwalter` und `broadcaster` vorbehalten.

## 7. Was nicht sicher ist

- **Der Termin ist eine Vorhersage, keine Zusage.** Twitch kann früher,
  später oder gar nicht ausspielen. Die Vorwarnung sagt deshalb „gleich", nicht
  „in genau 60 Sekunden".
- **Zwischen Ereignis und dem, was Zuschauer sehen, liegt ein Versatz.** Das
  gilt für die Vorwarnung wie für die Ansage bei Beginn und ist in #22 und #3
  festgehalten.
- **Ein manuell gestarteter Werbeblock hat keine Vorwarnung.** Er entsteht
  nicht aus dem Zeitplan. Wer ihn selbst startet, weiß Bescheid.
- **Ein Kanal, der die Zustimmung bei Twitch entzieht, bleibt bis zum
  nächsten Wartungslauf im Zeitplan.** Danach ist die Scope-Liste leer und das
  Modul deaktiviert sich. Dasselbe Restfenster wie bei den EventSub-Abos.
