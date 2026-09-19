---
name: BroBot Panel
description: Stream-Deck-Betriebsoberfläche — Module als beleuchtete Tasten auf Mattschwarz mit warmem Grau
colors:
  grund: "#141312"
  rail: "#181716"
  taste: "#1e1c1a"
  taste-hover: "#262321"
  inspektor: "#1a1917"
  rinne: "#100f0e"
  linie: "#312e2b"
  linie-stark: "#403c38"
  linie-hell: "#68615a"
  text: "#f2efeb"
  text-2: "#b3aca4"
  text-3: "#8b857e"
  text-4: "#615c56"
  marke: "#538dcc"
  marke-hover: "#659cd7"
  marke-press: "#4c80bc"
  marke-text: "#9bc3ed"
  marke-linie: "#60758c"
  marke-auf: "#0a0c10"
  tint-1: "#172638"
  tint-2: "#14202e"
  gruen: "#3ddc84"
  gruen-grund: "rgba(61, 220, 132, 0.12)"
  warn: "#d9a441"
  warn-grund: "rgba(217, 164, 65, 0.09)"
  fehler: "#e2564d"
  fehler-grund: "rgba(226, 86, 77, 0.09)"
typography:
  modultitel:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  abschnitt:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
  tastenname:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  feldname:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: "normal"
  led-wort:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
  schienenetikett:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "normal"
  spaltenkopf:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.06em"
  zahl:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  control: "6px"
  container: "12px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "20px"
  s6: "24px"
  s8: "32px"
  s10: "40px"
  s12: "48px"
components:
  modul-taste:
    backgroundColor: "{colors.taste}"
    textColor: "{colors.text}"
    typography: "{typography.tastenname}"
    rounded: "{rounded.container}"
    padding: "14px 10px 12px"
    width: "132px"
    height: "132px"
  modul-taste-hover:
    backgroundColor: "{colors.taste-hover}"
    textColor: "{colors.text}"
  modul-taste-aus:
    backgroundColor: "{colors.taste}"
    textColor: "{colors.text-3}"
  schienen-taste:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.text-3}"
    typography: "{typography.schienenetikett}"
    rounded: "{rounded.container}"
    padding: "7px 3px"
    width: "64px"
    height: "64px"
  schienen-taste-hover:
    backgroundColor: "{colors.taste-hover}"
    textColor: "{colors.text}"
  schienen-taste-aktiv:
    backgroundColor: "{colors.tint-2}"
    textColor: "{colors.marke-text}"
  button:
    backgroundColor: "{colors.taste}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
  button-hover:
    backgroundColor: "{colors.taste-hover}"
    textColor: "{colors.text}"
  button-primary:
    backgroundColor: "{colors.marke}"
    textColor: "{colors.marke-auf}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.marke-hover}"
    textColor: "{colors.marke-auf}"
  button-primary-active:
    backgroundColor: "{colors.marke-press}"
    textColor: "{colors.marke-auf}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.control}"
    padding: "10px 16px"
    height: "44px"
  button-quiet-hover:
    backgroundColor: "{colors.fehler-grund}"
    textColor: "{colors.fehler}"
  input:
    backgroundColor: "{colors.rinne}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
    height: "44px"
  tabellenzeile:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.zahl}"
    padding: "8px 10px"
    height: "34px"
  tabellenzeile-gewaehlt:
    backgroundColor: "{colors.tint-1}"
    textColor: "{colors.text}"
  modulkopf-symbol:
    backgroundColor: "{colors.tint-1}"
    textColor: "{colors.marke-text}"
    rounded: "{rounded.container}"
    width: "56px"
    height: "56px"
---

# Design System: BroBot Panel

<!-- impeccable:design-schema 1 -->

<!-- Aus dem gebauten Artefakt aufgezeichnet (src/dashboard/styles.css, main.tsx,
     module-panels.tsx, src/modules/textbefehle/panel). Richtungsvertrag:
     .impeccable/surfaces/src-dashboard-main-tsx.md, Welt „Stream Deck“, Seed f31be6ec.
     Ersetzt die frühere Fassung (Kategoriestandard Stripe/Cloudflare/Sentry) vollständig. -->

## Overview

**Creative North Star: „Das Stream Deck“**

Das Panel ist ein Gerät, kein Dokument. Module sind beleuchtete Tasten in einem
Raster, nicht Zeilen in einer Tabelle und nicht Karten in einem Stapel. Eine
Taste ist ein Objekt: Sie trägt genau ein Symbol, einen Namen und eine LED mit
Wort — nie einen Absatz, nie ein verschachteltes Layout. Genau diese Grenze
unterscheidet die Taste vom Container, der am Vorgängerentwurf bemängelt wurde.
Das Gerät steht nachts auf dem zweiten Monitor neben OBS: Mattschwarz mit
warmem Grau, ein Grundton ohne Verlauf, feste Pixelmaße statt fluider Skalen,
weil Betriebsoberflächen bei gleichbleibender Auflösung gelesen werden.

Der Blick aufs Raster sagt, was läuft: Grün leuchtet, Aus ist gezeichnet.
Tastendruck ist die Signatur-Interaktion — die Taste sinkt (Skalierung 0,97,
120 ms), färbt sich grün getönt, die LED blendet in 160 ms um. Die Detailseite
in der Mitte wird von der Brotkrume geführt, hat einen Modulkopf mit Symbol
und Hauptschalter, und begrenzt ihren Inhalt auf 960 px. Die Schiene links
bleibt in jeder Breite ein Band fester 64×64-Tasten.

Abgelehnt wurde am 19. September 2026 der Kategoriestandard (Seitenleiste mit
Titelzeile und Tabelle): zu asketisch. Die Welt darf souverän sein, ohne bunt
zu werden — die einzigen Farben bedeuten Zustand oder markieren den Ort des
Bedieners.

**Key Characteristics:**
- Mattschwarz (#141312) mit warmen Graustufen; vier Textstufen, kein Verlauf, kein Schatten.
- Tasten sind Objekte mit 12 px Radius in dunklen Rinnen; Steuerelemente haben 6 px. Es gibt keinen dritten Radius.
- Zustand spricht in Grün, Bernstein, Rot — immer als LED mit Wort, nie Farbe allein. Aus ist neutral gezeichnet.
- Marke (Blau) markiert ausschließlich den Ort des Bedieners, nie Wichtigkeit.
- Archivo für alles; IBM Plex Mono mit Tabellenziffern nur für Zahlen und Befehlstoken.
- Eine Symbolfamilie: 24er-Viewbox, Strich 1,5, runde Enden, `fill: none`. Kein Emoji, keine zweite Familie.
- Feste Maße: Kopfleiste 56 px, Schiene 80 px, Schienentaste 64×64, Modultaste 132×132, Bedienelement 44 px, Tabellenzeile 34 px.

## Colors

Ein warmer, mattschwarzer Grundton in acht Abstufungen, eine Markenfarbe für den
Ort des Bedieners, drei Zustandsfarben. Sonst nichts.

### Primary
- **Marke** ({colors.marke}, Hover {colors.marke-hover}, Druck {colors.marke-press}): primäre Aktion, gewählte Taste im Raster (Rand), aktive Schienentaste (Rand), gewählte Tabellenzeile (2 px Innenkante links). Blau statt Twitch-Violett, damit BroBot als eigenes Werkzeug erkennbar bleibt.
- **Marke-Text** ({colors.marke-text}): Brotkrume, Befehlsname in der Tabelle, Modulkopf-Symbol, aktive Schienentaste, Fokusring (2 px, Abstand 2 px). Auf {colors.grund} der lesbare Bruder der Marke.
- **Marke-Auf** ({colors.marke-auf}): Text auf primärem Knopf.
- **Marke-Linie** ({colors.marke-linie}): gedämpfte Markenkante, wo eine volle Marke zu laut wäre.
- **Tint-1 / Tint-2** ({colors.tint-1} / {colors.tint-2}): Markenfarbe als Material — so entsättigt, dass niemand sie Farbe nennt. Tint-1 füllt das Modulkopf-Symbol, die gewählte Tabellenzeile und die Textauswahl; Tint-2 die aktive Schienentaste, die gewählte Modultaste und Tabellenköpfe.

### Secondary (Zustand)
- **Grün** ({colors.gruen}, Fläche {colors.gruen-grund}): läuft, verbunden, gesund. LED-Punkt und LED-Wort, Symbolkachel einer eingeschalteten Taste, Schalter-Spur „an“. Grün steht nie ohne Wort daneben.
- **Bernstein** ({colors.warn}, Fläche {colors.warn-grund}): unbekannt oder nicht aktiv — Verbindung unklar, Modul ohne Zustand, Hinweiskasten `module-state--notice`. **Nicht** für „ausgeschaltet“.
- **Rot** ({colors.fehler}, Fläche {colors.fehler-grund}): Fehler, Löschen. Formularfehler stehen in Rot mit vorangestelltem ×; der stille Löschknopf färbt sich erst beim Hinzeigen rot.

### Neutral
- **Grund** ({colors.grund}): Seitenhintergrund und Arbeitsfläche der Mitte.
- **Rail** ({colors.rail}): Kopfleiste und Schiene — eine Stufe heller als der Grund, durch eine Haarlinie getrennt.
- **Taste** ({colors.taste}, Hover {colors.taste-hover}): Tastenkörper, neutraler Knopf, Tabellenzeile beim Überfahren.
- **Rinne** ({colors.rinne}): das Dunkelste — Eingabefelder, Symbolkachel einer ausgeschalteten Taste, der Punkt einer LED „aus“. Die Rinne liegt tiefer als die Taste, deshalb liest sich die Taste als erhoben.
- **Inspektor** ({colors.inspektor}): reserviert für Inspektorflächen; im aktuellen Build noch nicht belegt.
- **Linie / Linie-Stark / Linie-Hell** ({colors.linie} / {colors.linie-stark} / {colors.linie-hell}): Haarlinie für Bereichs- und Zeilentrennung; stärkere Kante für Feld- und Knopfränder; hellste Kante beim Überfahren.
- **Text** ({colors.text}): Namen, Werte, Überschriften. **Text-2** ({colors.text-2}): Beschreibungen, Feldnamen, Tabellenantworten, LED-Wort ohne Zustand (8,27:1 auf Grund). **Text-3** ({colors.text-3}): Metadaten, Spaltenköpfe, Schienenetikett, ausgeschaltete Taste, Platzhalter (5,08:1 auf Grund, 4,65:1 auf Taste). **Text-4** ({colors.text-4}): Trenner, Datenalter, LED-Punkt und Schalter-Spur im Ruhezustand — nie für Fließtext.

### Named Rules
**Die Zwei-Rollen-Regel.** Marke markiert den Ort des Bedieners (Auswahl, Fokus, primäre Aktion, Verknüpfung). Zustand spricht in Grün, Bernstein, Rot. Das System spricht nie in Markenfarbe, und Zustand nie in Marke — die Rollen kollidieren strukturell nicht, nicht nur farbmetrisch.

**Die LED-mit-Wort-Regel.** Wo Zustand steht, steht eine LED (8 px Punkt) und ein Wort: „Läuft“, „Aus“, „Verbunden“. Farbe allein informiert nie. Grün ohne Wort ist ein Fehler, kein Stil.

**Die Aus-ist-neutral-Regel.** Ein ausgeschaltetes Modul ist kein Problem. Es bekommt eine gezeichnete LED (Rinne mit Text-4-Rand), Text-3 und keine Farbe. Bernstein bedeutet ausschließlich „unbekannt“ oder „nicht aktiv, obwohl es sollte“.

## Typography

**Display Font:** Archivo (mit ui-sans-serif, system-ui) — selbst gehostet, variabel 400–700, latin-Subset.
**Body Font:** Archivo.
**Label/Mono Font:** IBM Plex Mono 400 (mit ui-monospace) — `font-variant-numeric: tabular-nums`.

**Charakter:** Eine Grotesk mit technischer Ruhe, in einem festen 14-px-Raster, das nicht mitwächst. Die Hierarchie entsteht aus wenigen Größen zwischen 10 und 22 px und aus den vier Textstufen, nicht aus Größensprüngen. Es gibt keine Großüberschrift: Der Modultitel (22 px) ist die größte Schrift im System.

### Hierarchy
- **Modultitel** (600, 22 px, 1.25, −0.015 em): Überschrift des Modulkopfs auf der Detailseite und des Rasters.
- **Abschnitt** (600, 13 px): Inspektor-Abschnitte (`h2`/`h3`), Befehlsname im Sub-Inspector. Bewusst so klein wie der Fließtext — Gewicht trennt, nicht Größe.
- **Tastenname** (600, 13 px, eine Zeile, Ellipse): Name auf der Modultaste.
- **Body** (400, 13 px, 1.5): Beschreibungen (max. 70 ch), Zustandszeile, Brotkrume, Knopftext, Leerzustand.
- **Feldname** (500, 12 px, Text-2): Beschriftung über Feldern; Hinweis darunter 12 px, 400, Text-3.
- **LED-Wort** (600, 12 px): das Wort neben dem LED-Punkt, in Zustandsfarbe.
- **Schienenetikett** (400, 11 px, 1.1, Ellipse): Wort unter dem Symbol in der 64er-Taste; Modul-ID unter dem Modultitel.
- **Spaltenkopf** (600, 10 px, 0.06 em, Versalien, Text-3, auf Tint-2): einziger Versalien-Einsatz im System.
- **Zahl** (Plex Mono 400, 12 px, Tabellenziffern): Twitch-ID in der Kopfleiste, Abkühlzeit, Befehlstoken `!name`, Meta-Zeile „zuletzt“.

### Named Rules
**Die Mono-für-Zahlen-Regel.** Plex Mono ist die Schrift für Werte, die man abliest und vergleicht: Twitch-ID, Sekunden, Zeitstempel. Der Build dehnt sie auf den Befehlstoken (`!name`) aus, weil er ein wörtlich einzutippendes Zeichen ist. Für Namen, Beschreibungen und Etiketten ist Mono verboten.

**Die Feste-Skala-Regel.** Keine `clamp()`, keine Viewport-Einheiten in der Schrift. Schmale Fenster klappen das Gerüst um; die Schriftgrößen bleiben.

## Layout

Das Gerüst ist ein Gerät mit festen Maßen:

- **Kopfleiste** 56 px, Rail-Farbe, Haarlinie unten, Innenabstand 0 20 px, Spaltenraster `auto minmax(180px,1fr) auto auto auto`: Marke (18-px-Quadrat mit 2 px Marke-Text-Rand, 6 px Radius, Wortmarke 15 px/700), Kanalwahl (Select bis 280 px, 44 px hoch) mit Twitch-ID in Mono, LED mit Wort, Lebenszeichen („aktualisiert vor …“, Text-3, 12 px), Abmelden. Auf der Detailseite kommt der Hauptschalter als sechste Spalte hinzu.
- **Schiene** 80 px breit, Rail-Farbe, Haarlinie rechts, Innenabstand 12 px 8 px. Enthält senkrecht gestapelte 64×64-Tasten mit 8 px Lücke, zentriert. Zustandspunkt 7 px oben rechts nur für Warnung/Fehler.
- **Mitte** füllt den Rest; Innenabstand 28 px 32 px 40 px. Das Raster ist `repeat(4, 132px)` mit 12 px Lücke, linksbündig, nicht fluid. Die Detailseite ist auf `min(960px, 100%)` begrenzt: Brotkrume, Modulkopf (56-px-Symbolkachel + Titel + ID + Beschreibung, Haarlinie unten, 24 px Abstand), Hauptschalter-Zeile (18 px Innenabstand, Haarlinie), Inhalt, Zustandszeile (16 px Innenabstand, 6-px-Rahmen).
- **Abstandsrhythmus** 4-8-12-16-20-24-32-40-48. Bereiche trennt eine Haarlinie plus Abstand, nie ein Rahmen um alles.
- **Formulare** stapeln ihre Felder (Lücke 14–16 px, max. 40 rem); Zahleneingaben max. 9 rem. Aktionen stehen in einer Zeile mit Hinweis rechts daneben.
- **Kein rechtes Dock.** Der Sub-Inspector einer gewählten Tabellenzeile öffnet sich unter der Tabelle im selben Fluss.

**Schmal (≤ 768 px):** Kopfleiste zweizeilig (40 px + 40 px; mit Hauptschalter dreizeilig): Marke, LED, Abmelden oben; Kanalwahl über die volle Breite darunter. Das Lebenszeichen verschwindet. Die Schiene wird zu einem waagerechten, scrollbaren Band mit denselben 64×64-Tasten (Lücke 6 px). Das Raster wird zweispaltig, die Taste bleibt 132×132. Unter 420 px schrumpft nur die Rasterlücke auf 8 px.

**Container ≤ 640 px (Befehlstabelle):** Die Spalte „zuletzt“ verschwindet; der Wert wandert als Mono-Metazeile in den Sub-Inspector der gewählten Zeile.

**Die Trefferflächen-Regel.** Alleinstehende Bedienelemente (Knopf, Feld, Select, Schalter, Brotkrumen-Link) sind mindestens 44 px hoch. In dichten Tabellenzeilen gelten 34 px, weil Dichte dort ein Feature ist. Beides liegt über der AA-Untergrenze von 24 px.

## Elevation & Depth

Keine Schatten. Tiefe entsteht ausschließlich aus Tonstufen und Haarlinien: Die Rinne (#100f0e) liegt unter dem Grund (#141312), Rail (#181716) und Taste (#1e1c1a) darüber. Eine Taste wirkt erhoben, weil ihre Symbolkachel in der Rinne sitzt und ihr Rand eine Haarlinie ist. Eingabefelder liegen in der Rinne — man tippt in eine Vertiefung. Beim Überfahren hellt sich eine Taste um eine Stufe auf (#262321) und ihr Rand wird zur hellen Linie.

Bewegung ist die einzige „Tiefe“ im System: Tastendruck skaliert auf 0,97 in 120 ms (`ease`) und füllt die Taste mit 18 % Grün; LED-Punkt und LED-Wort blenden Farbe und Deckkraft in 160 ms; Schalter-Spur und -Knopf wandern in 160 ms. Unter `prefers-reduced-motion` fällt alles auf 0,01 ms.

### Named Rules
**Die Keine-Schatten-Regel.** Kein `box-shadow` als Tiefe, kein Verlauf, kein Schimmer. Die einzigen `inset`-Kanten sind die 2 px Markenkante der gewählten Tabellenzeile.

**Die Kein-Skelett-Regel.** Veraltete Werte bleiben mit 55 % Deckkraft stehen; nichts schimmert. Bewegung im Augenwinkel sieht neben einem laufenden Stream wie eine Änderung aus.

## Shapes

Genau zwei Radien. **Container-Radius** ({rounded.container}) für alles, was ein Objekt ist: Modultaste, Schienentaste, Symbolkacheln (44 px in der Taste, 56 px im Modulkopf), Hinweiskästen, Anmeldekarte. **Steuer-Radius** ({rounded.control}) für alles, was man bedient: Knöpfe, Felder, Selects, Fokusring, Zustandszeile, Markenquadrat. LED-Punkte, Schalter-Spur und Scrollbalken sind die einzigen Kreise/Pillen — sie sind Anzeigen, keine Formen.

Ränder sind 1 px Haarlinien in drei Stärken; ein Rahmen wird nie dicker, nur heller. Die Marke erscheint als Rand (gewählte Taste, aktive Schienentaste) oder als 2 px Innenkante (gewählte Zeile), nie als Füllung außer auf dem primären Knopf.

## Components

### Modultaste (Signatur)
Ein 132×132-Objekt im Raster; Link, kein Knopf. Innen dreizeilig: Symbolkachel 44×44 ({rounded.container}, Rinne, Glyph 25 px), Name (13 px/600, eine Zeile), LED mit Wort. Rand Haarlinie, Hintergrund Taste.
- **Läuft:** Symbolkachel grün auf 12 % Grün, LED grün + „Läuft“.
- **Aus:** Text-3, Symbolkachel Text-2 auf Rinne, LED gezeichnet + „Aus“. Keine Farbe.
- **Hover:** Hintergrund Taste-Hover, Rand Linie-Hell.
- **Gewählt** (`data-selected`): Rand Marke, Hintergrund Tint-2.
- **Druck:** Skalierung 0,97 in 120 ms, Rand und Füllung 18 % Grün.
- `aria-label` = „Name · Zustandswort“.

### Schienentaste
64×64, {rounded.container}, Symbol 20 px über Etikett 11 px (Zeilen 20 px + Rest, Lücke 4 px). Ruhe Text-3 auf Rail, Hover Text auf Taste-Hover, aktiv Marke-Text auf Tint-2 mit Markenrand, Druck wie Modultaste. Zustandspunkt 7 px oben rechts mit 1 px Rail-Rand, nur Bernstein/Rot.

### LED
`inline-flex`, Punkt 8 px + Wort 12 px/600, Lücke 7 px, min. 20 px hoch. Zustände `green`, `amber`, `red`, `off`. Aus: Punkt in Rinne mit Text-4-Rand, Wort Text-3. Übergang 160 ms auf Punkt und Wort. Auch die Verbindungs-LED in der Kopfleiste und die Zustandsplakette sind diese Bauform.

### Buttons
- **Form:** {rounded.control}, 44 px hoch, 10 px 16 px, 13 px/500.
- **Neutral:** Taste mit Linie-Stark-Rand; Hover Taste-Hover mit Linie-Hell.
- **Primär:** Marke mit Marke-Auf-Text, 600; Hover Marke-Hover, Druck Marke-Press. Genau einer pro Bereich.
- **Gedeckt:** Der Anlege-Knopf ist neutral, solange das Formular unvollständig ist, und wird erst mit gültigen Feldern primär; der Grund steht als Hinweis (Text-3, 12 px) direkt daneben.
- **Still (`quiet`):** transparent, Text-2, 12.5 px; erst beim Hinzeigen Rot auf Fehler-Grund mit 45 % Fehler-Rand. Für Löschen.
- **Gefahr (`danger`):** Rot ohne Rand; Hover Weiß auf Rot.
- **Deaktiviert:** 50 % Deckkraft, `not-allowed`.

### Schalter (Hauptschalter)
44×44 Trefferfläche, Spur 36×20 Pille auf Text-4, Knopf 14 px in Text; an: Spur Grün, Knopf um 16 px verschoben (160 ms). In der Kopfleiste mit Etikett links (12 px/600, Text-2). Für Bediener gesperrt (45 %) — der Sperrgrund steht als 11-px-Zeile direkt darunter, nicht als Meldung anderswo.

### Inputs / Fields
- **Stil:** Rinne mit Linie-Stark-Rand, {rounded.control}, 44 px hoch, 8 px 10 px; Textarea 88 px, senkrecht ziehbar; Zahl max. 9 rem.
- **Hover:** Rand Linie-Hell. **Fokus:** 2 px Marke-Text außen, Abstand 2 px.
- **Deaktiviert:** 55 % Deckkraft. **Fehler:** rote Zeile mit × unter den Aktionen, `role="alert"`.

### Tabelle mit Zeilenauswahl
`table-layout: fixed`, Zellen 34 px hoch, 8 px 10 px, 12 px, Haarlinie unten. Kopf 30 px, Spaltenkopf-Stil auf Tint-2. Erste Spalte Befehlstoken in Mono + Marke-Text, Antwort in Text-2 einzeilig mit Ellipse, Zahlen in Mono. Zeilen sind fokussierbar (`tabIndex`, Enter/Leertaste); Hover Taste, gewählt Tint-1 mit 2 px Markenkante links. Die gewählte Zeile öffnet ihren Sub-Inspector (Felder + Speichern/Löschen) unter der Tabelle.

### Brotkrume
13 px, Text-2; Link Marke-Text mit 44 px Trefferhöhe, Hover Text mit Unterstrich; Trenner Text-4; aktuelles Glied 600 in Marke-Text mit 20-px-Glyph davor.

### Modulkopf
56-px-Symbolkachel (Tint-1, Marke-Text, Glyph 28 px) neben Titel 22 px, ID 11 px Text-3, Beschreibung 13 px Text-2 max. 70 ch; Haarlinie unten.

### Zustandszeile
Rahmen {rounded.control}, 16 px Innenabstand, 13 px Text-2. `neutral`: Haarlinie, transparent. `notice`: 45 % Bernstein-Rand auf Warn-Grund — nur für unbekannt/nicht aktiv.

### Symbole
Eine Familie: `viewBox 0 0 24 24`, `fill: none`, `stroke: currentColor`, Strich 1,5, runde Enden und Ecken. Schiene 20 px, Taste 25 px, Modulkopf 28 px, Brotkrume 20 px. Inline-SVG, `aria-hidden`. Kein Emoji, keine Icon-Schrift, keine zweite Strichstärke.

## Do's and Don'ts

### Do:
- **Do** jede Zustandsanzeige als LED mit Wort bauen; Grün nur mit „Läuft“/„Verbunden“ daneben.
- **Do** neue Module als Taste ins Raster stellen: Symbol aus der Familie, Name, LED. Nichts weiter auf der Taste.
- **Do** genau zwei Radien verwenden: 12 px für Objekte, 6 px für Bedienelemente.
- **Do** alleinstehende Bedienelemente 44 px hoch machen, Tabellenzeilen 34 px.
- **Do** Werte in Plex Mono mit Tabellenziffern setzen (Twitch-ID, Sekunden, Zeit, Befehlstoken).
- **Do** die Detailseite auf 960 px begrenzen und Bereiche mit Haarlinie plus Abstand trennen.
- **Do** den Sperr- oder Fehlergrund an die Wirkung schreiben (Sperrgrund unter dem Schalter, Hinweis neben dem gedeckten Knopf).
- **Do** veraltete Werte mit 55 % Deckkraft stehen lassen.

### Don't:
- **Don't** ein ausgeschaltetes Modul bernstein färben. Aus ist neutral; Bernstein heißt unbekannt.
- **Don't** Markenfarbe für Zustand oder Wichtigkeit verwenden, und Zustandsfarbe für Auswahl.
- **Don't** Schatten, Verläufe oder Skelett-Schimmer einsetzen.
- **Don't** einen dritten Radius, eine dritte Schrift oder eine zweite Symbolfamilie einführen; kein Emoji.
- **Don't** eine Taste mit Absatz, Zähler oder verschachteltem Layout beladen — dann ist sie eine Karte.
- **Don't** Schriftgrößen an den Viewport koppeln; schmal klappt das Gerüst um, nicht die Schrift.
- **Don't** ein rechtes Dock bauen; der Inspector öffnet sich im Fluss unter der Tabelle.

### Offen: Phase 2 (Issue #81)
Übersicht, Kanal, System, Mitglieder und Ereignisse sind noch die alte Welt. Ihre Regeln in `styles.css` (232-px-Seitenleiste, `status-card`, `channel-card`, `member-table`, `page-heading`, Zustandsplakette in Versalien) sind **kein Teil dieses Systems** und stehen nur noch, bis die Seiten auf Schiene, Tasten und LED mit Wort umgebaut sind. Neue Oberflächen erben aus diesem Dokument, nicht aus jenen Blöcken.
