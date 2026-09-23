# Rollenschwellen je Handlung

**Stand:** 19. September 2026
**Status:** entschieden
**Betrifft:** Autorisierung, Panel, Module

## Kurzfazit

Es gibt drei Rollen — `broadcaster`, `manager`, `operator` — und drei
Schwellen. Welche Handlung welche Schwelle hat, steht hier und nicht nur im
Code. Berechtigt ist ausschließlich, wer eine Zeile in `channel_members` hat;
die Twitch-Rolle spielt dabei keine Rolle.

## 1. Die drei Schwellen

| Schwelle | Wer | Wofür |
|---|---|---|
| **Nur Broadcaster** | `broadcaster` | Die Rolle `broadcaster` vergeben oder entziehen |
| **Verwaltend** | `broadcaster`, `manager` | Mitglieder verwalten, Module aktivieren, Moduleinstellungen ändern, Overlay-Token ausstellen und widerrufen |
| **Betrieblich** | alle drei | Alles Lesende: Kanalübersicht, Mitgliederliste, Ereignisprotokoll, Modulliste |

## 2. Warum Modulaktivierung verwaltend ist und nicht betrieblich

Ein Modul einzuschalten verändert, was der Bot im Chat tut — sichtbar für jeden
Zuschauer und unter dem Namen des Kanals. Das ist keine Betriebshandlung wie
das Nachsehen, warum ein Shoutout ausblieb, sondern eine Festlegung darüber,
wie der Kanal nach außen auftritt.

Ein `operator` betreut den Stream; er soll sehen, was passiert, und im
Ereignisprotokoll nachvollziehen können, warum etwas nicht passiert ist. Er
soll nicht ohne Rücksprache ein Modul scharf schalten, das anschließend im
Chat schreibt.

### Einzelne Befehle innerhalb eines aktiven Moduls

Ein einzelner Befehl innerhalb eines bereits aktiven Moduls ist davon zu
unterscheiden: Er wurde von jemandem angelegt, der dazu berechtigt war. Ihn
stillzulegen nimmt nichts weg und schafft nichts Neues. Deshalb darf ein
`operator` einen solchen Befehl im laufenden Betrieb ein- oder ausschalten;
Anlegen, Ändern und Löschen bleiben verwaltende Inhaltsänderungen.

## 3. Warum Lesen für alle offen ist

Das Ereignisprotokoll aus Entscheidung 0004 ist Betriebsinformation, und genau
die Leute, die den Stream betreuen, brauchen sie. Dasselbe gilt für die
Modulliste: Wer sehen soll, warum ein Befehl nicht reagiert hat, muss sehen
dürfen, ob das Modul überhaupt aktiv ist. Ein Leserecht, das an der Rolle
scheitert, erzeugt genau die stille Ratlosigkeit, gegen die 0004 antritt.

## 4. Die Schwelle steht in der Mutation, nicht nur im Handler

Jede mutierende Anweisung trägt `actorGuard(...)` als Teil ihres SQL. Die
Prüfung im Handler bleibt zusätzlich bestehen, damit der Aufrufer eine
verständliche Antwort bekommt — aber sie ist nicht die Absicherung.

Der Grund ist ein Wettlauf: Zwischen der Prüfung im Handler und der Ausführung
der Anweisung kann sich die Rolle des Akteurs ändern. Steht die Schwelle nur
im Handler, gewinnt die veraltete Prüfung. Steht sie in derselben Anweisung,
die schreibt, kann sie das nicht.

Aus demselben Grund prüft der Guard nicht nur die Rolle, sondern auch, dass die
Sitzung gültig und nicht widerrufen ist, dass die Twitch-Identität nicht
widerrufen wurde und dass die Mitgliedschaft zu **diesem** Kanal gehört.

## 5. Berechtigung hängt an `channel_members`, nicht an Twitch

Wer bei Twitch Moderator ist, hat in BroBot deswegen keine Rechte. Ein Kanal
wird ausschließlich über eine Zeile in `channels` freigegeben, Zugriff
ausschließlich über `channel_members`.

Das ist eine bewusste Abweichung von dem, was Nutzer erwarten. Der Grund: Die
Twitch-Moderatorenliste ändert sich außerhalb unserer Sichtweite und aus
Gründen, die mit BroBot nichts zu tun haben. Eine Berechtigung, die sich
ändert, ohne dass jemand sie hier geändert hat, lässt sich nicht auditieren —
und das Audit ist nach Entscheidung 0003 rechtlich relevant.

## 6. Der letzte Broadcaster bleibt

Ein Kanal ohne `broadcaster` wäre nicht mehr verwaltbar. Deshalb lässt sich die
letzte Zeile mit dieser Rolle weder entziehen noch löschen; die Bedingung steht
als `soleBroadcasterPredicate` in derselben Anweisung wie die Änderung.

## 7. Darstellung einer Handlung ohne Recht (Nachtrag, 23. September 2026)

Was eine Rolle nicht darf, bleibt sichtbar und nennt seinen Grund. Dafür gibt
es zwei Formen, je nachdem, ob ein einzelnes Bedienelement oder ein ganzes
Formular betroffen ist:

- **Einzelnes Bedienelement** (Schalter, Knopf, Auswahl in einer Tabellenzeile
  oder Zustandszeile): Es steht an seinem Platz, ist deaktiviert und trägt den
  Grund an der Wirkung — als Zeile darunter oder als zugängliche Beschreibung.
- **Ganzes Formular** (Editor eines Befehls, Einstellungen eines Moduls): Es
  wird als lesende Eigenschaftenliste gezeigt, mit genau einer Grundzeile über
  der Liste. Das gilt als „sichtbar mit Grund" im Sinne dieser Entscheidung:
  Jeder Wert ist sichtbar, der Grund steht einmal an der Stelle, an der die
  Bearbeitung beginnen würde. Deaktivierte Formularfelder werden nicht
  gezeigt.

Handlungen, die die Rolle innerhalb eines solchen Formulars ausführen darf
(etwa das Ein- und Ausschalten eines einzelnen Befehls nach Abschnitt 2),
stehen in der lesenden Liste als bedienbares Element. Die Schwelle selbst
ändert sich durch die Darstellung nicht; der Server prüft sie unabhängig
davon nach Abschnitt 4.

## 8. Offen

Ob es unterhalb von `operator` noch eine reine Leserolle braucht, und ob
einzelne Module eigene Schwellen setzen dürfen, ist nicht entschieden. Beides
gehört in den Spike #17. Bis dahin gilt: Ein Modul erbt die Schwellen aus
dieser Entscheidung und definiert keine eigenen.
