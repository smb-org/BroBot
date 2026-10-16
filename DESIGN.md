---
name: BroBot Panel
description: Dashboard UI design target for the implemented palette foundation and planned page migrations
status: verbindlich für die Umsetzung
---

# BroBot Panel – Zielsystem

Die aktuelle Implementierung liegt in `src/dashboard/ui/tokens.css`,
`src/dashboard/styles.css`, `src/dashboard/ui/theme.ts` und `src/dashboard/router.ts`.
Die verbindlichen Tests liegen unter `tests/unit/` und `tests/e2e/`. Dieses Dokument
beschreibt das Zielsystem; Anforderungen ohne verlinkten Implementierungs- oder
Testbeleg sind geplant und noch keine Aussage über das heutige Produkt.

Bezeichner im Code sind englisch, Anzeigetexte deutsch (zweisprachige Kataloge).
Beispiele hier sind fiktiv (`kanal_demo`, `nachtfalke`, `pixelpilz`).

## Implementierungsstand

- `src/dashboard/ui/tokens.css` enthält die englischen Palette-Tokens und die Werte für `nachtschicht` und `indigo-nacht`.
- `src/dashboard/styles.css` enthält weiterhin die bestehenden warmen Oberflächen-Tokens wie `--background`, `--surface` und `--line`. Palette-Tokens mit Präfix `--color-` überschreiben diese Legacy-Tokens nicht.
- `src/dashboard/ui/theme.ts` bindet Mantine an die bestehenden Legacy-Farben. Die Migration bestehender Seiten auf die neuen Palette-Tokens ist geplant.
- `tests/unit/theme-color-lint.test.ts` prüft Farb-Literale in `.ts`, `.tsx` und `.css` unter `src/dashboard/ui/`; nur `src/dashboard/ui/tokens.css` ist ausgenommen.
- `tests/unit/dashboard-ui-theme.test.ts` prüft Mantine-Formgrößen und die dokumentierten gefüllten Farbpaare beider Paletten.
- `tests/e2e/foundation-visual.spec.ts` kann Dashboard-Routen als Screenshots erfassen. Es vergleicht diese Screenshots nicht automatisch.

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

Aktuelle Palette-Mechanik:

- `src/dashboard/ui/tokens.css` definiert die Palette-Tokens auf `:root[data-palette]`. Nachtschicht ist der Standard; Indigo-Nacht überschreibt seine abweichenden Werte. Die Werte sind verfügbar, aber bestehende Seiten verwenden weiterhin die Legacy-Tokens aus `src/dashboard/styles.css`.
- Theme-spezifische Strukturregeln sind geplant. Unterschiede sollen zuerst in Tokens ausgedrückt werden; Strukturregeln sind nur nötig, wo ein Token nicht reicht.
- **Keine fest codierten Farben außerhalb von Theme-Tokens und Inhaltsfarb-Sets.** Der aktuelle Lint in `tests/unit/theme-color-lint.test.ts` weist `#hex`, `rgb(`, `rgba(` und `hsl(` in `.ts`, `.tsx` und `.css` unter `src/dashboard/ui/` zurück; die zentrale Token-Datei `src/dashboard/ui/tokens.css` ist ausgenommen.

- Der aktuelle Kontrasttest prüft die gefüllten Farbpaare aus Abschnitt 14 in beiden Paletten. Weitere Kontrast- und Layoutanforderungen aus diesem Dokument sind geplant, bis ein konkreter Test sie abdeckt.

## 3. Farbrollen

| Rolle | Farbe | Bedeutung | Erlaubt |
|---|---|---|---|
| **Gold** | `--color-gold`, `--color-gold-hover`, `--color-gold-press`, `--color-on-gold` | die eine nächste Aktion je Bereich | Primärbutton, aktiver Schritt, Fortschritt, Slider, gewählter Tab in einem Ablauf |
| **Brand** | `--color-brand*` | wo du bist / was gewählt ist | aktive Navigation, gewähltes Listenelement, Fokusring, Links, Schalter „an“, Checkboxen, Variablen-Token |
| **Orange** | `--color-orange`, `--color-orange-on`, `--color-orange-soft`, `--color-orange-border`, `--color-orange-text` | „du bist dran“ (selten) | Hinweisbanner, Werbung in < 2 min, fehlende Berechtigung, Ungespeichert-Anzeige |
| **Rot** | `--color-error`, `--color-error-text`, `--color-error-surface`, `--color-error-border`, `--color-on-error` | Fehler / Zerstörendes | Fehlerzeilen, Löschen (umrandet); gefüllt nur im Bestätigungsdialog |
| **Grün** | `--color-success`, `--color-success-text`, `--color-success-surface`, `--color-success-border` | läuft wirklich | LED + Wort, „Verbunden“ |
| Neutral | `--color-surface*`, `--color-text*`, `--color-border*` | alles übrige | „Beenden“, „Abbrechen“, „Verwerfen“ |

Regeln:

- **Geplant:** höchstens ein goldener Primärbutton je Aktionsbereich. Ein automatischer Prüftest dafür existiert derzeit nicht.
- Hilfe-Links („So funktioniert’s“) nutzen die **Linkfarbe** (`--color-brand-text`), nie Gold.
- Orange und Gold sollen nebeneinander unterscheidbar bleiben (Farbton ≥ 12°, RGB-Abstand ≥ 45); ein automatischer Test dafür ist geplant.
- Normales „Beenden“/„Abbrechen“ ist neutral (`ghost`/`outline`), nie rot.
- Grün steht nie ohne Wort. Rot und Orange nie als einziger Hinweis.
- Gold ist nie Auswahl, nie Status, nie Link.

### 3.1 Zustandsrahmen (State Border)

Seitenleisten gibt es nicht; Ausnahmen sind nur Toasts (Abschnitt 10), die rote Leiste des Speicher-Clusters und die Kategoriekodierung im Ereignis-Feed (Kategorie, weder Auswahl noch Zustand). Lebendiger Zustand zeigt sich über Rahmenfarbe, Fläche und die LED mit Wort, **nur** an Blöcken mit lebendigem Zustand:

| Rahmen | Zustand | Token |
|---|---|---|
| grün | läuft (`is-running`) | `--color-success` |
| orange | jetzt handeln (`is-imminent`) | `--color-orange` |
| rot | defekt (`is-error`) | `--color-error` |
| blau/Brand | Einrichtungshinweis | `--color-brand` |

Ruhende Blöcke haben neutralen Rahmen. Gewähltes Listenelement und aktiver Navigationspunkt bedeuten „hier bist du“, nie Zustand: 1px Brand-Rahmen rundum plus `--color-selection-surface` (dezente Brand-Tönung), keine Leiste.

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

- **Abstimmungsfarben:** geplante Standardpalette aus 6 Farben, je Antwort änderbar („Farbe für Antwort N“ + eigene Hex-Farbe). Gleiche Farbe in Panel-Vorschau, Cockpit-Ergebnis und Overlay. Ziel: jede Farbe ≥ 3:1 gegen die Balkenspur und alle 6 unterscheidbar; ein automatischer Test ist geplant.
- Inhaltsfarben verwenden die `--content-*`-Tokens. Frei gewählte Overlay-Farben sind Nutzereingaben und werden getrennt vom UI-Chrom behandelt.
- `--color-chart-1` bis `--color-chart-5` mappen auf Inhaltsfarben, nie auf Rollenfarben.

## 5. Farb-Tokens

### 5.1 Flächen und Linien

| Token | Nachtschicht | Indigo-Nacht | Rolle |
|---|---|---|---|
| `--color-depth` | `#06080B` | `#060A14` | Dialog-Hinterlegung, dunkelster Wert |
| `--color-well` | `#090C10` | `#0A1020` | Eingabefelder, vertiefte Flächen |
| `--color-background` | `#0D1015` | `#0D1426` | Palette-Hintergrund |
| `--color-rail` | `#11151B` | `#111A2F` | Kopfleiste, Seitenleiste, Toast |
| `--color-inspector` | `#151A21` | `#152038` | Detail-/Kartenfläche |
| `--color-surface` | `#1C222B` | `#1B2843` | Buttons, Popover, Chips |
| `--color-surface-hover` | `#242B36` | `#233352` | Hover, Selected-Füllung |
| `--color-border` | `#262D38` | `#22304B` | Haarlinie |
| `--color-border-strong` | `#353E4B` | `#34466A` | stärkere Trennung |
| `--color-border-control` | `#6B7686` | `#5A6E94` | Feldrand (Ziel: ≥ 3:1 auf `--color-well`) |

Beide Paletten verwenden die Flächen-Tokens `--color-depth`, `--color-well`, `--color-background`, `--color-rail`, `--color-inspector` und `--color-surface`. `--color-surface-hover` ist die separate Interaktionsfläche für Hoverzustände. Hierarchie entsteht durch Flächen, nicht durch Rahmen.

### 5.2 Text

| Token | Nachtschicht | Indigo-Nacht | Verwendung | Kontrast auf Grund (N / I) |
|---|---|---|---|---|
| `--color-text` | `#F2F5F9` | `#F3F6FC` | Titel, Werte | |
| `--color-text-2` | `#C9D1DB` | `#C3CCDD` | Feldnamen, Beschreibung | |
| `--color-text-3` | `#8D98A7` | `#96A3BC` | Metazeilen, Platzhalter | |
| `--color-text-4` | `#7A8595` | `#8291AC` | nur Deko, Trenner, inaktive Punkte – nie Fließtext | |

`--color-text-4` ist für Dekoration vorgesehen, nicht für Fließtext. Kontraste der Text-Tokens über alle Flächen sind eine künftige Testanforderung.

### 5.3 Ort, Gold, Orange, Rot, Grün

| Token | Nachtschicht | Indigo-Nacht | Rolle | Kontrast |
|---|---|---|---|---|
| `--color-brand` | `#4C9AFF` | `#4A62F2` | Brand-Fläche | foreground pairs in Abschnitt 14 |
| `--color-brand-on` | `#06080B` | `#FFFFFF` | Text auf Brand-Füllung | |
| `--color-brand-text` | `#4C9AFF` | `#9DB0FF` | Links, aktiver Text | |
| `--color-brand-border` | `#4C9AFF` | `#6A84FF` | Brand-Rand | |
| `--color-focus` | `#4C9AFF` | `#A9B9FF` | Fokusring (Ziel: 2px, Offset 2px) | |
| `--color-selection-border` / `--color-selection-surface` | `#4C9AFF` / Markenfarbe 10 % über `--color-surface` | `#6A84FF` / Markenfarbe 20 % über `--color-surface` | gewähltes Element (Tönung per `color-mix`, Textkontrast ≥ 4,5:1) | |
| `--color-gold`, `--color-gold-hover`, `--color-gold-press` | `#E8B93C`, `#F2CA59`, `#D4A72C` | `#E3B341`, `#F0C75B`, `#D2A12F` | Primärbutton | |
| `--color-on-gold` | `#06080B` | `#11131A` | Text auf Gold | |
| `--color-gold-soft` / `--color-gold-text` | `#2B2414` / `#E8B93C` | `#342B17` / `#F2C75C` | weiche Goldfläche | |
| `--color-orange` | `#FF8A3D` | `#FF8A3D` | Du-bist-dran | |
| `--color-orange-on` | `#06080B` | `#11131A` | Text auf Orange | ≥ 4,5 (8,6 / 7,9) |
| `--color-orange-soft` / `-border` / `-text` | `#2C2018` / `#76502F` / `#FF8A3D` | `#321F18` / `#94502E` / `#FFAA83` | Banner, Ungespeichert | Text ≥ 4,5 |
| `--color-error` / `--color-error-text` | `#FF6B6B` / `#FF6B6B` | `#D93A42` / `#FF8A8F` | Fehler | |
| `--color-error-surface` / `--color-error-border` | `#281719` / `#63353A` | `#2E1520` / `#7A2B36` | Fehlerfläche | |
| `--color-on-error` | `#000000` | `#000000` | Text auf gefülltem Rot | aktuell im Unit-Test: ≥ 4,5:1 |
| `--color-success` / `--color-success-text` | `#3FCF7F` / `#3FCF7F` | `#34D399` / `#4ADE9A` | Läuft | |
| `--color-success-surface` / `--color-success-border` | `#14271D` / `#286647` | `#0F2A26` / `#1F5A47` | Läuft-Fläche | |

`--tint-1` und `--tint-2` gehören zu den Legacy-Tokens in `src/dashboard/styles.css`; sie sind nicht Palette-Tokens.

### 5.4 Semantik für Befehle und Variablen

`--semantic-command`, `--semantic-username` und `--semantic-countdown` verwenden die Textfarbe; `--semantic-variable` verwendet Brand; `--semantic-module` verwendet `--color-text-2`. Variablen-Tokens im Textfeld sind Brand (nie Gold).

## 6. Kategorie-Badges (Nachtschicht)

Pro Navigationsgruppe ein Farbton; Token-Dreier wie `--badge-chat`, `--badge-chat-fill` und `--badge-chat-line`. Schriftkontrast von Badge-Tokens ≥ 4,5:1 ist ein Ziel; ein Test dafür ist geplant.

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

Kategorie-Badges sind ein geplantes Muster für Listen, Karten und Picker-Gruppen. Die Palette-Auswahl wird in `src/dashboard/ui/palette.ts` gespeichert; eine Modul-zu-Badge-Zuordnung ist noch nicht implementiert. Kategoriefarbe ist **nie** Zustand: Grün/Rot/Orange gehören den Zustands-Badges.

Indigo-Nacht verwendet derzeit dieselben Badge-Tokens wie Nachtschicht; palette-spezifische Badge-Werte sind geplant.

## 7. Typografie

Schriften: **Archivo** (UI) und **IBM Plex Mono** (Zahlen), selbst gehostet.

| Stufe | Wert | Token |
|---|---|---|
| Body | 14px / 400 / lh 1.45 | `--text-body`, `--leading-normal` |
| Label / Abschnittstitel | 13px / 500 in `--color-text` (Abschnitt: 600) | `--text-field-label`, `--text-section` |
| Button | 13px / 600 | Mantine `--button-fz` in `src/dashboard/ui/theme.ts` |
| Spaltenkopf | 11px / 600 | `--text-column-heading` |
| Zahlen | IBM Plex Mono, tabellarisch | `--font-mono`, `--text-number` |
| Seitentitel | 22px / 600, −0.015em, lh 1.25 | `--text-page-title` |
| Bereichstitel | 15px | `--text-section-title` |
| Nav-/Meta-Etikett, LED-Wort | 11–12px | `--text-nav-label`, `--text-status-label` |

- Mono nur für Werte, die man abliest oder eintippt (Zähler, IDs, Befehlstoken, Zeiten); nie für Namen oder Beschreibungen.
- Keine Eyebrow-Zeile (Vorzeile in Versalien) über Titeln. Kein Text unter 11px.
- Max. drei Textebenen je Ansicht: Titel, Inhalt (`text`), Meta (`text-3`).

## 8. Form, Abstand, Tiefe

- **Radien:** genau zwei. `--radius-control` 6px (Bedienelemente, Anzeigen), `--radius-container` 12px (Objekte: Dialog, Karte, Toast, Popover-Kasten). Pillen (999px) nur Badges. Kein dritter Wert.
- **Abstand:** `--spacing-s1…s12` = 4, 8, 12, 16, 20, 24, 32, 40, 48. Seitenrand der Arbeitsfläche 32px.
- **Rahmen:** 1px Haarlinie; kräftige Rahmen nur an Eingaben (`linie-control`). Leerzustände gestrichelt.
- **Schatten:** nur auf schwebenden Ebenen (Dialog, Popover, Menü, Toast); im Fluss keine. Tiefe entsteht durch Flächenstufen.
- **Bewegung:** kurze Übergänge (≤ 160ms), unter `prefers-reduced-motion` aus. Kein Schimmer, keine animierten Skelette.
- **Symbole:** Tabler Icons über `src/dashboard/ui/Icon.tsx`, einheitliche Strichstärke; Emoji nirgends im UI.
- **Dichte:** Controls 32px hoch, auch `UnitInput`; Abstand zwischen Abschnitten 20px, innerhalb eines Abschnitts 12px. Vorlagen-Textfelder haben zwei Zeilen, FAQ-Antworten und Textbausteine drei. Chatvorschauen zeigen zwei reservierte Zeilen. Vorlagenfeld und Vorschau stehen in Timer, Textbefehlen, FAQ, Textbausteinen, Raid, Werbung, Votekick und BELABOX nebeneinander. Einrichtungsseiten gruppieren Felder nicht in eigene Rahmen.

## 9. Layout und Navigation

Die folgenden Abschnitte beschreiben geplante Navigation und Seitenmuster. Die aktuell gültigen Routen stehen in `src/dashboard/router.ts`.

### 9.1 Zwei Modi (geplant)

- **Live-Cockpit** (geplante Route `/live`): Betrieb während des Streams, ohne Seitenleiste, Raster aus Sofortaktionen, Live-Kacheln, Ereignisfeed (`.app-shell--live`).
- **Einrichten** (geplante Routen `/setup/*`): Konfiguration mit Seitenleiste (`.app-shell--setup`).
- Umschalter in der Kopfleiste (`.mode-switch`, „Live“ / „Einrichten“).

### 9.2 Kopfleiste (`.topbar`, 64px)

Links: Marke, Kanalwahl (`kanal_demo`, Popover „Kanal wechseln“). Mitte: Modus-Umschalter. Rechts: Zustandsumschalter (nur Prototyp), „Suchen“ (Befehlspalette, Cmd/Strg+K), Kontomenü mit „Darstellung“.

### 9.3 Aufgabenbasierte Navigation (Einrichten, `.setup-nav`, 256px)

Sechs Gruppen, je Gruppe ein Badge-Farbton (Abschnitt 6). Aktiver Punkt: 1px Brand-Rahmen rundum + `--color-selection-surface`, keine Leiste. Hover immer `--surface-hover`, nie ein literales Warmgrau.

| Gruppe | geplante Seiten (Route unter `/setup/`) |
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

- Ziel: Die Seite scrollt nie als Ganzes (`scrollHeight ≤ innerHeight` bei 1440/1920/2560); ein automatischer Test dafür ist geplant.
- Kein horizontaler Seitenscroll bei 1440 und 1920px.
- Zielbreite ab 1440px; darunter stapeln Sammlung und Spalten.
- Gemeinsame Listenbreite: 360px bis 1600px Inhaltsbreite, 420px von 1680px bis 2199px und 480px ab 2200px. Keine seitenspezifischen Breitenregeln.

### 9.5 Kopf-Reihenfolge (fest)

```
links:  Titel (h1) | An/Aus-Schalter | aussagekräftige Badges   /   Metazeile darunter
rechts: Speicher-Cluster | Seitenaktionen | „…“ (Weitere Aktionen)
```

- **Geplanter Speicher-Cluster** im Seiten- bzw. Detailkopf, **nie** als Fußleiste. Reihenfolge: Statustext, „Verwerfen“ (ghost), „Speichern“ (gold, Strg/Cmd+S). Zielbreite 430px; Überlauf- und Größenprüfungen sind geplant.
- **Seitenaktionen** nach dem Cluster; höchstens ein Goldbutton.
- Bei Abstimmung, Votekick und Clips steht zusätzlich „Chatbefehle · n“ rechts neben dem Speicher-Cluster. Andere Module zeigen diesen Knopf nicht.
- **„…“-Menü** ganz rechts: seltene und zerstörerische Aktionen (Löschen, Zurücksetzen), jede mit Bestätigung.
- Titel < Cluster < Aktionen von links nach rechts.
- Der Kopf soll beim Zustandswechsel (lädt, Fehler, bereit) an derselben Stelle bleiben; ein Layouttest ist geplant.

### 9.6 Listen

- Eine Zeile hat feste Höhe, höchstens zwei Badges und nie eine dritte Textzeile. Lange Inhalte werden abgeschnitten statt umgebrochen.
- Badges dürfen Modulname in Palettenfarbe, neutrale Art oder Zustand benennen. Pro Zeile sind höchstens zwei davon sichtbar.
- FAQ-Zeilen sind 52px hoch: Griff, Positionsnummer, Titel und genau eine Metazeile. Nur „Regex“ und „Pausiert“ erscheinen als Badges. Drag oder Alt+↑/↓ ordnet sofort um; ein Toast bietet „Rückgängig“.
- Variablen zeigen das Modul-Badge in derselben Titelzeile wie den Variablennamen; eigene Variablen heißen „Eigene“.
- Gewähltes Element: 1px Brand-Rahmen rundum + `--color-selection-surface`, keine Leiste, `aria-current="true"`.
- Filter, Suche und ein rechts stehendes goldenes, beschriftetes „Neu“ in einer Werkzeugzeile, nie unter der Liste.
- Leere Liste: Hinweis in festem Bereich, kein Layoutsprung.

### 9.7 Spaltenausrichtung

Nebeneinander stehende Spalten richten sich zeilenweise aus: jedes Steuerelement hat ein Feldlabel, parallele Abschnittsüberschriften teilen eine Grundlinie. Test: erste Controls beider FAQ-Spalten auf gleicher Höhe (≤ 1px).

### 9.8 Overlays über dem Fluss

Popover, Menüs, Toasts und Dialoge sollen **über ein Portal** rendern und nicht von Scroll-Containern beschnitten werden. Ein automatischer Portal- und Viewport-Test ist geplant.

## 10. Geplante Rückmeldung

- **Toasts:** unten rechts, Radius 12px, Fläche `--color-rail`, Leiste links nach Rolle: Erfolg grün, Fehler rot, Info Brand, Warnung orange. **Fehler-Toasts bleiben stehen**, bis sie geschlossen werden. Meldungen mit Folgehandlung sind Toasts, nie eingeschobene Zeilen.
- **Feldfehler:** reservierte Zeile unter dem Feld (`FieldError`, `aria-live="polite"`, `&nbsp;` wenn leer); die Seite springt nie.
- **Speicherfehler:** im Speicher-Cluster (rote Leiste, „Erneut versuchen“), Kopf bleibt stehen.
- **Ladezustand:** vorhandene Werte stehen lassen, Hinweistext in reserviertem Bereich; Kacheln bewegen sich nicht.
- **Sperren:** `LockedReason` reserviert die Zeile immer (leer = `&nbsp;`); der Grund steht direkt am gesperrten Bedienelement.

## 11. Geplante Kit-Verträge

Die Namen in der Tabelle bezeichnen gewünschte UI-Rollen, keine vorhandenen Dateien. Die aktuellen wiederverwendbaren Komponenten liegen in `src/dashboard/ui/`; die Migration der hier beschriebenen Verträge ist geplant.

| Bauteil (Zielname) | Zweck | geplante Regeln | Nicht verwenden für |
|---|---|---|---|
| **PageHeader** / `ModuleStatusSwitch` | Kopf einer Modulseite: Titel, An/Aus, Badges, Meta, Aktionen | Reihenfolge 9.5; Schalter beschriftet „Aktiv“/„Pausiert“; Sperrhinweis in der Metazeile | Seiten ohne Modul (direkt `ToolPage`/`SettingsPage`) |
| **SaveStatus** | Speicher-Cluster: Statustext, Verwerfen, Speichern, Strg/Cmd+S, Fehler + „Erneut versuchen“ | feste Breite; Zustände `saved`/`dirty`/`saving`/`error`; Gold nur „Speichern“; Shortcut nur wenn sichtbar und ungespeichert | Sofortaktionen, Module an/aus (kein Entwurf) |
| **HeaderActions** | rechte Kopfseite: Cluster + Seitenaktionen + „…“-Popover | „…“ per Portal, schließt bei Klick | Aktionen, die immer sichtbar sein müssen |
| **CollectionPage** | Liste + Detail | Liste 360px, Werkzeugleiste oben; Detail scrollt intern; Leerzustand integriert | Seiten mit nur einem Objekt |
| **SettingsPage** | Spaltenseite mit Kopf | 1–4 Spalten, jede scrollt intern | Liste/Detail |
| **ToolPage** | Werkzeug mit voller Fläche | Kopf wie 9.5, `tool-page__body` füllt den Rest | Formularseiten |
| **Section** | Abschnitt mit Titel (13px/600) und Haarlinie | `h2`; keine Section in Section | Gruppierung einzelner Felder |
| **TemplateTextField** | Mehrzeiliges Textfeld mit Variablen | Variablen als Token (Brand, Tooltip beim Überfahren, Textfarbe bleibt); `{` öffnet Picker; unbekannte Variable erhält Fehlerzeile und Korrekturaktion; **kein RE2 hier** | Regex-Eingaben, einzeilige Namen |
| **Field** | Einheitlicher Feldrahmen für Eingaben | Label, Feldinhalt, feste Hinweis-/Fehlerzeile; 32px Controls; keine Sonderrahmen um Feldgruppen | Abschnittsgruppierung |
| **SwitchRow** | Einheitliche einfache Zeilenschalter | Gleiche Schalterdarstellung für gleichrangige Optionen | Felder, die beim Einschalten Inhalt zeigen |
| **SwitchSection** | Optionale Felder unter einem Abschnittsschalter | Schalter in der Überschrift; aus = Überschrift + eine Hinweiszeile, an = Felder darunter | Sofortige Modulaktivierung |
| **RoleThreshold** | Mindestrolle für Chataktionen | Select „Mindestrolle“ plus Zeile mit eingeschlossenen Rollen | Modulinterne Rollenlisten |
| **ChatPreview** | „Vorschau“ mit Beispieldaten | zwei reservierte Zeilen, nur Anzeige | echte Nachrichten |
| **ChatTargetField** | Ein gemeinsames „Chat-Ziel“-Feld | Portal-Popover mit Auswahl und Erklärung je Ziel | andere Auswahlen |
| **DataTable** | Protokoll, Kanalereignisse und Live-Ereignisse | eine Filterzeile; Zeit, Modul, Wer/Was, Art; relative Zeit bleibt sichtbar | Formulare |
| **ChatCommandsHelp** | Syntaxhilfe für eingebaute Chatbefehle | „Chatbefehle · n“ im Seitenkopf, Beschreibung, Mindestrolle, Argumente und Kopieraktion | Module ohne Chatbefehle |
| **TokenChip** | Sichtbarer Vorlagen-Token | kompakte Chipdarstellung, z. B. `{api.sonnenuntergang}` | Fließtext |
| **UnitInput** | Zahl + Einheit mit Schnellchips | Einheit fest im Feld, Chips als Vorschläge, reservierte Ladezeile | Freitext |
| **SegmentChoice** | 2–4 gleichwertige Optionen, eine aktiv | `aria-pressed`; aktive Option Brand | Aktionen, > 4 Optionen |
| **ChoiceCards** | wenige Optionen mit Erklärung | Titel + Beschreibung + Haken; gewählt = Brand-Rahmen | Optionen ohne Erklärung |
| **ChipsInput** | Liste kurzer Werte (z. B. Aliasse) | Enter/Komma fügt hinzu, Backspace entfernt letzten, Chips mit X | Spiele (dann `GameMultiSelect`) |
| **GameMultiSelect** | Twitch-Kategorien wählen | Chips im Feld; Vorschläge und Suche mit Status; Tastatur | andere Mehrfachauswahlen |
| **StepDialog** | geführte Einrichtung in Schritten | Abschnitt 11.1 | Einzelne Eingaben, Bestätigungen |
| **StatusLed** | Punkt (8px) + Wort | Zustände `ok`/`loading`/`warn`/`error`/`off`; Wort immer | Kategorie-Badges |
| **FieldError** | reservierte Fehlerzeile | immer gerendert | seitenweite Fehler |
| **LockedReason** | Sperrgrund mit Schloss | reserviert Platz auch ohne Sperre | allgemeine Hinweise |
| **RuleNote** | Regelhinweis (Info-Symbol, neutraler 1px-Rahmen rundum, einheitlicher Radius, keine Leiste) | neutral, keine Zustandsfarbe | Warnungen, Fehler |
| **TwitchReconnectDialog** | geführte Wiederverbindung (Berechtigungen, Bestätigung, Ergebnis) | erreichbar aus System und aus gesperrter Werbung | andere Verbindungen |

### 11.1 StepDialog

- Aufbau von oben: Titel, Schritttitel (`step-dialog__step-title`), Untertitel, **Schrittanzeige** (`ol[aria-label="Dialogfortschritt"]`, aktiver Schritt `aria-current="step"`, Zahl bzw. Haken), **Hilfezeile** („So funktioniert’s“, Linkfarbe), Inhalt, Fuß.
- **Ziel:** Dialog `min(760px, 100dvh − 32px)` hoch; Schrittwechsel ändert weder Dialog- noch Inhaltshöhe. Ein entsprechender Test ist geplant.
- Fuß: links „Zurück“ (outline, im ersten Schritt deaktiviert) und „Abbrechen“ (ghost); rechts **goldenes** „Weiter“ bzw. „Fertig“ (Text `--color-on-gold`).
- Enter in einem Eingabefeld geht weiter; Esc oder X fragt vor dem Verwerfen nach, sobald Schritt > 1 oder editiert („Einrichtung abbrechen?“ / „Weiter bearbeiten“ / „Verwerfen“).
- **Ziel:** höchstens zwei verschachtelte Rahmen. Ein entsprechender Test ist geplant.
- Unter 640px entfällt die Schrittbeschriftung, der Fuß stapelt.
- Einsatz: **In OBS einbinden** (Overlay wählen, Link kopieren, Verbindung testen), **Neue Datenquelle** (Adresse, Wert im JSON-Baum wählen, Name), **Twitch neu verbinden**, **Kanal einrichten** (Standort, Module wählen, Erster Textbefehl).

## 12. Geplantes Live-Cockpit

### 12.1 Sofortaktionen-Vertrag (geplant)

Das Zielsystem sieht Sofortaktionen (`ImmediateAction`) und Live-Kacheln (`LiveTile`) vor. Ein Vertrag, eine zentrale Registrierung und das Live-Cockpit sind noch nicht implementiert.

- Eine Aktion ist **aktiv**, wenn alle `requires` erfüllt sind (Stream an, Modul an), die Rolle reicht und keine Sperre greift.
- Eine gesperrte Aktion bleibt sichtbar und nennt den **Grund direkt am Knopf** (`action-card__reason`, reservierte Zeile).
- Ohne `content` führt `run()` sofort aus; mit `content` öffnet ein Popover (kurz: Werbung, Shoutout) oder Dialog (länger: Abstimmung).

### 12.2 Bauteile

| Bauteil | Zweck | Regeln |
|---|---|---|
| **ActionGrid** | Raster der Sofortaktionen (3 Spalten) mit Rollenanzeige | Rolle/Sperre/Zustand ergeben `reason`; Zähler „n Aktionen“ |
| **ActionFrame** | Rahmen einer Aktion (Karte + Popover/Dialog) | Kopf, Inhalt, reservierte Fehlerzeile, Fuß „Abbrechen“ + ein Goldbutton; Esc schließt und gibt den Fokus zurück |
| **LiveTiles** | Kacheln für laufende Vorgänge | Zustandsrahmen nach 3.1; Kachelpositionen bleiben stabil |
| **EventFeed** | Ereignisliste | Kategorieleiste je Ereignis (Ausnahme laut 3.1: Kategoriekodierung); Nutzername fett |
| **CockpitHeader** | Live-Pille, Laufzeit, Zuschauer, Streamtitel/Kategorie, Gesundheits-LEDs | Streamtitel nur für Verwalter änderbar; Offline zeigt „Twitch neu verbinden“ an fester Stelle |
| **Statuszeile** | `aria-live="polite"` Systemmeldung am Seitenende | fester Platz, kein Einschub |

## 13. Weitere Bausteine

### 13.1 Overlay-Editor

- Elementarten: generisches **Text**-Element mit gestylten Zeilen (`lines`, je Zeile Text und Stil) sowie **Spezialelemente** **Abstimmung** und **Votekick** (feste Struktur, eigene Eigenschaften). „Element hinzufügen“ bietet genau diese drei.
- Text-Element: Zeilen bleiben getrennt (keine Überlappung), Text passt in die Leinwand, Zeilenkarten scrollen im Eigenschaftenbereich (`overlay-properties__scroll`).
- Spezialelemente können Farben aus der Abstimmung übernehmen („Farben aus Abstimmung übernehmen“).
- Dynamische Werte (Wetter, Zähler) kommen über Variablen, nie als feste Zahlen.

### 13.2 Befehlspalette (geplant)

Cmd/Strg+K, Dialog „Seite suchen“, genau ein Suchsymbol, Fokusring 2px/Offset 2px, filtert Seiten, Pfeile + Enter öffnen. Auswahl: 1px Brand-Rahmen + Tönung, keine Leiste. Nicht für Aktionen (dafür Sofortaktionen).

### 13.3 Bestätigungsdialog

`UnsavedChangesDialog` („Änderungen verwerfen?“) und Löschbestätigungen: Standardweg „Weiter bearbeiten“ (ghost), destruktiver Button rot. **Nur hier ist Rot gefüllt**; außerhalb des Dialogs ist der Löschbutton rot umrandet (`.detail-delete-button`, Text `--color-error-text`). Dialoge dienen Bestätigungen und geführten Abläufen, nie Formularen.


## 14. Barrierefreiheit: aktuelle Tests und künftige Anforderungen

Aktuell erzwungen ist der Kontrasttest in `tests/unit/dashboard-ui-theme.test.ts`. Er prüft die folgenden gefüllten Farbpaare für beide Palette-Blöcke:

| Paar | Minimum |
|---|---|
| `--color-brand-on` auf `--color-brand`, `--color-brand-hover`, `--color-brand-press` | 4,5:1 |
| `--color-on-gold` auf `--color-gold`, `--color-gold-hover`, `--color-gold-press` | 4,5:1 |
| `--color-orange-on` auf `--color-orange` | 4,5:1 |
| `--color-on-error` auf `--color-error` | 4,5:1 |

Die folgenden Prüfungen sind **künftige Anforderungen** und werden derzeit nicht durch Tests erzwungen:

| Paar | Zielminimum |
|---|---|
| `--color-text`, `--color-text-2`, `--color-text-3` auf den Flächen-Tokens | 4,5:1 |
| `--color-border-control` auf `--color-background` und `--color-well` | 3:1 |
| `--color-focus` auf allen Flächen | 3:1 |
| `--color-gold-text` auf `--color-gold-soft` und `--color-background` | 4,5:1 |
| `--color-orange-text` auf `--color-orange-soft` und `--color-background` | 4,5:1 |
| Badge-Schrift auf Badge-Füllung | 4,5:1 |
| Abstimmungsfarben auf Balkenspur | 3:1 |
| Gold gegen Orange | Farbton ≥ 12°, RGB-Abstand ≥ 45 |

Weitere geplante Pflichten:

- **Fokus:** sichtbar, 2px, Offset 2px (Suchfelder: Ring am Wrapper); Fokus kehrt nach Popover/Dialog an den Auslöser zurück.
- **Farbe nie allein:** LED mit Wort, Zustands-Badge mit Wort, Gewählt mit Rahmen/Tönung/Haken, Fehler mit Text + Symbol, Abstimmung mit Beschriftung.
- **Tastatur:** Picker (`{`, Pfeile, Enter, Esc), `GameMultiSelect`, `StepDialog` (Enter/Esc), Strg/Cmd+S, Cmd/Strg+K.
- **Trefferfläche:** Bedienelemente ≥ 24px; geplantes Ziel: Button und Eingabe 32px, `sm` 28px nur in Listenzeilen; bei `(pointer: coarse)` mindestens 40px.
- `aria-live="polite"` für Fehlerzeilen, Statuszeile, Speicherstatus; `aria-busy` beim Laden; `aria-pressed`, `aria-current`, `role="switch"` nach Rolle.
- Kein Text unter 11px (siehe 16).

## 15. Durchsetzung

Der aktuelle Check führt `tests/unit/theme-color-lint.test.ts` und `tests/unit/dashboard-ui-theme.test.ts` aus. `tests/e2e/foundation-visual.spec.ts` kann Screenshots erfassen, aber keine Pixelvergleiche oder Layoutanforderungen automatisch bestätigen. Tests für Goldbutton-Anzahl, Seitenhöhe, Beschnitt, Kopfreihenfolge, Layoutstabilität und Dialoghöhe sind geplant.

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
- [ ] **Zustandsrahmen** nur an lebendigen Blöcken, keine Seitenleiste außer Toast, Speicherfehler und Kategoriemarke im Ereignis-Feed?
- [ ] **Eyebrow-Zeile**, mehr als drei Textebenen, Text < 11px, Emoji?
- [ ] **Spalten** zeilenweise ausgerichtet, Feldlabels vorhanden?
- [ ] **StepDialog:** höchstens zwei verschachtelte Rahmen, stabile Höhe, ein Goldbutton?
- [ ] **Alle Zustände** (bereit, lädt, Fehler, gesperrt, nicht verbunden, neu) ohne Sprung darstellbar?
- [ ] **Tastatur und Fokus** funktionieren, Farbe nie allein?

## 16. Geplante gemeinsame Seitenmuster

Diese Zielvorgaben beschreiben künftige Konsistenzregeln für die bestehenden Dashboard-Bereiche; sie belegen nicht, dass die jeweiligen Seiten bereits migriert sind.

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
- Datensätze, Beispielkonten, URLs und Chatverläufe in Beispielen sind fiktiv. Inhalte und Statusänderungen sollen keine Ansicht selbstständig springen.

### 16.5 Seitenmuster

- Clips ist eine schmale Einspaltenseite ohne Videovorschau: Modusschalter und Status, „Clip erstellen“, „Letzte Clips“, danach `!clip`-Rollen-/Abklingzeiteinstellungen sowie die optionalen Abschnitte „Clip-Link im Chat posten“ und „Automatische Clips“.
- „Chatbefehle · n“ erscheint ausschließlich bei Abstimmung, Votekick und Clips. Verwaltung enthält Kanalereignisse unmittelbar vor Protokoll; ein „Pflichtmodul“-Badge erscheint nicht.
- Mitglieder zeigen Rollen in einer gemeinsamen Mitgliederansicht statt doppelter Rollenkarten. Vorschautexte für Live-Ereignisse behalten ihre Zahlen; Streamtitel werden als lokaler Entwurf bearbeitet. „Verwerfen“ stellt auf jeder Seite den letzten gespeicherten Stand wieder her.
