# Mehrsprachigkeit von Panel und Overlay

**Stand:** 19. September 2026
**Status:** entschieden, Umsetzung offen
**Betrifft:** Panel, Overlay, Modul-Contract

## Kurzfazit

Deutsch und Englisch, über einen **getippten Katalog je Ansicht** plus das
native `Intl`. Keine Bibliothek. Das Panel nimmt die Browsersprache, das
Overlay die am Kanal hinterlegte Sprache. Eine fehlende Übersetzung ist ein
**Build-Fehler**, kein Laufzeitverhalten.

Diese Entscheidung wird jetzt getroffen und später umgesetzt. Der Grund steht
in #40: Jedes Modul bringt eine eigene Panel-Ansicht mit. Heute sind es zwei
Ansichten, in einem Jahr womöglich zehn — ab einer bestimmten Zahl kippt die
Rechnung für eine Nachrüstung.

## 1. Getippter Katalog statt Bibliothek

Für zwei Sprachen und rund 67 sichtbare Texte ist eine ausgewachsene
Bibliothek überdimensioniert. `Intl` ist nativ vorhanden und deckt Datum, Zahl
und Pluralregeln ab; Interpolation sind wenige Zeilen.

Entscheidend ist der Nebeneffekt: Ein getippter Katalog lässt TypeScript die
Vollständigkeit erzwingen. Eine Bibliothek prüft Lücken erst zur Laufzeit —
also beim Nutzer.

Der Preis ist ehrlich zu benennen: Bei zehn Sprachen wäre das die falsche
Wahl. Sollte es je so weit kommen, ist der Wechsel zu einer Bibliothek der
Zeitpunkt, diese Entscheidung neu zu treffen.

## 2. Panel folgt dem Browser, Overlay folgt dem Kanal

Das Panel hat einen Nutzer, dessen Browsersprache etwas bedeutet. Das Overlay
hat keinen: Es läuft als Quelle in OBS, und die Spracheinstellung jenes
Rechners hat mit dem Kanal nichts zu tun. Ein deutscher Kanal würde englische
Einblendungen zeigen, weil der Streaming-Rechner englisch eingestellt ist.

Deshalb bezieht das Overlay seine Sprache vom Kanal. Das ist zugleich die
richtige Ebene: Einblendungen richten sich an die Zuschauerschaft, nicht an
die Person vor dem Rechner.

Eine bewusste Sprachwahl je Nutzer gibt es vorerst nicht. Sie bräuchte eine
Spalte und eine Umschaltstelle, und die Browsersprache trifft den Fall fast
immer. Sie kommt, wenn jemand sie vermisst.

## 3. Texte je Ansicht, Module bringen ihren Katalog mit

Ein Modul bringt heute schon seine Panel-Ansicht mit und lädt sie lazy. Sein
Katalog gehört dorthin, aus demselben Grund: Ein deaktiviertes Modul soll null
Bytes kosten. Ein zentraler Katalog zöge die Texte jedes Moduls ins
Hauptbündel, auch die der abgeschalteten.

Gemeinsame Texte — „Abbrechen", „Speichern", Rollennamen — liegen weiterhin
zentral. Das sind zwei Orte statt einem; der Zuwachs ist der Preis für die
Bündelgrenze.

Der Contract bekommt dafür ein weiteres optionales Feld, wenn es so weit ist.

## 4. Eine Lücke ist ein Build-Fehler

Der Katalogtyp verlangt jeden Schlüssel in jeder Sprache. Fehlt einer, schlägt
`tsc` fehl, und die Lücke kommt nie in Betrieb.

Ein stiller Rückfall auf Deutsch wurde verworfen: Lücken blieben unsichtbar und
sammelten sich an — genau die stille Unvollständigkeit, gegen die dieses
Projekt sonst anarbeitet (Entscheidungen 0004 und 0005). Ein sichtbarer Hinweis
in der Oberfläche wurde ebenfalls verworfen: Er macht einen Pflegefehler zu
einem Makel, den der Nutzer ausbaden muss.

## 5. Was ab sofort gilt, auch ohne Umsetzung

Beides kostet heute nichts und verbilligt die spätere Nachrüstung:

- **Sichtbare Texte je Ansicht gesammelt halten**, statt sie über das Markup zu
  verstreuen. Das ist ohnehin lesbarer und macht später aus einer Suche im
  ganzen Baum ein Umbenennen an einer Stelle.
- **Kein neues fest verdrahtetes `de-DE`.** Wo Datum oder Zahl formatiert wird,
  kommt die Sprache aus einer gemeinsamen Stelle — heute mit `de-DE` belegt,
  später austauschbar. Im Bestand steht es fest verdrahtet in
  `src/dashboard/main.tsx` und `src/dashboard/members.tsx`; beide werden bei
  der Umsetzung nachgezogen.

## 6. Platzhalter in Chattexten bleiben englisch

Platzhalter in Chattexten gehören dem Kanal und werden nie je Sprache
übersetzt. Ein gespeicherter Text gehört dem Kanal, nicht der gerade
eingestellten Oberflächensprache; würde der Name mit der Sprache wandern,
wäre jeder gespeicherte Text nach einem Sprachwechsel kaputt.

| Modul | Platzhalter |
|---|---|
| `textbefehle` | `{user}`, `{channel}` |
| `werbung` | `{duration}`, `{seconds}` |
| `raid` | `{channel}`, `{viewers}` |

## 7. Ausdrücklich nicht betroffen

**Die Chat-Ausgaben des Bots.** Shoutout-Texte, Ansagen und Antworten sind
Einstellungen je Kanal, vom Broadcaster selbst verfasst. Ein englischsprachiger
Kanal trägt dort englische Texte ein. Sie werden nicht übersetzt.

**Code, Kommentare und Dokumentation.** Die Projektsprache ist Deutsch und
bleibt es. Hier geht es ausschließlich um die Oberfläche.
