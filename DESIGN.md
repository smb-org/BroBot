---
name: BroBot Panel
description: Verbindliches Zielsystem der Dashboard-Neugestaltung, abgeleitet aus dem fertigen Prototyp (docs/input/prototype) – zwei Themes (Nachtschicht, Indigo-Nacht), Farbrollen, Kit-Bauteile, Seitentypen, Durchsetzung
status: verbindlich für die Umsetzung
---

# BroBot Panel – Zielsystem

Quelle der Wahrheit ist, was der Prototyp ausliefert: `prototype/src/theme.css`,
`src/dashboard/ui/*`, `src/dashboard/ui/*`, `src/dashboard/live/*`, `src/pages/**` und die erzwingenden
Tests in `prototype/e2e/*.spec.ts`. Wo diese Datei und der Prototyp abweichen,
steht es in Abschnitt 16; dort gilt das Ziel.

Bezeichner im Code sind englisch, Anzeigetexte deutsch (zweisprachige Kataloge).
Beispiele hier sind fiktiv (`kanal_demo`, `nachtfalke`, `pixelpilz`).

## 1. Produktprinzipien

- **Ruhig stehen.** Zustandswechsel, Ergebnis- und Fehlermeldungen verschieben keine anderen Inhalte. Reserviere nur feste Status- und Fehlerslots, die tatsächlich gebraucht werden. Eine optionale Sektion zeigt ausgeschaltet nur Überschrift und Hinweis; erst ein bewusster Schalterklick fügt Felder ein.
- **Nichts Wichtiges unter wachsenden Listen.** Pagination, Formulare und Aktionen stehen über der Liste oder in festem Kopf. Listen dürfen beim Laden wachsen; Platzhalter müssen nur ungefähr passen.
- **Explizit speichern, nie Autosave.** Entwurf, „Verwerfen“, goldenes „Speichern“, Strg/Cmd+S. Ausnahme: „Module an/aus“ wirkt sofort und bietet „Rückgängig“.
- **Hierarchie über Flächen, nicht über Rahmen.** Kräftige Rahmen tragen nur Eingabefelder (3:1).
- **Eine Farbe, eine Bedeutung** (Abschnitt 3). Inhaltsfarben (Abschnitt 4) bleiben vom UI-Chrom getrennt.
- **Zustand nie nur als Farbe.** Immer Wort oder Symbol daneben.
- **Stille ist normal.** Ein laufender Bot erzeugt keine Anzeige außer dem grünen Punkt; ein pausiertes Modul ist kein Problem (neutral, nicht orange).
- **Maximal drei Textebenen pro Ansicht.** Keine Eyebrow-Zeile über Titeln.
- **Fest, nicht fluid.** Schriftgrößen sind feste Pixel, keine `clamp()`/Viewport-Einheiten.

## 2. Themes und Token-Mechanik

Zwei Themes, Wahl im Kontomenü unter „Darstellung“ (Menü-Radio), gespeichert in
`localStorage["brobot.palette"]`, gesetzt als `html[data-palette]`.

| Theme | `data-palette` | Rolle | Charakter |
|---|---|---|---|
| **Nachtschicht** | `nachtschicht` (Standard, auch ohne Speicher) | Default | neutrales Fast-Schwarz, fette weiße Titel, Zeilen nur durch Haarlinien getrennt, farbige Kategorie-/Zustands-/Typ-Badges je Navigationsgruppe |
| **Indigo-Nacht** | `indigo-nacht` | einzige Alternative | marineblaue Flächen, Hierarchie über Flächenstufen, Indigo als Ortsfarbe |

Mechanik (verbindlich):

- `src/dashboard/ui/tokens.css` definiert Tailwind-Tokens in `@theme` und Farbwerte auf `:root[data-palette]`. Nachtschicht ist der Standard; Indigo-Nacht überschreibt nur abweichende Farb-Tokens. Badges, Inhaltsfarben, Typografie, Radien und Abstände bleiben gemeinsam.
- Theme-spezifische Strukturregeln stehen unter `:root[data-palette="nachtschicht"] …` (Zeilen ohne Kasten, runde Badges, 3px-Kategorieleiste im Feed). Unterschiede gehören zuerst in Tokens; Strukturregeln nur, wo ein Token nicht reicht.
- **Keine fest codierten Farben außerhalb von Theme-Tokens und Inhaltsfarb-Sets.** Erzwungen von `tests/unit/theme-color-lint.test.ts`: `#hex`, `rgb(`, `rgba(` und `hsl(` in `src/dashboard/ui/**/*.{ts,tsx}` sind Fehler; Theme-Werte liegen in `src/dashboard/ui/tokens.css`.

- **Jedes Theme muss die Kontrast-Specs bestehen** (Abschnitt 14). Ein neues Theme ist erst fertig, wenn `palette-comparison.spec.ts` und `run-j.spec.ts` es abdecken.
- Umschalten bewegt kein Layout: `page-stage` hat vor und nach dem Wechsel dieselbe Box (getestet).

## 3. Farbrollen

| Rolle | Farbe | Bedeutung | Erlaubt |
|---|---|---|---|
| **Gold** | `--color-gold` | die eine nächste Aktion je Bereich | Primärbutton, aktiver Schritt, Fortschritt, Slider, gewählter Tab in einem Ablauf |
| **Ort** | `--color-marke*` (Nachtschicht blau, Indigo-Nacht indigo) | wo du bist / was gewählt ist | aktive Navigation, gewähltes Listenelement (Rahmen + linke Leiste), Fokusring, Links, Schalter „an“, Checkboxen, Variablen-Token |
| **Orange** | `--color-orange*` | „du bist dran“ (selten) | Hinweisbanner, Werbung in < 2 min, fehlende Berechtigung, Ungespeichert-Anzeige |
| **Rot** | `--color-fehler*` | Fehler / Zerstörendes | Fehlerzeilen, Löschen (umrandet); gefüllt nur im Bestätigungsdialog |
| **Grün** | `--color-gruen*` | läuft wirklich | LED + Wort, „Verbunden“ |
| Neutral | `--color-taste*`, `--color-text*` | alles übrige | „Beenden“, „Abbrechen“, „Verwerfen“ |

Regeln:

- **Höchstens ein goldener Primärbutton je Aktionsbereich.** Bereiche: Dialog, Speicher-Cluster, Seitenaktionen, Listen-Werkzeugleiste, Aktionsrahmen-Fuß, Popover-Aktionen. Erzwungen von `run-j.spec.ts` („Gold hat höchstens eine Primäraktion …“) über `data-primary-action="gold"`.
- Hilfe-Links („So funktioniert’s“) nutzen die **Linkfarbe** (`--color-marke-text`), nie Gold (Test `stepped-dialog.spec.ts`).
- Orange und Gold bleiben nebeneinander unterscheidbar (Farbton ≥ 12°, RGB-Abstand ≥ 45; Test Indigo-Nacht).
- Normales „Beenden“/„Abbrechen“ ist neutral (`ghost`/`outline`), nie rot.
- Grün steht nie ohne Wort. Rot und Orange nie als einziger Hinweis.
- Gold ist nie Auswahl, nie Status, nie Link.

### 3.1 Zustandsleiste (State Bar)

3px-Leiste links (`box-shadow: inset 3px 0 <farbe>`) **nur** an Blöcken mit lebendigem Zustand:

| Leiste | Zustand | Token |
|---|---|---|
| grün | läuft (`is-running`) | `--color-gruen` |
| orange | jetzt handeln (`is-imminent`) | `--color-orange` |
| rot | defekt (`is-error`) | `--color-fehler` |
| blau/Ort | Einrichtungshinweis | `--color-marke` |

Ruhende Blöcke haben keine Leiste. Die Ortsleiste an gewähltem Listenelement und aktivem Navigationspunkt bedeutet „hier bist du“, nie Zustand.

## 4. Inhaltsfarben (`--content-*`)

Inhaltsfarben gehören zum dargestellten Gegenstand, nicht zum Chrom. **Nie** auf Buttons, Auswahl, Status-LEDs oder Navigation.

| Gruppe | Tokens | Wo |
|---|---|---|
| Sonne | `--content-sun-{dawn,sunrise,noon,golden,sunset,blue-hour,icon}`, `-golden-chip/-ink`, `-blue-chip/-ink` | Sonnenbogen, Chips |
| Mond | `--content-moon-{lit,shadow}` | Mondscheibe |
| Wetter | `--content-weather-{sun,cloud,rain,storm,snow}` | Wettersymbole |
| Temperatur | `--content-temperature-{cold,mild,warm,hot}` | Temperaturskala |
| BELABOX | `--content-bitrate-{line,alarm,recover}` | Bitratenverlauf, Schwellen |
| Abstimmung | `--content-vote-1..6` = `#5b8cff #ff9f43 #2ed3a3 #ff6fae #ffd45c #a47bff` | Standard-Antwortfarben |
| Overlay-Design | frei wählbar (Hex im Editor) | Overlay-Elemente |

- **Abstimmungsfarben:** Standardpalette aus 6 Farben, je Antwort änderbar („Farbe für Antwort N“ + eigene Hex-Farbe). Gleiche Farbe in Panel-Vorschau, Cockpit-Ergebnis und Overlay. Jede Farbe ≥ 3:1 gegen die Balkenspur, alle 6 unterscheidbar (getestet). Führende Antwort: fett + Wort „führt“ (Ziel, siehe 16).
- Hex-Werte für Inhaltsfarben nur in `data/overlay.ts`, `data/voting.ts`, `OverlayEditor.tsx`, `Voting.tsx`; sonst über `--content-*`.
- `--chart-*` mappt auf Inhaltsfarben, nie auf Rollenfarben.

## 5. Farb-Tokens

### 5.1 Flächen und Linien

| Token | Nachtschicht | Indigo-Nacht | Rolle |
|---|---|---|---|
| `--color-tiefe` | `#06080B` | `#060a14` | Dialog-Hinterlegung, dunkelster Wert |
| `--color-rinne` | `#090C10` | `#0a1020` | Eingabefelder, vertiefte Flächen |
| `--color-grund` | `#0D1015` | `#0d1426` | Seitengrund |
| `--color-rail` | `#11151B` | `#111a2f` | Kopfleiste, Seitenleiste, Toast |
| `--color-inspektor` (= `flaeche-1`) | `#151A21` | `#152038` | Detail-/Kartenfläche |
| `--color-taste` (= `flaeche-2`) | `#1C222B` | `#1b2843` | Buttons, Popover, Chips |
| `--color-taste-hover` (= `flaeche-3`) | `#242B36` | `#233352` | Hover, Selected-Füllung |
| `--color-linie` | `#262D38` | `#22304b` | Haarlinie |
| `--color-linie-stark` | `#353E4B` | `#34466a` | stärkere Trennung |
| `--color-linie-control` (= `linie-hell`) | `#6B7686` | `#5a6e94` | Feldrand (≥ 3:1 auf Rinne) |

Beide Themes verwenden sechs Flächenstufen (tiefe, rinne, grund, rail, inspektor, taste). `--color-taste-hover` ist die separate Interaktionsfläche für Hoverzustände, keine siebte Flächenstufe. Hierarchie entsteht durch die Flächenstufen, nicht durch Rahmen.

### 5.2 Text

| Token | Nachtschicht | Indigo-Nacht | Verwendung | Kontrast auf Grund (N / I) |
|---|---|---|---|---|
| `--color-text` | `#F2F5F9` | `#f3f6fc` | Titel, Werte | 17,4 / 16,9 |
| `--color-text-2` | `#C9D1DB` | `#c3ccdd` | Feldnamen, Beschreibung | 12,4 / 11,4 |
| `--color-text-3` | `#8D98A7` | `#96a3bc` | Metazeilen, Platzhalter | 6,5 / 7,2 |
| `--color-text-4` | `#7A8595` | `#8291ac` | nur Deko, Trenner, inaktive Punkte – nie Fließtext | 5,1 / 5,8 |

`text-4` unterschreitet in Nachtschicht auf `taste` 4,5:1 (4,28) und wird vom Test nicht geprüft: **nie Text**.

### 5.3 Ort, Gold, Orange, Rot, Grün

| Token | Nachtschicht | Indigo-Nacht | Rolle | Kontrast |
|---|---|---|---|---|
| `--color-marke` | `#4C9AFF` | `#4a62f2` | Ort, gefüllt | Text darauf ≥ 4,5 (7,0 / 4,9) |
| `--color-marke-auf` | `#06080B` | `#ffffff` | Text auf Ort-Füllung | |
| `--color-marke-text` | `#4C9AFF` | `#9db0ff` | Links, aktiver Text | auf Grund 6,7 / 8,8 |
| `--color-marke-linie` | `#4C9AFF` | `#6a84ff` | Ortsrand | |
| `--color-fokus` | `#4C9AFF` | `#a9b9ff` | Fokusring (2px, Offset 2px) | ≥ 3:1 auf allen Flächen (6,7 / 9,7) |
| `--color-auswahl-rand` / `-grund` | `#4C9AFF` / `#1C222B` | `#6a84ff` / `#1e2a5c` | gewähltes Element | Rand ≥ 3:1, Text ≥ 4,5 |
| `--color-gold` (`-hover` / `-pressed`) | `#E8B93C` (`#F2CA59` / `#D4A72C`) | `#E3B341` (`#F0C75B` / `#D2A12F`) | Primärbutton | |
| `--color-auf-signal` | `#14100A` | `#11131A` | Text auf Gold | ≥ 7:1 (10,3 / 9,5) |
| `--color-gold-soft` / `-text` | `#2B2414` / `#E8B93C` | `#342B17` / `#F2C75C` | weiche Goldfläche | Text ≥ 4,5 |
| `--color-orange` | `#FF8A3D` | `#FF8A3D` | Du-bist-dran | |
| `--color-orange-on` | `#06080B` | `#11131A` | Text auf Orange | ≥ 4,5 (8,6 / 7,9) |
| `--color-orange-soft` / `-border` / `-text` | `#2C2018` / `#76502F` / `#FF8A3D` | `#321F18` / `#94502E` / `#FFAA83` | Banner, Ungespeichert | Text ≥ 4,5 |
| `--color-fehler` / `-text` | `#FF6B6B` / `#FF6B6B` | `#d93a42` / `#ff8a8f` | Fehler | Text auf Grund 6,9 / 8,1 |
| `--color-fehler-grund` / `-rand` | `#281719` / `#63353A` | `#2e1520` / `#7a2b36` | Fehlerfläche | |
| `--color-auf-fehler` | `#FFFFFF` | `#ffffff` | Text auf gefülltem Rot | ≥ 4,5 (Indigo-Nacht knapp: 4,5) |
| `--color-gruen` / `-word` | `#3FCF7F` / `#3FCF7F` | `#34d399` / `#4ade9a` | Läuft | auf Grund 9,5 / 10,7 |
| `--color-gruen-grund` / `-rand` | `#14271D` / `#286647` | `#0f2a26` / `#1f5a47` | Läuft-Fläche | |

`--color-tint-1/-2` sind identisch mit `taste` (Altlast, nicht neu verwenden).

### 5.4 Semantik für Befehle und Variablen

`--semantic-command`, `-username`, `-countdown` = `text`; `--semantic-variable` = Ortsfarbe; `--semantic-module` = `text-2`. Variablen-Token im Textfeld sind Ortsfarbe (nie Gold).

## 6. Kategorie-Badges (Nachtschicht)

Pro Navigationsgruppe ein Farbton; Token-Dreier `--badge-<x>` (Schrift), `-fill`, `-line`. Schrift auf Füllung ≥ 4,5:1 (getestet für alle 16 Paare).

| Gruppe (`data-module-group`) | Schrift | Füllung | Linie |
|---|---|---|---|
| Chat (`chat`) | `#3FD0C9` | `#122D30` | `#29565B` |
| Mitmachen (`participation`/`mitmachen`) | `#B48CFF` | `#292137` | `#4F3C70` |
| Twitch (`twitch`) | `#E07BFF` | `#2D1D39` | `#68406F` |
| Daten (`data`/`daten`) | `#5BD68A` | `#193527` | `#316244` |
| Stream (`stream`) | `#FF9F5A` | `#35271E` | `#684D38` |
| Verwaltung (`admin`/`verwaltung`) | `#8FA8C8` | `#252B35` | `#46556C` |

Weitere Badge-Familien (gleiche Mechanik):

| Familie | Werte |
|---|---|
| Rolle | Broadcaster (`#E8B93C`), Verwalter (`#8FA8C8`), Bediener (`#B48CFF`) |
| Zustand | aktiv (grün), pausiert (grau `#8D98A7`), Fehler (rot), fehlt (orange) |
| Befehlstyp | automatisch (`#3FD0C9`), Regex (`#B48CFF`), Text (`#8FA8C8`) |

Verwendung der Kategorie-Badges (`.p2-module-card__badge`, `.command-module-badge`, `.template-variable-picker__module-badge`, `.p2-log-row__category`): Modul-Badges in Listen, Feed-Leiste (3px je Kategorie), Modulkarten, Variablen-Picker-Gruppen, Protokoll. Die Zuordnung kommt aus `src/data/palette.ts` (`paletteGroupForModule`, `…ForVariable`, `…ForArea`), nie aus Namensmustern. Kategoriefarbe ist **nie** Zustand: Grün/Rot/Orange gehören den Zustands-Badges.

Indigo-Nacht: Badges erben die Nachtschicht-Tokens (kein eigener Satz); die `[data-palette="nachtschicht"]`-Strukturregeln gelten dort nicht, Badges sind neutral (`taste` + `text-3`).

## 7. Typografie

Schriften: **Archivo** (UI) und **IBM Plex Mono** (Zahlen), selbst gehostet.

| Stufe | Wert | Token |
|---|---|---|
| Body | 14px / 400 / lh 1.45 | `--text-body`, `--leading-normal` |
| Label / Abschnittstitel | 13px / 500 in `text` (Abschnitt: 600) | `--text-feldname`, `--text-abschnitt` |
| Button | 13px / 600 | Button-Variante |
| Spaltenkopf | 11px / 600, +.04em | `--text-spaltenkopf` |
| Zahlen | Plex Mono 500, tabellarisch | `--font-zahl` |
| Seitentitel | 22px / 600, −0.015em, lh 1.25 (Nachtschicht: 700) | `--text-seitentitel` |
| Bereichstitel | 15px | `--text-bereichstitel` |
| Nav-/Meta-Etikett, LED-Wort | 11–12px | `--text-navetikett`, `--text-led-wort` |

- Mono nur für Werte, die man abliest oder eintippt (Zähler, IDs, Befehlstoken, Zeiten); nie für Namen oder Beschreibungen.
- Keine Eyebrow-Zeile (Vorzeile in Versalien) über Titeln. Kein Text unter 11px.
- Max. drei Textebenen je Ansicht: Titel, Inhalt (`text`), Meta (`text-3`).

## 8. Form, Abstand, Tiefe

- **Radien:** genau zwei. `--radius-control` 6px (Bedienelemente, Anzeigen), `--radius-container` 12px (Objekte: Dialog, Karte, Toast, Popover-Kasten). Pillen (999px) nur Badges. Kein dritter Wert.
- **Abstand:** `--spacing-s1…s12` = 4, 8, 12, 16, 20, 24, 32, 40, 48. Seitenrand der Arbeitsfläche 32px.
- **Rahmen:** 1px Haarlinie; kräftige Rahmen nur an Eingaben (`linie-control`). Leerzustände gestrichelt.
- **Schatten:** nur auf schwebenden Ebenen (Dialog, Popover, Menü, Toast); im Fluss keine. Tiefe entsteht durch Flächenstufen.
- **Bewegung:** kurze Übergänge (≤ 160ms), unter `prefers-reduced-motion` aus. Kein Schimmer, keine animierten Skelette.
- **Symbole:** Lucide, einheitliche Strichstärke; Emoji nirgends im UI.
- **Dichte:** Controls 32px hoch, auch `UnitInput`; Abstand zwischen Abschnitten 20px, innerhalb eines Abschnitts 12px. Vorlagen-Textfelder haben zwei Zeilen, FAQ-Antworten und Textbausteine drei. Chatvorschauen zeigen zwei reservierte Zeilen. Vorlagenfeld und Vorschau stehen in Timer, Textbefehlen, FAQ, Textbausteinen, Raid, Werbung, Votekick und BELABOX nebeneinander. Einrichtungsseiten gruppieren Felder nicht in eigene Rahmen.

## 9. Layout und Navigation

### 9.1 Zwei Modi

- **Live-Cockpit** (`/live`): Betrieb während des Streams, ohne Seitenleiste, Raster aus Sofortaktionen, Live-Kacheln, Ereignisfeed (`.app-shell--live`).
- **Einrichten** (`/setup/*`): Konfiguration mit Seitenleiste (`.app-shell--setup`).
- Umschalter in der Kopfleiste (`.mode-switch`, „Live“ / „Einrichten“).

### 9.2 Kopfleiste (`.topbar`, 64px)

Links: Marke, Kanalwahl (`kanal_demo`, Popover „Kanal wechseln“). Mitte: Modus-Umschalter. Rechts: Zustandsumschalter (nur Prototyp), „Suchen“ (Befehlspalette, Cmd/Strg+K), Kontomenü mit „Darstellung“.

### 9.3 Aufgabenbasierte Navigation (Einrichten, `.setup-nav`, 256px)

Sechs Gruppen, je Gruppe ein Badge-Farbton (Abschnitt 6). Aktiver Punkt: Ortsfarbe + linke Leiste (Nachtschicht: `taste`-Fläche + `inset 2px` Ort).

| Gruppe | Seiten (Route unter `/setup/`) |
|---|---|
| Chat | Textbefehle (`text-commands`), FAQ & Auto-Antworten (`faq`), Textbausteine (`text-library`), Timer (`timers`) |
| Mitmachen | Abstimmung (`voting`), Votekick (`votekick`), Clips (`clips`) |
| Twitch | Werbung (`ads`), Raid & Shoutout (`raid`) |
| Daten | Ort & Wetter (`location-weather`), Eigene Datenquellen (`data-sources`) |
| Stream | Overlays (`overlays`), BELABOX (`belabox`) |
| Verwaltung | Module an/aus (`modules`), Mitglieder & Rechte (`members`), Variablen (`variables`), Kanalereignisse (`channel-events`), Protokoll (`log`), System (`system`) |

„Kanalereignisse“ steht in Verwaltung unmittelbar vor „Protokoll“.

**Geplant:** Seite **„Testbereich“** – Probenachrichten im Trockenlauf gegen alle Module (Issue #409). Noch nicht im Prototyp; Einordnung (Gruppe Chat oder Verwaltung) wird beim Bau entschieden.

### 9.4 Seitentypen

| Typ | Bauteil | Aufbau | Beispiele |
|---|---|---|---|
| **Sammlung** | `CollectionPage` | Liste links (360/420/480px nach Breite, Werkzeugleiste oben) + Detail rechts | Textbefehle, Timer, Abstimmung, FAQ, Textbausteine, Datenquellen, Variablen, Mitglieder |
| **Einstellungen** | `SettingsPage` | 1–4 Spalten unter dem Seitenkopf | Ort & Wetter, Raid, Votekick, Werbung, BELABOX, System, Module |
| **Werkzeug** | `ToolPage` | volle Fläche, Kopf + Arbeitsfläche | Overlay-Editor, Protokoll |

- Die Seite scrollt nie als Ganzes (`scrollHeight ≤ innerHeight` bei 1440/1920/2560, getestet); innere Bereiche scrollen und lassen ihren letzten Inhalt frei erreichen (`save-header.spec.ts`).
- Kein horizontaler Seitenscroll bei 1440 und 1920px.
- Zielbreite ab 1440px; darunter stapeln Sammlung und Spalten.
- Gemeinsame Listenbreite: 360px bis 1600px Inhaltsbreite, 420px von 1680px bis 2199px und 480px ab 2200px. Keine seitenspezifischen Breitenregeln.

### 9.5 Kopf-Reihenfolge (fest)

```
links:  Titel (h1) | An/Aus-Schalter | aussagekräftige Badges   /   Metazeile darunter
rechts: Speicher-Cluster | Seitenaktionen | „…“ (Weitere Aktionen)
```

- **Speicher-Cluster** (`SaveStatus`) im Seiten- bzw. Detailkopf, **nie** als Fußleiste. Reihenfolge: Statustext, „Verwerfen“ (ghost), „Speichern“ (gold, Strg/Cmd+S). Feste Breite (430px), ragt bei 1440/1920px nie aus dem Bild (getestet).
- **Seitenaktionen** nach dem Cluster; höchstens ein Goldbutton.
- Bei Abstimmung, Votekick und Clips steht zusätzlich „Chatbefehle · n“ rechts neben dem Speicher-Cluster. Andere Module zeigen diesen Knopf nicht.
- **„…“-Menü** ganz rechts: seltene und zerstörerische Aktionen (Löschen, Zurücksetzen), jede mit Bestätigung.
- Titel < Cluster < Aktionen von links nach rechts (getestet).
- Der Kopf bleibt beim Zustandswechsel (lädt, Fehler, bereit) an derselben Stelle (getestet für Timer).

### 9.6 Listen

- Eine Zeile hat feste Höhe, höchstens zwei Badges und nie eine dritte Textzeile. Lange Inhalte werden abgeschnitten statt umgebrochen.
- Badges dürfen Modulname in Palettenfarbe, neutrale Art oder Zustand benennen. Pro Zeile sind höchstens zwei davon sichtbar.
- FAQ-Zeilen sind 52px hoch: Griff, Positionsnummer, Titel und genau eine Metazeile. Nur „Regex“ und „Pausiert“ erscheinen als Badges. Drag oder Alt+↑/↓ ordnet sofort um; ein Toast bietet „Rückgängig“.
- Variablen zeigen das Modul-Badge in derselben Titelzeile wie den Variablennamen; eigene Variablen heißen „Eigene“.
- Gewähltes Element: Rahmen/Fläche + linke Ortsleiste, `aria-current="true"`.
- Filter, Suche und ein rechts stehendes goldenes, beschriftetes „Neu“ in einer Werkzeugzeile, nie unter der Liste.
- Leere Liste: Hinweis in festem Bereich, kein Layoutsprung.

### 9.7 Spaltenausrichtung

Nebeneinander stehende Spalten richten sich zeilenweise aus: jedes Steuerelement hat ein Feldlabel, parallele Abschnittsüberschriften teilen eine Grundlinie. Test: erste Controls beider FAQ-Spalten auf gleicher Höhe (≤ 1px).

### 9.8 Overlays über dem Fluss

Popover, Menüs, Toasts und Dialoge rendern **über ein Portal** und werden nie von Scroll-Containern beschnitten (getestet: Chat-Ziel-Popover bleibt im Viewport und außerhalb von `.collection-detail__scroll`).

## 10. Rückmeldung

- **Toasts:** unten rechts (`Sonner`, `.toaster`, z-index 150), Radius 12px, Fläche `rail`, 3px-Leiste links nach Rolle: Erfolg grün, Fehler rot, Info Ortsfarbe, Warnung orange. **Fehler-Toasts bleiben stehen**, bis sie geschlossen werden. Meldungen mit Folgehandlung („Rückgängig“ bei Module an/aus) sind Toasts, nie eingeschobene Zeilen.
- **Feldfehler:** reservierte Zeile unter dem Feld (`FieldError`, `aria-live="polite"`, `&nbsp;` wenn leer); die Seite springt nie.
- **Speicherfehler:** im Speicher-Cluster (rote Leiste, „Erneut versuchen“), Kopf bleibt stehen.
- **Ladezustand:** vorhandene Werte stehen lassen, Hinweistext in reserviertem Bereich; Kacheln bewegen sich nicht.
- **Sperren:** `LockedReason` reserviert die Zeile immer (leer = `&nbsp;`); der Grund steht direkt am gesperrten Bedienelement.

## 11. Kit-Bauteile (`src/dashboard/ui/`)

Jedes Bauteil liest den Seitenzustand über `useControlState()` (`state.ts`: `disabled`, `loading`, `locked`) und rendert alle Zustände ohne Layoutsprung.

| Bauteil (Datei) | Zweck | Regeln | Nicht verwenden für |
|---|---|---|---|
| **PageHeader** / `ModuleStatusSwitch` (`PageHeader.tsx`) | Kopf einer Modulseite: Titel, An/Aus, Badges, Meta, Aktionen | Reihenfolge 9.5; Schalter beschriftet „Aktiv“/„Pausiert“; Sperrhinweis in der Metazeile | Seiten ohne Modul (direkt `ToolPage`/`SettingsPage`) |
| **SaveStatus** (`SaveStatus.tsx`) | Speicher-Cluster: Statustext, Verwerfen, Speichern, Strg/Cmd+S, Fehler + „Erneut versuchen“ | feste Breite; Zustände `saved`/`dirty`/`saving`/`error` (`data-state`); Gold nur „Speichern“; Shortcut nur wenn sichtbar und ungespeichert | Sofortaktionen, Module an/aus (kein Entwurf) |
| **HeaderActions** (`HeaderActions.tsx`) | rechte Kopfseite: Cluster + Seitenaktionen + „…“-Popover | „…“ per Portal, schließt bei Klick | Aktionen, die immer sichtbar sein müssen |
| **CollectionPage** (`CollectionPage.tsx`) | Liste + Detail | Liste 360px, Werkzeugleiste oben; Detail scrollt intern; Leerzustand integriert | Seiten mit nur einem Objekt |
| **SettingsPage** (`SettingsPage.tsx`) | Spaltenseite mit Kopf | 1–4 Spalten, jede scrollt intern | Liste/Detail |
| **ToolPage** (`ToolPage.tsx`) | Werkzeug mit voller Fläche | Kopf wie 9.5, `tool-page__body` füllt den Rest | Formularseiten |
| **Section** (`Section.tsx`) | Abschnitt mit Titel (13px/600) und Haarlinie | `h2`; keine Section in Section | Gruppierung einzelner Felder |
| **TemplateTextField** (`TemplateTextField.tsx`) | Mehrzeiliges Textfeld mit Variablen | Variablen als Token (Ortsfarbe, Tooltip beim Überfahren, Textfarbe bleibt); `{` öffnet Picker (Listbox „Variablen auswählen“, Suche, nach Modul gruppiert: „Dieses Modul“, „Eigene Variablen“ …); Pfeile/Enter/Esc; unbekannte Variable unterstrichen + feste Fehlerzeile „Unbekannte Variable {usr} – meintest du {user}?“ + Korrektur-Button; **kein RE2 hier** | Regex-Eingaben, einzeilige Namen |
| **Field** (`Field.tsx`) | Einheitlicher Feldrahmen für Eingaben | Label, Feldinhalt, feste Hinweis-/Fehlerzeile; 32px Controls; keine Sonderrahmen um Feldgruppen | Abschnittsgruppierung |
| **SwitchRow** (`SwitchRow.tsx`) | Einheitliche einfache Zeilenschalter | Gleiche Schalterdarstellung für gleichrangige Optionen | Felder, die beim Einschalten Inhalt zeigen |
| **SwitchSection** (`SwitchSection.tsx`) | Optionale Felder unter einem Abschnittsschalter | Schalter in der Überschrift; aus = Überschrift + eine Hinweiszeile, an = Felder darunter; keine Platzhalterhöhe | Sofortige Modulaktivierung |
| **RoleThreshold** (`RoleThreshold.tsx`) | Mindestrolle für Chataktionen | Select „Mindestrolle“ plus statische, 11px hohe Zeile mit eingeschlossenen Rollen; Abonnenten schließen VIP ohne Abo aus; Votekick folgt seiner Rangfolge | Modulinterne Rollenlisten |
| **ChatPreview** (`ChatPreview.tsx`) | „Vorschau“ mit Beispieldaten | zwei reservierte Zeilen, nur Anzeige (`resolveTemplatePreview`) | echte Nachrichten |
| **ChatTargetField** (`ChatTargetField.tsx`) | Ein gemeinsames „Chat-Ziel“-Feld | Portal-Popover mit Auswahl und Erklärung je Ziel | andere Auswahlen |
| **DataTable** (`DataTable.tsx`) | Protokoll, Kanalereignisse und Live-Ereignisse | eine Filterzeile; 40px-Zeilen; Zeit, Modul, Wer/Was, Art; relative Zeit bleibt sichtbar, Datum/Uhrzeit stehen als Tooltip und zugängliches Label bereit; Tagesüberschriften bleiben sticky | Formulare |
| **ChatCommandsHelp** (`ChatCommandsHelp.tsx`) | Syntaxhilfe für eingebaute Chatbefehle | „Chatbefehle · n“ im Seitenkopf, Beschreibung, Mindestrolle, Argumente und Kopieraktion; Daten entsprechen den Moduldeklarationen | Module ohne Chatbefehle |
| **TokenChip** (`TokenChip.tsx`) | Sichtbarer Vorlagen-Token | kompakte Chipdarstellung, z. B. `{api.sonnenuntergang}` | Fließtext |
| **UnitInput** (`UnitInput.tsx`) | Zahl + Einheit (`min`, `s`, `%`, `Mbit/s`, `Zuschauer`) mit Schnellchips | Einheit fest im Feld, Chips als Vorschläge, reservierte Ladezeile | Freitext |
| **SegmentChoice** (`SegmentChoice.tsx`) | 2–4 gleichwertige Optionen, eine aktiv | `aria-pressed`; aktive Option Ortsfarbe | Aktionen, > 4 Optionen |
| **ChoiceCards** (`ChoiceCards.tsx`) | wenige Optionen mit Erklärung | Titel + Beschreibung + Haken; gewählt = Ort-Rahmen | Optionen ohne Erklärung (dann `SegmentChoice`) |
| **ChipsInput** (`ChipsInput.tsx`) | Liste kurzer Werte (z. B. Aliasse) | Enter/Komma fügt hinzu, Backspace entfernt letzten, führendes `!` entfällt, Chips mit X | Spiele (dann `GameMultiSelect`) |
| **GameMultiSelect** (`GameMultiSelect.tsx`) | Twitch-Kategorien wählen | Chips im Feld; Vorschläge „Aktuelle Kategorie“ / „Zuletzt gestreamt“; Suche mit Status; **max. 10**; **leer = alle Spiele** („n von 10“); Tastatur | andere Mehrfachauswahlen |
| **StepDialog** (`StepDialog.tsx`) | geführte Einrichtung in Schritten | Abschnitt 11.1 | Einzelne Eingaben, Bestätigungen |
| **StatusLed** (`StatusLed.tsx`) | Punkt (8px) + Wort | Zustände `ok`/`loading`/`warn`/`error`/`off`; Wort immer | Kategorie-Badges |
| **FieldError** (`FieldError.tsx`) | reservierte Fehlerzeile | immer gerendert | seitenweite Fehler |
| **LockedReason** (`LockedReason.tsx`) | Sperrgrund mit Schloss | reserviert Platz auch ohne Sperre | allgemeine Hinweise |
| **RuleNote** (`RuleNote.tsx`) | Regelhinweis (Info-Symbol, neutrale linke Leiste) | neutral, keine Zustandsfarbe | Warnungen, Fehler |
| **TwitchReconnectDialog** (`TwitchReconnectDialog.tsx`) | `StepDialog` „Twitch neu verbinden“ (Berechtigungen, Bestätigung, Ergebnis) | erreichbar aus System und aus gesperrter Werbung | andere Verbindungen |

### 11.1 StepDialog

- Aufbau von oben: Titel, Schritttitel (`step-dialog__step-title`), Untertitel, **Schrittanzeige** (`ol[aria-label="Dialogfortschritt"]`, aktiver Schritt `aria-current="step"`, Zahl bzw. Haken), **Hilfezeile** („So funktioniert’s“, Linkfarbe), Inhalt, Fuß.
- **Stabile Höhe:** Dialog `min(760px, 100dvh − 32px)` hoch; Schrittwechsel ändert weder Dialog- noch Inhaltshöhe (getestet).
- Fuß: links „Zurück“ (outline, im ersten Schritt deaktiviert) und „Abbrechen“ (ghost); rechts **goldenes** „Weiter“ bzw. „Fertig“ (`data-primary-action="gold"`, Text `auf-signal`).
- Enter in einem Eingabefeld geht weiter; Esc oder X fragt vor dem Verwerfen nach, sobald Schritt > 1 oder editiert („Einrichtung abbrechen?“ / „Weiter bearbeiten“ / „Verwerfen“).
- **Höchstens zwei verschachtelte Rahmen:** Dialog → Inhaltsfläche; `step-dialog__card` hat keinen eigenen Rahmen (`border-top-width: 0`, getestet). Keine Karte in Karte in Karte.
- Unter 640px entfällt die Schrittbeschriftung, der Fuß stapelt.
- Einsatz: **In OBS einbinden** (Overlay wählen, Link kopieren, Verbindung testen), **Neue Datenquelle** (Adresse, Wert im JSON-Baum wählen, Name), **Twitch neu verbinden**, **Kanal einrichten** (Standort, Module wählen, Erster Textbefehl).

## 12. Cockpit-Bauteile (`src/dashboard/live/`)

### 12.1 Sofortaktionen-Vertrag (`contract.ts`)

Module stellen Sofortaktionen bereit (`ImmediateAction`): `id`, `moduleId`, `label`, `icon`, `requires: ("live" | "moduleEnabled")[]`, `role: "bediener" | "verwalter"`, optional `lockedReason()`, optional `content` (`size: "popover" | "dialog"`, `title`, `submitLabel`, `Component` mit `onValidChange`), `run()`. Kacheln (`LiveTile`): `id`, `moduleId`, `active()`, `Component`. Registrierung zentral in `actions/definitions.tsx` und `tiles/index.tsx`; das Cockpit kennt keine Modullogik.

- Eine Aktion ist **aktiv**, wenn alle `requires` erfüllt sind (Stream an, Modul an), die Rolle reicht und keine Sperre greift.
- Eine gesperrte Aktion bleibt sichtbar und nennt den **Grund direkt am Knopf** (`action-card__reason`, reservierte Zeile).
- Ohne `content` führt `run()` sofort aus; mit `content` öffnet ein Popover (kurz: Werbung, Shoutout) oder Dialog (länger: Abstimmung).

### 12.2 Bauteile

| Bauteil | Zweck | Regeln |
|---|---|---|
| **ActionGrid** (`ActionGrid.tsx`) | Raster der Sofortaktionen (3 Spalten) mit Rollenanzeige | Rolle/Sperre/Zustand ergeben `reason`; Zähler „n Aktionen“ |
| **ActionFrame** (`ActionFrame.tsx`) | Rahmen einer Aktion (Karte + Popover/Dialog) | Kopf, Inhalt, reservierte Fehlerzeile (`action-frame__error`), Fuß „Abbrechen“ + ein Goldbutton mit `submitLabel`; Esc schließt und gibt den Fokus an den Auslöser zurück (getestet); Busy „Wird ausgeführt …“ |
| **LiveTiles** (`tiles/*`: Voting, Votekick, Ads, Upcoming, Warning) | laufende Vorgänge | Zustandsleiste nach 3.1; Kachelpositionen ändern sich beim Zustandswechsel nicht (getestet) |
| **EventFeed** (`EventFeed.tsx`) | Ereignisliste | Nachtschicht: 3px-Kategorieleiste je Ereignis (raid → Twitch, support/moderation → Mitmachen, command → Chat, system → Stream), Nutzername fett |
| **CockpitHeader** (`CockpitHeader.tsx`) | Live-Pille, Laufzeit, Zuschauer, Streamtitel/Kategorie (Popover), Gesundheits-LEDs | Streamtitel nur für Verwalter änderbar; Offline zeigt „Twitch neu verbinden“ an fester Stelle |
| **Statuszeile** (`cockpit-message`) | `aria-live="polite"` Systemmeldung am Seitenende | fester Platz, kein Einschub |

## 13. Weitere Bausteine

### 13.1 Overlay-Editor

- Elementarten: generisches **Text**-Element mit gestylten Zeilen (`lines`, je Zeile Text und Stil) sowie **Spezialelemente** **Abstimmung** und **Votekick** (feste Struktur, eigene Eigenschaften). „Element hinzufügen“ bietet genau diese drei.
- Text-Element: Zeilen bleiben getrennt (keine Überlappung), Text passt in die Leinwand, Zeilenkarten scrollen im Eigenschaftenbereich (`overlay-properties__scroll`).
- Spezialelemente können Farben aus der Abstimmung übernehmen („Farben aus Abstimmung übernehmen“).
- Dynamische Werte (Wetter, Zähler) kommen über Variablen, nie als feste Zahlen.

### 13.2 Befehlspalette (`CommandPalette.tsx`)

Cmd/Strg+K, Dialog „Seite suchen“, genau ein Suchsymbol, Fokusring 2px/Offset 2px, filtert Seiten, Pfeile + Enter öffnen. Auswahl: Rahmen + linke Ortsleiste. Nicht für Aktionen (dafür Sofortaktionen).

### 13.3 Bestätigungsdialog

`UnsavedChangesDialog` („Änderungen verwerfen?“) und Löschbestätigungen: Standardweg „Weiter bearbeiten“ (ghost), destruktiver Button rot. **Nur hier ist Rot gefüllt**; außerhalb des Dialogs ist der Löschbutton rot umrandet (`.detail-delete-button`, Text `fehler-text`). Dialoge dienen Bestätigungen und geführten Abläufen, nie Formularen.


## 14. Barrierefreiheit (durch Tests erzwungen)

Quellen: `palette-comparison.spec.ts` (beide Themes), `run-j.spec.ts` (Indigo-Nacht, ausführlich), `visual-colors.spec.ts`.

| Paar | Minimum |
|---|---|
| `text`, `text-2`, `text-3` auf `grund`, `flaeche-1`, `taste` (Indigo-Nacht zusätzlich `tiefe`, `rinne`, `rail`, `flaeche-2/3`, Auswahl-/Gold-/Orange-/Fehler-/Grün-Soft) | 4,5:1 |
| Feldrand `linie-control` auf `grund`, `rinne` | 3:1 |
| Fokus auf allen Flächen | 3:1 |
| `auf-signal` auf `gold`, `-hover`, `-pressed` | 7:1 |
| `gold-text` auf `gold-soft` und `grund` | 4,5:1 |
| `orange-on` auf `orange`; `orange-text` auf `orange-soft` und `grund` | 4,5:1 |
| `auf-fehler` auf `fehler` | 4,5:1 |
| `marke-auf` auf `marke`; `marke-text` auf `grund` und `auswahl-grund` | 4,5:1 |
| `auswahl-rand` auf `auswahl-grund` | 3:1 |
| Badge-Schrift auf Badge-Füllung (16 Paare, Nachtschicht) | 4,5:1 |
| Abstimmungsfarben auf Balkenspur | 3:1 |
| Gold gegen Orange | Farbton ≥ 12°, RGB-Abstand ≥ 45 |

Weitere Pflichten:

- **Fokus:** sichtbar, 2px, Offset 2px (Suchfelder: Ring am Wrapper); Fokus kehrt nach Popover/Dialog an den Auslöser zurück.
- **Farbe nie allein:** LED mit Wort, Zustands-Badge mit Wort, Gewählt mit Rahmen/Leiste/Haken, Fehler mit Text + Symbol, Abstimmung mit Beschriftung.
- **Tastatur:** Picker (`{`, Pfeile, Enter, Esc), `GameMultiSelect`, `StepDialog` (Enter/Esc), Strg/Cmd+S, Cmd/Strg+K.
- **Trefferfläche:** Bedienelemente ≥ 24px; Desktop-Prototyp: Button und Eingabe 32px, `sm` 28px nur in Listenzeilen; bei `(pointer: coarse)` beträgt die Trefferfläche mindestens 40px.
- `aria-live="polite"` für Fehlerzeilen, Statuszeile, Speicherstatus; `aria-busy` beim Laden; `aria-pressed`, `aria-current`, `role="switch"` nach Rolle.
- Kein Text unter 11px (siehe 16).

## 15. Durchsetzung

Jede UI-Änderung folgt dieser Datei; Abweichungen stehen ausdrücklich in der PR-Beschreibung. Automatisch geprüft: Farb-Lint (`theme-color-lint`), Kontrast (`palette-comparison`, `run-j`), ein Goldbutton je Bereich (`run-j`), kein Seitenscroll/Beschnitt (`save-header`, `prototype`), Kopfreihenfolge (`save-header`), Layoutstabilität (`prototype`), StepDialog-Höhe (`stepped-dialog`).

### Checkliste für Reviewer

- [ ] **Farbrolle:** Gold nur für die eine nächste Aktion? Ort nur für „wo bin ich“? Orange nur für „du bist dran“? Rot nur Fehler/Zerstörendes? Grün nur „läuft“ mit Wort? „Beenden“/„Abbrechen“ neutral?
- [ ] **Mehr als ein Goldbutton** im selben Bereich?
- [ ] **Inhaltsfarbe** (`--content-*`) auf Button, Auswahl oder Status?
- [ ] **Hartcodierte Farbe** außerhalb von Tokens/Allowlist; **Alpha-Füllung** (`rgba`, `color-mix`, `opacity` als Fläche) statt fester Soft-Fläche?
- [ ] **Beide Themes** geprüft (Nachtschicht, Indigo-Nacht), Kontrast-Specs grün?
- [ ] **Fußleiste mit Speichern/Aktionen** oder Wichtiges unter einer wachsenden Liste?
- [ ] **Beschnittene Popover/Menüs/Toasts** (kein Portal)?
- [ ] **Kopf-Reihenfolge** eingehalten (Titel, Schalter, Badges / Cluster, Aktionen, „…“)? Zerstörendes im „…“-Menü mit Bestätigung?
- [ ] **Layoutsprung** bei Laden, Fehler, Erfolg, Meldung, aufklappendem Teil? Fehlerzeilen reserviert? Toast statt Einschub?
- [ ] **Autosave?** (nicht erlaubt, außer Module an/aus mit Rückgängig)
- [ ] **Zustandsleiste** nur an lebendigen Blöcken?
- [ ] **Eyebrow-Zeile**, mehr als drei Textebenen, Text < 11px, Emoji?
- [ ] **Spalten** zeilenweise ausgerichtet, Feldlabels vorhanden?
- [ ] **StepDialog:** höchstens zwei verschachtelte Rahmen, stabile Höhe, ein Goldbutton?
- [ ] **Alle Zustände** (bereit, lädt, Fehler, gesperrt, nicht verbunden, neu) ohne Sprung darstellbar?
- [ ] **Tastatur und Fokus** funktionieren, Farbe nie allein?

## 16. Gemeinsame Muster der Konsistenzrunde S

Diese verbindlichen Ergänzungen vereinheitlichen alle vorhandenen Prototypseiten und haben Vorrang vor älteren, seitenspezifischen Beschreibungen oben.

### 16.1 Antworten und optionale Inhalte

- Textbefehle wählen die Antwortart als Segment direkt in der Abschnittsüberschrift. Eine Beschreibungszeile bleibt für jede Art gleich hoch. Freitext und Vorschau behalten ihren festen gemeinsamen Platz; Timeout-Felder folgen darunter.
- Timer und FAQ verwenden immer ein `TemplateTextField` mit freien Texten und Variablen. Ein Umschalter „Eigener Text / Textbaustein“ existiert nicht.
- Optionale Bereiche kommen nach den erforderlichen Abschnitten. Der Schalter steht in ihrer Überschrift. Aus zeigt nur Überschrift und einen Hinweis; an zeigt die Felder. Es gibt keine leere 420px- oder 238px-Reservierung.
- Jede Vorschau trägt die Beschriftung „Vorschau“ und leitet ihren Text aus dem aktuellen Entwurf ab.

### 16.2 Listen und Texttokens

- Textbaustein-Token lauten ausschließlich `{text.<name>}`. Der nackte Alias `{<name>}` ist ungültig. Der Variablenpicker nennt die Gruppe „Textbausteine“ und verwendet ein Buchsymbol; der Beispielwert ist der Text des Bausteins.
- Timer, Textbefehle, FAQ, Textbausteine, Datenquellen, Variablen und Mitglieder nutzen dieselbe Listenbreitenregel aus 9.4. Alle Zeilen bleiben einzeilig und schneiden überlange Inhalte ab.
- FAQ hat kein lokales „Testen“-Formular. Die Aktion „Im Testbereich prüfen“ führt zu Issue #409; die Reihenfolge ist eine sofortige, rückgängig machbare Aktion wie Modul an/aus.
- Löschen steht immer im „…“-Menü und verlangt eine Bestätigung. Eine beschriftete goldene „Neu“-Aktion steht rechts neben der Suche.

### 16.3 Datenquellen, Variablen und Overlays

- Eine eigene Datenquelle trägt ihren editierbaren Namen im Kopf und den Token `{api.<name>}` als Chip. Unter der URL steht der Abrufzustand. „Abrufen & prüfen“ liefert Status und Ergebnis direkt unter dem Ausdruck; eine Änderung an URL oder Ausdruck markiert das Ergebnis als veraltet.
- `$` öffnet den nach Text, Zahlen, Logik, Listen und Datum gruppierten Funktionskatalog. Er zeigt Signatur und Beispiel; Einfügen erfolgt an der Schreibmarke. Klicks im JSON-Baum fügen den Pfad ein. Nur die Allowlist von `src/modules/api_source/domain/index.ts` erscheint.
- Eigene Variablen sind samt Startwert, aktuellem Wert und Definition editierbar. Änderungen werden gemeinsam gespeichert oder verworfen; kein Wert wird beim Tippen sofort geschrieben. Modulvariablen zeigen das liefernde Modul als Link in der Metazeile und im Schreibschutzhinweis.
- Der Overlay-Editor hat drei Spalten (240px / Rest / 560px). Textzeilen sind eine Tabelle aus 40px-Zeilen mit Griff, Tokenauszug, Stilwahl und Löschen; Drag oder Alt+↑/↓ ordnet um. Der Stil des gewählten Eintrags steht in einem Block unter der Tabelle. Ein Klick auf eine Canvas-Zeile wählt dieselbe Tabellenzeile.

### 16.4 Ereignistabellen und Kopfstatus

- Protokoll, Kanalereignisse und Live-Ereignisse verwenden dieselbe rahmenlose Filterzeile und `DataTable`. Keine Zebraflächen. Zeit bleibt in jeder Zeile sichtbar als kurze deutsche relative Zeit (`Intl.RelativeTimeFormat`); der Tooltip und das zugängliche Label enthalten Datum und Uhrzeit. Zeiten über etwa sechs Stunden dürfen zusätzlich die Uhrzeit zeigen. Der Protokoll-Detailbereich verändert die Tabellenbreite nicht.
- Modulzustand erscheint als StatusLED: Punkt und Wort, ohne Statuskarte. Schalter einer gemeinsamen Art teilen eine `SwitchRow`-Darstellung. `ChatTargetField` heißt überall „Chat-Ziel“.
- Datensätze, Beispielkonten, URLs und Chatverläufe im Prototyp sind fiktiv. Inhalte und Statusänderungen lassen keine Ansicht selbstständig springen.

### 16.5 Seitenmuster

- Clips ist eine schmale Einspaltenseite ohne Videovorschau: Modusschalter und Status, „Clip erstellen“, „Letzte Clips“, danach `!clip`-Rollen-/Abklingzeiteinstellungen sowie die optionalen Abschnitte „Clip-Link im Chat posten“ und „Automatische Clips“.
- „Chatbefehle · n“ erscheint ausschließlich bei Abstimmung, Votekick und Clips. Verwaltung enthält Kanalereignisse unmittelbar vor Protokoll; ein „Pflichtmodul“-Badge erscheint nicht.
- Mitglieder zeigen Rollen in einer gemeinsamen Mitgliederansicht statt doppelter Rollenkarten. Vorschautexte für Live-Ereignisse behalten ihre Zahlen; Streamtitel werden als lokaler Entwurf bearbeitet. „Verwerfen“ stellt auf jeder Seite den letzten gespeicherten Stand wieder her.
