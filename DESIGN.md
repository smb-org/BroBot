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

Es gibt **keine Markenfarbe**. Das System kennt drei Farben, und alle drei
bedeuten Zustand:

| Rolle | Wert | Bedeutung |
|---|---|---|
| `--warn` | `#d9a441` | Warnung |
| `--fehler` | `#e2564d` | Fehler |

Zustand erscheint als 3px-Kante links an der betroffenen Zeile **plus**
Textmarke. Farbe informiert nie allein — das ist Zusicherung, nicht Geschmack.

Neutralwerte: `--grund #0a0c10` (ein Ton, kein Verlauf, kein Halo),
`--rail #0d1016`, `--erhoben #0e1218`, Linien `#1b1f27` / `#272c36` / `#414a5a`,
Text `#e6e9ef` / `#98a0ae` / `#7d8595`.

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

## Bewegung

150 bis 250 ms, ausschließlich für Zustandswechsel. Keine Einblendfolgen beim
Laden: Das Panel lädt in eine Aufgabe, nicht in eine Vorführung.
`prefers-reduced-motion` schaltet sie ab.
