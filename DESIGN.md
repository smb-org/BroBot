# Design

<!-- impeccable:design-schema 1 -->

Modus: **Operate**. Das Panel ist ein Werkzeug, das im Störfall aufgeschlagen
und schnell wieder geschlossen wird. Die Messlatte sind Stripe, Cloudflare und
Sentry: vertraute Anordnung, konventionelle Navigation, keine Metapher — aber
deren handwerkliches Niveau.

## Die zwei tragenden Regeln

**Ein gesunder Zustand erzeugt kein Signal.** Keine grüne Plakette, kein Badge,
kein farbiger Rand. Nur eine ruhige Zeile. Farbe erscheint ausschließlich bei
Abweichung. Der Vorgängerentwurf konnte keinen Kanal jemals als gesund
anzeigen, weil jede Warnschwelle strukturell immer erfüllt war — wenn alles
leuchtet, leuchtet nichts.

**Bereiche trennt Abstand und eine Haarlinie, keine Karte.** Gestapelte Boxen
mit Rand, Verlauf und Schatten sind als Seitengliederung ausgeschlossen. Ein
Container nur dort, wo mehrere Zeilen wirklich eine Einheit bilden
(Zustandsstreifen, Kanalliste).

## Farbe

Zwei getrennte Rollen. Sie zu vermischen war der Fehler der ersten Fassung:
ohne Markenfarbe wirkt die Oberfläche asketisch statt souverän.

### Markenfarbe

**`#538dcc`**, gedämpftes Blau. Blau und nicht Violett, weil BroBot die
Oberfläche für *mehrere* Kanäle ist und neben Twitch als eigenes Werkzeug
erkennbar bleiben soll, nicht als dessen Anhängsel.

| Rolle | Wert | Verwendung |
|---|---|---|
| `--marke` | `#538dcc` | gefüllte primäre Aktion |
| `--marke-hover` | `#659cd7` | Zeiger darauf |
| `--marke-press` | `#4c80bc` | gedrückt |
| `--marke-text` | `#9bc3ed` | Verknüpfungen, aktiver Navigationstext, Fokusring |
| `--marke-linie` | `#60758c` | Marke am aktiven Eintrag, Auswahlkante |
| `--tint-1` | `#172638` | Navigationsschiene, Tabellenkopf |
| `--tint-2` | `#14202e` | ausgewählte Zeile |

**Die Regel, aus der jede Platzierung folgt: Markenfarbe markiert nie
Wichtigkeit, sondern ausschließlich den Ort des Bedieners.** Aktiver
Navigationseintrag, primäre Aktion, gewählte Zeile, sortierte Spalte,
Fokusring, Verknüpfung. Das System spricht nie in Markenfarbe — es spricht in
Grau und in den Zustandsfarben. Dadurch kollidieren die beiden Rollen
strukturell, nicht nur farbmetrisch.

Sie erscheint ausdrücklich **nicht**: in keinem gesunden Zustand, nicht auf
Zahlen (eine eingefärbte Zahl behauptet Bedeutung), nicht als zweite
Signalebene neben Grün/Amber/Rot, nirgends als Verlauf oder Schein.

**Flächenanteil:** näher an Linear als an Sentry. Im Ruhezustand unter einem
Prozent kräftige Farbe. Die getönten Flächen tragen Farbe über zehn bis
fünfzehn Prozent, aber so entsättigt, dass niemand sie als Farbe benennt — man
liest sie als Material. Genau daher kommt der Unterschied zwischen asketisch
und souverän.

### Zustandsfarbe

Drei Farben, alle bedeuten Zustand, keine ist zugleich Markenfarbe:

| Rolle | Wert | Bedeutung |
|---|---|---|
| `--warn` | `#d9a441` | Warnung |
| `--fehler` | `#e2564d` | Fehler |

Zustand erscheint als 3px-Kante links an der betroffenen Zeile **plus**
Textmarke. Farbe informiert nie allein — das ist Zusicherung, nicht Geschmack.

Neutralwerte: `--grund #0a0c10` (ein Ton, kein Verlauf, kein Halo),
`--rail #0d1016`, `--erhoben #0e1218`, Linien `#1b1f27` / `#272c36` / `#414a5a`,
Text in **vier** Stufen: `#e3e7ed` / `#a2abb8` / `#7d8595` / `#5f6773`. Zwei
Stufen sind das sicherste Anzeichen eines unfertigen Grau-Entwurfs; Kanalnamen
und Fehlerursachen dürfen nicht im selben schwachen Grau stehen wie Metadaten.
Zwei Haarlinienstärken: `#1b1f27` gliedert innerhalb eines Blocks, `#272c36`
trennt Blöcke.

Dunkel, weil das Panel nachts neben OBS steht — nicht, weil Werkzeuge dunkel
sind.

## Typografie

**Archivo** für die Oberfläche, **IBM Plex Mono** für alles Numerische —
Zeitstempel, Zähler, Kennungen — mit `font-variant-numeric: tabular-nums`,
damit ein wechselnder Wert seine Nachbarn nicht verschiebt. Beide selbst
gehostet unter `src/dashboard/fonts/`, keine fremde CDN.

Feste rem-Skala, kein `clamp()`: Betriebsoberflächen werden bei
gleichbleibender Auflösung gelesen. Grundgröße 14px. Seitentitel 20px —
eine Großüberschrift wiederholt nur den markierten Navigationspunkt.

**Keine Eyebrow-Zeilen über Überschriften.** Die Überschrift trägt ihr Gewicht
selbst.

## Maß und Form

Abstände auf 4px-Basis: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48.

**Genau zwei Radien:** 4px für Bedienelemente, 8px für Container. Pillen
ausschließlich für echte Tags. Vorher waren es fünf ohne System.

## Bedienelemente

**Gewichtung folgt Konsequenz, nicht Häufigkeit.** Genau eine helle Aktion pro
Bereich. Zerstörende Aktionen sind still, bis man auf sie zeigt, dann eindeutig
rot. Vorher war „Suchen" das hellste Element der Seite, während „Zugriff
entziehen" ein stiller Umriss war.

**Der Grund steht an der Wirkung.** Warum etwas gesperrt ist oder fehlschlug,
steht an dieser Aktion, nicht als Meldung an anderer Stelle.

Der Zustandspunkt am Navigationseintrag zeigt ein Problem, **bevor** man
klickt.

## Zugänglichkeit

WCAG AA ist verbindliche Untergrenze, kein Polierschritt. Sichtbarer
`focus-visible`-Ring, vollständige Tastaturbedienung, Zustand nie allein über
Farbe. Trefferflächen: 44px für alleinstehende Bedienelemente, 34px in dichten
Tabellenzeilen — beides über der AA-Mindestgröße von 24×24.

Text: `--text-2` trägt 7,4:1 auf dem Grundton, `--text-3` 5,3:1. Beide über
4,5:1, auch auf `--rail` und `--erhoben`. Die zerstörende Aktion steht auf
`--text-2`, nicht auf dem leiseren Ton. Browser-Oberflächen — Auswahl, Bildlaufleiste, Platzhalter,
Fokusring — sind aus der Palette gesetzt, nicht dem Standard überlassen.

## Lebenszeichen statt Plakette

Eine tickende Relativzeit („aktualisiert vor 3 s") steht neutral in der
Titelzeile. Sie beweist, dass die Anzeige lebt, ohne einen Zustand zu
behaupten — der legitime Ersatz für die verbotene grüne Plakette.

**Kein Skelett-Schimmer beim Laden.** Der letzte bekannte Wert bleibt stehen,
gedimmt, mit seinem Alter darunter, und wird hart ersetzt. Bewegung im
Augenwinkel sieht neben einem laufenden Stream wie eine Änderung aus; das ist
die teuerste Fehlinterpretation, die es hier gibt.

**Keine dauerhaft gefüllte Hauptaktion.** Eine kräftige primäre Aktion
erscheint erst bei einem konkreten Anlass. Ein gesunder Zustand verlangt keine
Handlung, und die auffälligste Fläche eines laufenden Systems soll keine
Aufforderung sein.

## Bewegung

150 bis 250 ms, ausschließlich für Zustandswechsel. Keine Einblendfolgen beim
Laden: Das Panel lädt in eine Aufgabe, nicht in eine Vorführung.
`prefers-reduced-motion` schaltet sie ab.
