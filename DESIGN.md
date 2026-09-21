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
  fehler-text: "#e8655d"
  fehler-grund: "rgba(226, 86, 77, 0.09)"
  gemeinschaft: "#c4a3f5"
  gemeinschaft-grund: "rgba(196, 163, 245, 0.12)"
  raid: "#f4a2d3"
  raid-grund: "rgba(244, 162, 211, 0.12)"
  moderation: "#5cc9c4"
  moderation-grund: "rgba(92, 201, 196, 0.12)"
typography:
  grundgroesse:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  modultitel:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  bereichstitel:
    fontFamily: "Archivo, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "normal"
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
  kanal-taste:
    backgroundColor: "{colors.taste}"
    textColor: "{colors.text}"
    typography: "{typography.tastenname}"
    rounded: "{rounded.container}"
    padding: "14px 10px 12px"
    width: "132px"
    height: "132px"
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
  button-tabelle:
    backgroundColor: "{colors.taste}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 12px"
    height: "34px"
  input:
    backgroundColor: "{colors.rinne}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "8px 10px"
    height: "44px"
  config-section:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body}"
  config-field-schmal:
    maxWidth: "9rem"
    description: "Zahlen und kurze Werte"
  config-field-mittel:
    maxWidth: "20rem"
    description: "Namen und Bezeichner"
  config-field-breit:
    maxWidth: "40rem"
    description: "Fließtext"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.fehler}"
    rounded: "{rounded.control}"
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
  zustand-zeile:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "16px"
    height: "58px"
  zustand-zeile-warnung:
    backgroundColor: "{colors.warn-grund}"
    textColor: "{colors.text}"
  zustand-zeile-fehler:
    backgroundColor: "{colors.fehler-grund}"
    textColor: "{colors.text}"
  sub-inspector:
    backgroundColor: "{colors.inspektor}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "18px 16px"
  inspektor-spalte:
    width: "592px"
    description: "Fließtextfeld 40 rem plus 2 × 16 px Innenabstand; Inspektor neben seiner Liste ab 1360 px Fensterbreite"
  eigenschaft:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    padding: "10px 0"
  seitenkopf-symbol:
    backgroundColor: "{colors.tint-1}"
    textColor: "{colors.marke-text}"
    rounded: "{rounded.container}"
    width: "56px"
    height: "56px"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.led-wort}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "20px"
  chip-zahl:
    backgroundColor: "{colors.rinne}"
    textColor: "{colors.text}"
    typography: "{typography.zahl}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "20px"
  chip-gemeinschaft:
    backgroundColor: "{colors.gemeinschaft-grund}"
    textColor: "{colors.gemeinschaft}"
  chip-raid:
    backgroundColor: "{colors.raid-grund}"
    textColor: "{colors.raid}"
  chip-moderation:
    backgroundColor: "{colors.moderation-grund}"
    textColor: "{colors.moderation}"
---

# Design System: BroBot Panel

<!-- impeccable:design-schema 1 -->

<!-- Aus dem gebauten Artefakt aufgezeichnet (src/dashboard/styles.css, main.tsx,
     members.tsx, module-panels.tsx, modules.tsx, locale.ts, src/modules/textbefehle/panel).
     Richtungsvertrag: .impeccable/surfaces/src-dashboard-main-tsx.md, Welt „Stream Deck“,
     Seed f31be6ec. Phase 1 (Module, Modulseite) am 19./20. September 2026, Phase 2
     (Übersicht, Kanal, System, Mitglieder, Ereignisse; Issue #81) am 20. September 2026.
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
120 ms), färbt sich grün getönt, die LED blendet in 160 ms um. Jede Seite
beginnt mit demselben Seitenkopf (56-px-Symbolkachel, Titel, Unterzeile). Jeder
Block — Tabelle, Formular, Zustandsliste, Eigenschaftenliste — ist höchstens
960 px breit, weil das seine Lesebreite ist. Eine Seite darf genau zwei Blöcke
nebeneinander stellen: eine Liste und den Inspektor ihrer gewählten Zeile. Mehr
Breite gibt es nicht, weil kein Inhalt sie braucht. Die Schiene links bleibt in
jeder Breite ein Band fester 64×64-Tasten.

Seit Phase 2 gilt das Gerät auf allen fünf Seiten: Die Übersicht zeigt Kanäle
als Tasten, Kanal und System sprechen in Zustandszeilen (LED + Wort + Detail +
Aktion), Mitglieder, Audit und Ereignisse liegen in einer gemeinsamen Tabelle,
deren gewählte Zeile ihren Sub-Inspector öffnet — neben der Tabelle, wo Platz
ist, sonst darunter. Die alte
Welt (232-px-Seitenleiste, Zustandskarten, Versalien-Plaketten) ist aus dem
Stylesheet entfernt.

Abgelehnt wurde am 19. September 2026 der Kategoriestandard (Seitenleiste mit
Titelzeile und Tabelle): zu asketisch. Die Welt darf souverän sein, ohne bunt
zu werden — die einzigen Farben bedeuten Zustand oder markieren den Ort des
Bedieners.

**Key Characteristics:**
- Mattschwarz (#141312) mit warmen Graustufen; vier Textstufen, kein Verlauf, kein Schatten.
- Tasten sind Objekte mit 12 px Radius in dunklen Rinnen; Steuerelemente haben 6 px. Es gibt keinen dritten Radius.
- Zustand spricht in Grün, Bernstein, Rot — immer als LED mit Wort, nie Farbe allein. Aus ist neutral gezeichnet. Herkunft spricht in Violett, Magenta, Türkis — nur im Art-Chip des Ereignisprotokolls.
- Marke (Blau) markiert ausschließlich den Ort des Bedieners, nie Wichtigkeit.
- Archivo für alles; IBM Plex Mono mit Tabellenziffern nur für Zahlen, Zeitstempel, IDs und Befehlstoken.
- Eine Symbolfamilie: 24er-Viewbox, Strich 1,5, runde Enden, `fill: none`. Kein Emoji, keine zweite Familie.
- Feste Maße: Kopfleiste 56 px, Schiene 80 px, Schienentaste 64×64, Modul-/Kanaltaste 132×132, Bedienelement 44 px, Tabellenzeile 34 px, Zustandszeile 58 px, Zustands-Etikettspalte 240 px.

## Colors

Ein warmer, mattschwarzer Grundton in acht Abstufungen, eine Markenfarbe für den
Ort des Bedieners, drei Zustandsfarben, drei Herkunftsfarben für das
Ereignisprotokoll. Sonst nichts.

### Primary
- **Marke** ({colors.marke}, Hover {colors.marke-hover}, Druck {colors.marke-press}): primäre Aktion, gewählte Taste im Raster (Rand), aktive Schienentaste (Rand), gewählte Tabellenzeile (2 px Innenkante links). Blau statt Twitch-Violett, damit BroBot als eigenes Werkzeug erkennbar bleibt.
- **Marke-Text** ({colors.marke-text}): Brotkrume, Befehlsname in der Befehlstabelle, Seitenkopf-Symbol, aktive Schienentaste, Profil-Link in der Mitgliederliste (Unterstrich 40 %, beim Hinzeigen voll), Fokusring (2 px, Abstand 2 px). Auf {colors.grund} der lesbare Bruder der Marke.
- **Marke-Auf** ({colors.marke-auf}): Text auf primärem Knopf.
- **Marke-Linie** ({colors.marke-linie}): gedämpfte Markenkante, wo eine volle Marke zu laut wäre.
- **Tint-1 / Tint-2** ({colors.tint-1} / {colors.tint-2}): Markenfarbe als Material — so entsättigt, dass niemand sie Farbe nennt. Tint-1 füllt das Seitenkopf-Symbol, die gewählte Tabellenzeile und die Textauswahl; Tint-2 die aktive Schienentaste, die gewählte Modultaste und Tabellenköpfe.

### Secondary (Zustand)
- **Grün** ({colors.gruen}, Fläche {colors.gruen-grund}): läuft, verbunden, gesendet, gesund. LED-Punkt und LED-Wort, Symbolkachel einer eingeschalteten Taste, Schalter-Spur „an“. Grün steht nie ohne Wort daneben und kommt im Ereignisprotokoll nicht vor.
- **Bernstein** ({colors.warn}, Fläche {colors.warn-grund}): unbekannt oder nicht aktiv — Verbindung unklar, Modul ohne Zustand, Zustandszeile `warning`, Betrieb-Chip „Hinweis“ im Ereignisprotokoll (abgekühlt, unterdrückt, bereits vorhanden). **Nicht** für „ausgeschaltet“.
- **Rot** ({colors.fehler}, Fläche {colors.fehler-grund}): Fehler, Löschen. LED-Punkt, Zustandszeile `error`, Fehlerkasten und Formularfehler mit vorangestelltem ×. Die Löschhandlung trägt dauerhaft die Gefahr-Variante.
- **Fehler-Text** ({colors.fehler-text}): das LED-Wort bei rotem Punkt und das Wort des Betrieb-Chips „Fehler“. Eine Stufe heller als Rot, weil das 12-px-Wort auf Tint-1 (gewählte Zeile) sonst unter AA fällt: 4,71:1 auf Tint-1, 5,70:1 auf Grund. Für Flächen, Ränder und Punkte bleibt {colors.fehler}.

### Herkunft (Ereignisfamilien)

Jedes Ereignis im Protokoll gehört zu einer von vier Familien. Drei tragen eine
eigene Farbe, die vierte spricht in Zustand. Die Farbe erscheint ausschließlich
im Art-Chip der Ereigniszeile — nie auf Tasten, LEDs, Zustandszeilen oder
Knöpfen.

- **Gemeinschaft** ({colors.gemeinschaft}, Fläche {colors.gemeinschaft-grund}): Abo, Resub, Gift, Community-Gift, Ankündigung. Violett, weil Twitch Abos so färbt und Bediener die Zuordnung mitbringen. Als Wort auf gefülltem Chip 7,15:1 über Grund, 6,17:1 über Tint-2, 5,73:1 über Tint-1, 5,86:1 über Taste-Hover; gezeichnet 8,75:1 über Grund, 7,23:1 über Tint-1.
- **Raid** ({colors.raid}, Fläche {colors.raid-grund}): Raid und Shoutout, herein wie hinaus. Magenta — die hellste und lauteste der drei, weil ein Raid das seltenste Ereignis im Feed ist. Gefüllt 7,80:1 über Grund, 6,75:1 über Tint-2, 6,27:1 über Tint-1, 6,37:1 über Taste-Hover; gezeichnet 9,68:1 über Grund, 7,99:1 über Tint-1.
- **Moderation** ({colors.moderation}, Fläche {colors.moderation-grund}): Bann, Auszeit, Löschung, Verwarnung, AutoMod-Halt, Verdacht und ihre Aufhebungen. Türkis, eine Stufe dunkler als die anderen beiden, weil Moderation in einem vollen Chat häufig ist und nicht rufen darf. Nie Rot: Ein Bann ist kein Fehler. Gefüllt 7,58:1 über Grund, 6,56:1 über Tint-2, 6,03:1 über Tint-1, 6,22:1 über Taste-Hover; gezeichnet 9,37:1 über Grund, 7,74:1 über Tint-1.
- **Betrieb** (kein Token): alles, was der Bot tat oder nicht tat — Host-Meldungen, Moduldiagnosen, Befehle, Werbung. Spricht in Zustand: Fehler-Text „Fehler“, Bernstein „Hinweis“, Text-2 „Info“. Immer gezeichnet, nie gefüllt; Grün kommt im Protokoll nicht vor.

Innerhalb einer Familie gibt es genau zwei Stufen. **Voll** (Fläche 12 %, Rand
`color-mix` 45 % Familienfarbe auf Haarlinie, Wort in Familienfarbe) ist das
Tun: Abo, Raid herein, Bann. **Gezeichnet** (kein Grund, derselbe Rand,
dasselbe Wort) ist die Gegenrichtung: Ankündigung, Raid hinaus, Entbannt. Die
Art selbst steht als Wort im Chip. Farbton sagt Familie, Füllung sagt Richtung,
Wort sagt Art. Eine dritte Stufe trägt die Farbe nicht — auf Tint-1 und beim
Überfahren wäre sie von der gezeichneten nicht mehr sicher zu trennen.

Die Familien sitzen bei 177°, 264° und 324° zwischen den vergebenen Tönen 4°
(Rot), 39° (Bernstein), 147° (Grün) und 211° (Marke); der engste Abstand ist
Moderation–Grün mit 30°. **Eine vierte farbige Familie gibt es nicht** — der
Farbkreis ist voll. Ein neues Modul sortiert seine Ereignisse in Gemeinschaft,
Raid oder Moderation ein oder meldet Betrieb. Für Deuteranope werden Raid und
Moderation zu demselben hellen Grau-Blau (Kontrast zueinander 1,15:1),
Gemeinschaft bleibt satt-blau; die Familie ist deshalb immer auch am Wort
ablesbar, nie an der Farbe allein.

### Neutral
- **Grund** ({colors.grund}): Seitenhintergrund und Arbeitsfläche der Mitte.
- **Rail** ({colors.rail}): Kopfleiste und Schiene — eine Stufe heller als der Grund, durch eine Haarlinie getrennt.
- **Taste** ({colors.taste}, Hover {colors.taste-hover}): Tastenkörper, neutraler Knopf, Tabellenzeile beim Überfahren, Ergebnis- und Bestätigungskasten im Mitglieder-Inspector, Avatar-Platzhalter.
- **Rinne** ({colors.rinne}): das Dunkelste — Eingabefelder, Symbolkachel einer ausgeschalteten Taste, der Punkt einer LED „aus“, `pre`-Flächen im Sub-Inspector (Vorher/Nachher, Ereignis-JSON). Die Rinne liegt tiefer als die Taste, deshalb liest sich die Taste als erhoben.
- **Inspektor** ({colors.inspektor}): Fläche des Sub-Inspectors unter Audit- und Ereignistabelle — eine halbe Stufe über dem Grund, damit der geöffnete Bereich als eigener Block lesbar ist, ohne zur Taste zu werden.
- **Linie / Linie-Stark / Linie-Hell** ({colors.linie} / {colors.linie-stark} / {colors.linie-hell}): Haarlinie für Bereichs-, Zeilen- und Eigenschaftentrennung; stärkere Kante für Feld- und Knopfränder, gestrichelt für Leerzustände; hellste Kante beim Überfahren.
- **Text** ({colors.text}): Namen, Werte, Überschriften, Zustands-Etikett, Eigenschaftswerte, Zeilenkopf in Tabellen. **Text-2** ({colors.text-2}): Beschreibungen, Feldnamen, Tabellenantworten, Zustandsdetail, Seitenkopf-Unterzeile, LED-Wort ohne Zustand (8,27:1 auf Grund). **Text-3** ({colors.text-3}): Metadaten, Spaltenköpfe, Schienenetikett, Eigenschaftsnamen, Vorher/Nachher-Kopf, Login-Hinweis unter dem Mitgliedsnamen, ausgeschaltete Taste, Platzhalter (5,08:1 auf Grund, 4,65:1 auf Taste). **Text-4** ({colors.text-4}): Trenner, Datenalter, LED-Punkt und Schalter-Spur im Ruhezustand — nie für Fließtext.

### Named Rules
**Die Drei-Rollen-Regel.** Marke markiert den Ort des Bedieners (Auswahl, Fokus, primäre Aktion, Verknüpfung). Zustand spricht in Grün, Bernstein, Rot. Herkunft spricht in Violett, Magenta, Türkis — und nur im Art-Chip des Ereignisprotokolls. Keine Rolle leiht sich die Farbe einer anderen: Ein Bann ist nicht rot, ein Abo nicht grün, ein Raid nicht blau. Die Rollen kollidieren strukturell nicht, nicht nur farbmetrisch.

**Die LED-mit-Wort-Regel.** Wo Zustand steht, steht eine LED (8 px Punkt) und ein Wort: „Läuft“, „Aus“, „Verbunden“, „Fehler“, „Hinweis“, „Info“. Farbe allein informiert nie. Grün ohne Wort ist ein Fehler, kein Stil.

**Die Aus-ist-neutral-Regel.** Ein ausgeschaltetes Modul ist kein Problem. Es bekommt eine gezeichnete LED (Rinne mit Text-4-Rand), Text-3 und keine Farbe. Bernstein bedeutet ausschließlich „unbekannt“ oder „nicht aktiv, obwohl es sollte“.

**Die Ereignis-je-Code-Regel.** Familie, Stufe, Chip-Wort und Zahl eines Ereignisses stehen in `ereignisTon` (locale.ts) pro Ereigniscode — nie werden sie aus einem Namensmuster geraten („moderation.*“ → Moderation, „…fehler“ → rot). Ein Code ohne Eintrag bekommt den neutralen gezeichneten Chip „Unbekannt“ und seinen rohen Code in Mono. Sortierregel für neue Codes: Was im Kanal geschah, hat eine Familie; was der Bot tat oder nicht tat, ist Betrieb. Tun ist voll, Aufheben und Ausgehendes sind gezeichnet. Betrieb spricht in Zustand: Erwartbar-Unerwünschtes (abgekühlt, unterdrückt, bereits vorhanden) ist Bernstein „Hinweis“, Gescheitertes Fehler-Text „Fehler“, Gelungenes Text-2 „Info“. Grün ist kein Ereigniston mehr.

## Typography

**Display Font:** Archivo (mit ui-sans-serif, system-ui) — selbst gehostet, variabel 400–700, latin-Subset.
**Body Font:** Archivo.
**Label/Mono Font:** IBM Plex Mono 400 (mit ui-monospace) — `font-variant-numeric: tabular-nums`.

**Charakter:** Eine Grotesk mit technischer Ruhe, in einem festen 14-px-Raster, das nicht mitwächst. Die Hierarchie entsteht aus wenigen Größen zwischen 10 und 22 px und aus den vier Textstufen, nicht aus Größensprüngen. Es gibt keine Großüberschrift: Der Modultitel (22 px) ist die größte Schrift im System.

### Hierarchy
- **Grundgröße** (400, 14 px, 1.5): steht am `body`; alle Bauteile erben von hier, auch als rem-Basis. Bewusst keine Endstufe — Bauteile liegen bewusst darunter (12/13 px) oder darüber (22 px).
- **Modultitel** (600, 22 px, 1.25, −0.015 em): `h1` im Seitenkopf jeder Seite (Übersicht, Kanalname, System, Mitglieder, Ereignisse, Module, Modulname).
- **Bereichstitel** (600, 15 px): `h2` in der Bereichsüberschrift `section-heading` („Aktive Module“, „Audit-Log“, „Eigenschaften“, „Protokoll“, Leerzustand-Titel). Rechts daneben steht die Anzahl als Zahl in Mono.
- **Abschnitt** (600, 13 px): Inspektor-Abschnitte (`h2`/`h3` innerhalb `inspector-section__heading`), Titel des Sub-Inspectors (Aktion bzw. Ereignistext), Zustands-Etikett. Bewusst so klein wie der Fließtext — Gewicht trennt, nicht Größe.
- **Tastenname** (600, 13 px, eine Zeile, Ellipse): Name auf der Modul- und Kanaltaste.
- **Body** (400, 13 px, 1.5): Beschreibungen (max. 70 ch), Seitenkopf-Unterzeile, Eigenschaftswerte, Brotkrume, Knopftext, Leerzustand.
- **Feldname** (500, 12 px, Text-2): Beschriftung über Feldern; Hinweis darunter 12 px, 400, Text-3. Auch Zustandsdetail, Eigenschaftsnamen und Login-Hinweis stehen in 12 px.
- **LED-Wort** (600, 12 px): das Wort neben dem LED-Punkt, in Zustandsfarbe (bei Rot in Fehler-Text); auch das Wort im Art-Chip der Ereigniszeile, dort in Familienfarbe.
- **Schienenetikett** (400, 11 px, 1.1, Ellipse): Wort unter dem Symbol in der 64er-Taste; Modul-ID unter dem Modultitel; Sperrgrund unter dem Schalter; Vorher/Nachher-Kopf im Sub-Inspector (600, Text-3).
- **Spaltenkopf** (600, 10 px, 0.06 em, Versalien, Text-3, auf Tint-2): einziger Versalien-Einsatz im System.
- **Zahl** (Plex Mono 400, 12 px, Tabellenziffern): Twitch-ID in der Kopfleiste, Abkühlzeit, Befehlstoken `!name`, Meta-Zeile „zuletzt“, Zeitstempel und Nutzer-IDs in Audit und Ereignissen, Audit-Aktion, Audit-/Ereignis-ID, rohe Ereignis- und Modulcodes, Zähler neben Bereichstiteln, der Zahl-Chip der Ereigniszeile.

### Named Rules
**Die Mono-für-Zahlen-Regel.** Plex Mono ist die Schrift für Werte, die man abliest, vergleicht oder wörtlich eintippt: Twitch-ID, Sekunden, Zeitstempel, Befehlstoken (`!name`), Aktions- und Ereigniscodes, Datensatz-IDs. Ein Ereignis oder Modul, für das es ein lesbares Wort gibt, steht in Archivo; erst der unbekannte Code fällt auf Mono zurück. Für Namen, Beschreibungen und Etiketten ist Mono verboten.

**Die Feste-Skala-Regel.** Keine `clamp()`, keine Viewport-Einheiten in der Schrift. Schmale Fenster klappen das Gerüst um; die Schriftgrößen bleiben.

## Layout

Das Gerüst ist ein Gerät mit festen Maßen:

- **Kopfleiste** 56 px, Rail-Farbe, Haarlinie unten, Innenabstand 0 20 px, Spaltenraster `auto minmax(180px,1fr) auto auto auto`: Marke (18-px-Quadrat mit 2 px Marke-Text-Rand, 6 px Radius, Wortmarke 15 px/700), Kanalwahl (Select bis 280 px, 44 px hoch) mit Twitch-ID in Mono, LED mit Wort, Lebenszeichen („aktualisiert vor …“, Text-3, 12 px), Abmelden. Auf der Modulseite kommt der Hauptschalter als sechste Spalte hinzu.
- **Schiene** 80 px breit, Rail-Farbe, Haarlinie rechts, Innenabstand 12 px 8 px. Enthält senkrecht gestapelte 64×64-Tasten mit 8 px Lücke, zentriert. Zustandspunkt 7 px oben rechts nur für Warnung/Fehler.
- **Mitte** ist auf die Seitenbreite `--seiten-breite` 1576 px plus 32 px Seitenabstand begrenzt (`min(1640px, 100%)`), Innenabstand 24 px 32 px 40 px; der Modul-Arbeitsbereich hebt das auf und setzt 28 px 32 px 40 px. Die Seitenbreite ist 960 + 24 + 592: ein Block, eine Lücke, ein Inspektor. Jede Seite beginnt mit dem Seitenkopf (56-px-Symbolkachel + Titel + Unterzeile + optionale Aktionen rechts, Haarlinie unten über die ganze Seitenbreite, 24 px Abstand). Jeder Block darunter — Tastenraster, Zustandsliste, Eigenschaftenliste, Tabelle, Formular — bleibt auf `--dashboard-content-width` 960 px begrenzt: Das ist seine Lesebreite, nicht die Seite. 960 px war nie eine Eigenschaft der Seite, sondern immer die Breite, bei der eine Tabellenzeile, ein Formular oder eine Zustandszeile noch in einem Blick liegt; deshalb wird kein Block breiter, nur weil die Seite es ist. Das Tastenraster ist `repeat(4, 132px)` mit 12 px Lücke, linksbündig, nicht fluid. Zustandszeilen stapeln mit 8 px Lücke. Bereiche (`content-section`) tragen eine Bereichsüberschrift mit Haarlinie.
- **Inspektorbereich** (`.inspektor-bereich`): der Bereich, in dem eine Tabelle und der Inspektor ihrer gewählten Zeile liegen. Zwei direkte Kinder, Liste zuerst. Ab 1360 px Fensterbreite ist er ein Raster `minmax(600px, 960px) 592px` mit 24 px Lücke, `align-items: start`: links die Liste, rechts der Inspektor. Die 592 px sind hergeleitet, nicht gewählt: das Fließtextfeld `config-field--breit` (40 rem = 560 px) plus 2 × 16 px Innenabstand des Inspektors — die Spalte ist genau so breit, dass das breiteste Formularfeld hineinpasst. Die Schwelle 1360 px ist ebenso hergeleitet: 1360 − 80 (Schiene) − 64 (Seitenabstand) = 1216 = 600 (Tabellenminimum) + 24 + 592. Zwischen 1360 und 1720 px wächst nur die Listenspalte von 600 auf 960; darüber steht sie fest. Unter 1360 px ist der Bereich eine Spalte mit 16 px Lücke: der Inspektor unter der Liste, im Fluss — genau das heutige Verhalten, es gibt keine dritte Form. **Die Tabelle springt beim Wählen nicht:** Sie behält in beiden Formen ihre Breite, beim Öffnen wie beim Schließen des Inspektors bricht keine Spalte um, keine Ellipse wechselt, keine Zeile wandert unter dem Zeiger. In der Spalte haftet der Inspektor 16 px unter dem oberen Fensterrand (`sticky`) und scrollt innen, wenn er höher als das Fenster ist — sonst stünde das Detail einer tiefen Zeile außer Sicht. Die Spalte blendet nicht ein und schiebt nicht: Sie ist da oder nicht.
- **Kein rechtes Dock.** Es gibt keine dauerhafte rechte Spalte der Seite, die leer wartet. Der Inspektor gehört zu seiner Tabelle, nicht zur Seite; ohne gewählte Zeile bleibt die Spalte leer, auch wenn der Bereich ein Anlegen-Formular hat — das öffnet erst über den Plus-Knopf an der Bereichsüberschrift und belegt dann dieselbe Fläche wie der Inspektor, nie beide zugleich (siehe Sub-Inspector).
- **Zustandszeile** ist ein Vier-Spalten-Raster `240px auto minmax(0,1fr) auto`: Etikett in fester Spalte (`--zustand-label`), LED mit Wort, Detail einzeilig mit Ellipse, Aktion rechtsbündig. Mindesthöhe 58 px, Innenabstand 16 px.
- **Eigenschaftenliste** (`dl.eigenschaften`) ist zweispaltig; jedes Paar ist selbst ein Raster `1fr 1.3fr` mit 16 px Lücke, 10 px senkrechtem Abstand und Haarlinie unten. Werte sind einzeilig mit Ellipse.
- **Abstandsrhythmus** 4-8-12-16-20-24-32-40-48. Bereiche trennt eine Haarlinie plus Abstand, nie ein Rahmen um alles.
- **Formulare** stapeln ihre Felder (Lücke 14–16 px, max. 40 rem); Zahleneingaben max. 9 rem. Aktionen stehen in einer Zeile mit Hinweis rechts daneben. Der Mitglieder-Inspector setzt Suchfeld und Knopf in einer `form-row`.

**Schmal (≤ 768 px):** Kopfleiste zweizeilig (40 px + 40 px; mit Hauptschalter dreizeilig): Marke, LED, Abmelden oben; Kanalwahl über die volle Breite darunter. Das Lebenszeichen verschwindet. Die Schiene wird zu einem waagerechten, scrollbaren Band mit denselben 64×64-Tasten (Lücke 6 px). Das Raster wird zweispaltig, die Taste bleibt 132×132. Der Seitenkopf verliert seine dritte Spalte; Aktionen rutschen linksbündig in eine eigene Zeile. Die Eigenschaftenliste wird einspaltig; `form-row` und Ergebniskasten stapeln. Unter 420 px schrumpft nur die Rasterlücke auf 8 px.

**Eng (≤ 639 px):** Die Zustandszeile bricht um: Etikett über die volle Breite, darunter LED und mehrzeiliges Detail, Aktion linksbündig in eigener Zeile. Der Sub-Inspector zeigt Vorher und Nachher untereinander. Tabellen geben ihre Mindestbreite von 600 px auf und verstecken die dritte Spalte (Audit „Wer“, Ereignis „Modul“). Eng gilt je Block, nicht nur je Fenster: Der Inspektor ist ein benannter Container (`inspektor`), und seine Inhalte — Vorher/Nachher, Zustandszeile, Tabelle, Eigenschaftenliste — wenden dieselben Eng-Regeln ab 639 px *Inspektorbreite* an. In der 592-px-Spalte sind sie deshalb immer eng: Vorher und Nachher stehen untereinander, eine Zustandszeile bricht um, eine Tabelle gibt ihr 600-px-Minimum auf.

**Container ≤ 640 px (Befehlstabelle):** Die Spalte „zuletzt“ verschwindet; der Wert wandert als Mono-Metazeile in den Sub-Inspector der gewählten Zeile. Container ist die Listenspalte (`inspektor-bereich__liste`, benannt `liste`), nicht das Panel — sonst blendet das Panel bei 1216 px die Spalte ein, während die Liste nur 600 px hat.

**Die Trefferflächen-Regel.** Alleinstehende Bedienelemente (Knopf, Feld, Select, Schalter, Brotkrumen-Link) sind mindestens 44 px hoch. In dichten Tabellenzeilen gelten 34 px — auch für Select und Knopf in der Aktionsspalte —, weil Dichte dort ein Feature ist. Beides liegt über der AA-Untergrenze von 24 px.

## Elevation & Depth

Keine Schatten. Tiefe entsteht ausschließlich aus Tonstufen und Haarlinien: Die Rinne (#100f0e) liegt unter dem Grund (#141312), Rail (#181716), Inspektor (#1a1917) und Taste (#1e1c1a) darüber. Eine Taste wirkt erhoben, weil ihre Symbolkachel in der Rinne sitzt und ihr Rand eine Haarlinie ist. Eingabefelder und `pre`-Flächen liegen in der Rinne — man tippt und liest in eine Vertiefung. Der Sub-Inspector liegt eine halbe Stufe über dem Grund. Beim Überfahren hellt sich eine Taste um eine Stufe auf (#262321) und ihr Rand wird zur hellen Linie. Die Inspektorspalte haftet beim Scrollen; das ist keine Bewegung, sondern ein fester Ort.

Bewegung ist die einzige „Tiefe“ im System: Tastendruck skaliert auf 0,97 in 120 ms (`ease`) und füllt die Taste mit 18 % Grün; LED-Punkt und LED-Wort blenden Farbe und Deckkraft in 160 ms; Schalter-Spur und -Knopf wandern in 160 ms. Unter `prefers-reduced-motion` fällt alles auf 0,01 ms.

### Named Rules
**Die Keine-Schatten-Regel.** Kein `box-shadow` als Tiefe, kein Verlauf, kein Schimmer. Die einzigen `inset`-Kanten sind die 2 px Markenkante der gewählten Tabellenzeile.

**Die Kein-Skelett-Regel.** Veraltete Werte bleiben mit 55 % Deckkraft stehen (`.veraltet` um die Tabelle, sobald Audit, Ereignisse oder Mitglieder nachladen und schon Daten da sind); nichts schimmert. Beim ersten Laden ohne Daten steht eine Ladezeile in Text-2. Bewegung im Augenwinkel sieht neben einem laufenden Stream wie eine Änderung aus.

**Die Zwei-Überlagerungen-Regel.** Das System kennt genau zwei Arten überlagernder Fläche, keine dritte.

Die **aufklappende Liste** (`topbar__channel-list`, `position: absolute`, `z-index: 20`, `role="listbox"`) öffnet unter dem Brotkrumen-Umschalter für Kanal oder Modul. Sie ist flüchtig: an das geöffnete Bedienelement gebunden, sie schließt bei Auswahl, Escape oder Klick daneben und gibt den Fokus auf den Umschalter zurück. Davon gibt es heute zwei — Kanal und Modul —, und ein weiteres Brotkrumen-Segment, das umschaltbar wird, bekommt dieselbe Liste; sie ist ein etabliertes Bauteil, kein Sonderfall pro Umschalter.

Der **meldende Hinweis** (Neue-Ereignisse-Hinweis, `position: fixed`, `z-index: 10` — unter der aufklappenden Liste, weil eine geöffnete Liste eine offene Handlung ist und Vorrang hat) meldet etwas und nimmt nichts entgegen außer der einen Handlung, die ihn zugleich ausführt und schließt (Klick springt an den Anfang und löscht ihn damit). Davon gibt es genau einen. Die Ausnahme hat einen Grund, keine Bequemlichkeit: Ein Hinweis, der nur im Fluss der Liste stünde, wäre unsichtbar genau dann, wenn er gebraucht wird — während jemand weiter unten liest, wohin nichts nachrückt.

**Verboten bleibt die dritte Art:** eine überlagernde Fläche zum Bearbeiten, Bestätigen oder für ein Formular. Dafür bleibt es bei Sub-Inspector, Ergebnis- oder Bestätigungskasten im Fluss — Overlays dafür wurden ausdrücklich verworfen (Issue #130): Sie verdecken die Liste und bräuchten ein eigenes Bauteil mit Fokusfalle.

## Shapes

Genau zwei Radien. **Container-Radius** ({rounded.container}) für alles, was ein Objekt ist: Modul- und Kanaltaste, Schienentaste, Symbolkacheln (44 px in der Taste, 56 px im Seitenkopf), Leer- und Fehlerkästen, Ergebnis- und Bestätigungskasten, Anmeldekarte, Schalter-Spur und Scrollbalken (bei 20 bzw. 10 px Höhe wirkt der 12-px-Radius als Pille). **Steuer-Radius** ({rounded.control}) für alles, was man bedient oder was eine Anzeige ist: Knöpfe, Felder, Selects, Fokusring, Zustandszeile, Sub-Inspector, Markenquadrat, Avatar (28 px), LED-Punkt, Schalterknopf und Schienen-Zustandspunkt (bei 7–14 px wirkt der 6-px-Radius als Kreis). Es gibt keinen `9999px`-Wert mehr.

Ränder sind 1 px Haarlinien in drei Stärken; ein Rahmen wird nie dicker, nur heller. Leerzustände sind gestrichelt. Die Marke erscheint als Rand (gewählte Taste, aktive Schienentaste) oder als 2 px Innenkante (gewählte Zeile), nie als Füllung außer auf dem primären Knopf. Zustandsränder sind `color-mix` aus 45 % Zustandsfarbe und Haarlinie.

## Components

### Modultaste (Signatur)
Ein 132×132-Objekt im Raster; Link, kein Knopf. Innen dreizeilig: Symbolkachel 44×44 ({rounded.container}, Rinne, Glyph 25 px), Name (13 px/600, eine Zeile), LED mit Wort. Rand Haarlinie, Hintergrund Taste.
- **Läuft:** Symbolkachel grün auf 12 % Grün, LED grün + „Läuft“.
- **Aus:** Text-3, Symbolkachel Text-2 auf Rinne, LED gezeichnet + „Aus“. Keine Farbe.
- **Hover:** Hintergrund Taste-Hover, Rand Linie-Hell.
- **Gewählt** (`data-selected`): Rand Marke, Hintergrund Tint-2.
- **Druck:** Skalierung 0,97 in 120 ms, Rand und Füllung 18 % Grün.
- `aria-label` = „Name · Zustandswort“.

### Kanaltaste
Dieselbe `ModuleTaste`-Bauform auf der Übersicht, eine Taste pro freigegebenem Kanal: Kanal-Symbol aus der Familie, Anzeigename, LED mit Zustandswort des Kanals („Verbunden“, „Nicht verbunden“ …). `data-enabled` ist nur bei gesundem Kanal `true` (grüne Symbolkachel); `data-status` trägt den LED-Ton (green/amber/red/off), damit Warnung und Fehler auf der Taste sichtbar sind, ohne dass die Taste selbst Farbe annimmt. Führt zur Kanalseite. Ohne Kanal steht ein gestrichelter Leerzustand mit Bereichstitel.

### Schienentaste
64×64, {rounded.container}, Symbol 20 px über Etikett 11 px (Zeilen 20 px + Rest, Lücke 4 px). Ruhe Text-3 auf Rail, Hover Text auf Taste-Hover, aktiv Marke-Text auf Tint-2 mit Markenrand, Druck wie Modultaste. Zustandspunkt 7 px oben rechts mit 1 px Rail-Rand, nur Bernstein/Rot.

### LED
`inline-flex`, Punkt 8 px + Wort 12 px/600, Lücke 7 px, min. 20 px hoch. Zustände `green`, `amber`, `red`, `off`. Aus: Punkt in Rinne mit Text-4-Rand, Wort Text-3. Rot: Punkt Fehler, Wort Fehler-Text. Übergang 160 ms auf Punkt und Wort. Auch die Verbindungs-LED in der Kopfleiste und die LED der Zustandszeile sind diese Bauform. Die Ereigniszeile trägt keine LED mehr, sondern das Chip-Paar.

### Ereignis-Chip-Paar
Vor jedem Ereignistext — in der Tabelle wie im Verlauf des Sub-Inspectors — stehen bis zu zwei Chips: links die Zahl, rechts die Art. Beide 20 px hoch, 0 8 px Innenabstand, 1 px Rand, {rounded.control} — Anzeigen, keine Objekte. Lücke im Paar 4 px, zum Text 10 px (`event-label` bleibt `flex`; der Text dahinter einzeilig mit Ellipse). Kein Übergang, kein Zeiger, keine Hover-Regel; die Fläche ist Alpha und komponiert sich über Hover und gewählte Zeile.
- **Zahl-Chip:** Rinne, Haarlinie, Plex Mono 12 px mit Tabellenziffern in Text (16,71:1). Dauern mit Einheit („120 s“). Steht nur, wenn das Ereignis eine Zahl trägt — nie „0“, nie „—“. Ohne Zahl ist das Paar ein einzelner Chip.
- **Art-Chip (Familie):** LED-Wort-Typografie in Familienfarbe, Rand `color-mix` 45 % Familienfarbe auf Haarlinie; Stufe *voll* mit `<familie>-grund`, *gezeichnet* ohne. Wort ist die Art („Abo“, „Raid“, „Bann“), höchstens 12 Zeichen.
- **Art-Chip (Betrieb):** immer gezeichnet; Wort ist das Zustandswort in Fehler-Text (5,70:1 auf Grund, 4,71:1 auf Tint-1), Bernstein (8,25:1 / 6,81:1) oder Text-2 (8,27:1 / 6,82:1). Die gefüllte Fehler-Variante fiele auf Tint-1 auf 4,08:1 und ist deshalb verboten.
- Code ohne Eintrag: neutraler gezeichneter Chip „Unbekannt“, roher Code in Mono dahinter.

### Neue-Ereignisse-Hinweis (`realtime-feed__notice`)
Ein `.button` mit `position: fixed`, mittig unter der Kopfleiste (64 px von oben, `translateX(-50%)`, `z-index: 10`). Er meldet, dass neue Ereignisse eingetroffen sind, während der Bediener weiter unten im Protokoll liest — genau dort fügt die Liste sie nicht sichtbar ein, ein Zeileneinschub am unteren Bildschirmrand bliebe unbemerkt. Er trägt nur die Zahl und „neue Ereignisse“ (`aria-live="polite"`); ein Klick springt an den Anfang der Liste und ist zugleich die einzige Handlung, die ihn schließt — er löscht sich, sobald die Ereignisse eingeholt sind. Er erscheint ohne Übergang und verschwindet ohne Übergang, wie jede andere Zustandsänderung im System (siehe Kein-Skelett-Regel): Bewegung im Augenwinkel wäre neben einem laufenden Stream die teuerste Fehlinterpretation.

### Buttons
- **Form:** {rounded.control}, 44 px hoch, 10 px 16 px, 13 px/500. In einer Tabellenzelle 34 px hoch, 6 px 12 px.
- **Neutral:** Taste mit Linie-Stark-Rand; Hover Taste-Hover mit Linie-Hell.
- **Primär:** Marke mit Marke-Auf-Text, 600; Hover Marke-Hover, Druck Marke-Press. Genau einer pro Bereich. Auf der Kanalseite ist die Moderatorprüfung nur dann primär, wenn der Moderatorstatus fehlt (`dringend`); sonst neutral.
- **Gedeckt:** Der Anlege-Knopf ist neutral, solange das Formular unvollständig ist, und wird erst mit gültigen Feldern primär; der Grund steht als Hinweis (Text-3, 12 px) direkt daneben.
- **Still (`quiet`):** transparent, Text-2, 12.5 px; erst beim Hinzeigen Rot auf Fehler-Grund mit 45 % Fehler-Rand. **Für Löschen abgelöst am 20. September 2026 (Issue #112):** Die gefährlichste Handlung war dadurch im Ruhezustand die unauffälligste; `quiet` bleibt für nicht zerstörende, zurückhaltende Aktionen.
- **Gefahr (`danger`):** Rot ohne Rand; Hover Weiß auf Rot.
- Löschende Handlungen stehen mit `danger` dauerhaft in Fehlerfarbe, vom primären Knopf abgesetzt, und fragen anschließend in der bestehenden `inspector-confirmation` nach. Abbrechen bewirkt keine Mutation.
- **Nachladen (`secondary`):** neutraler Knopf mit 16 px Abstand nach oben, unter Tabellen („Ältere Einträge laden“).
- **Deaktiviert:** 50 % Deckkraft, `not-allowed`.

### Schalter (Hauptschalter)
44×44 Trefferfläche, Spur 36×20 auf Text-4, Knopf 14 px in Text; an: Spur Grün, Knopf um 16 px verschoben (160 ms). In der Kopfleiste mit Etikett links (12 px/600, Text-2). Für Bediener gesperrt (45 %) — der Sperrgrund steht als 11-px-Zeile direkt darunter, nicht als Meldung anderswo.

### Inputs / Fields
- **Stil:** Rinne mit Linie-Stark-Rand, {rounded.control}, 44 px hoch, 8 px 10 px; Textarea 88 px, senkrecht ziehbar; Select in Tabellenzellen 34 px.
- **Konfigurationsfeldbreiten:** `config-field--schmal` ist 9 rem für Zahlen und kurze Werte (die bestehende Zahlengrenze); `config-field--mittel` ist 20 rem für Namen und Bezeichner (die halbe bestehende Formularbreite); `config-field--breit` ist 40 rem für Fließtext (die bestehende maximal 40 rem breite Formularhülle). Die Stufe gehört an die Feldhülle, nicht an beliebige Einzelregeln.
- **Hover:** Rand Linie-Hell. **Fokus:** 2 px Marke-Text außen, Abstand 2 px.
- **Deaktiviert:** 55 % Deckkraft. **Fehler:** rote Zeile mit × unter den Aktionen, `role="alert"`.

### Konfigurationsfläche
Eine Modul-Panel-Ansicht liegt in `.module-stack`, damit Beschriftung, Feld,
Textarea, Select und Hinweistext die Welt erben; ohne diese Hülle erscheint sie
unformatiert. Jeder fachliche Abschnitt bekommt eine Überschrift und eine
Haarlinie über `.config-section` und `.section-heading`. Die Fläche bleibt im
Fluss: keine Container-Karten. Die Auswahl einer Tabellenzeile öffnet den
Bearbeiten-Teil auf der Inspektor-Fläche (`sub-inspector`) — neben der Tabelle,
wo die Seite breit genug ist, sonst darunter; die Tabelle und ihr Inspektor
liegen dafür als zwei direkte Kinder in einem `inspektor-bereich`.

### Seitenkopf (`ModuleHeading`)
Auf jeder Seite dasselbe Bauteil: Raster `56px minmax(0,1fr) auto`, 16 px Lücke, min. 56 px hoch, Haarlinie unten, 24 px Abstand darunter, Breite `min(960px, 100%)`. Links die 56-px-Symbolkachel (Tint-1, Marke-Text, Glyph 28 px) mit dem Seitensymbol aus der Schienenfamilie; Mitte Titel 22 px und Unterzeile 13 px Text-2 (Rolle, Anzahl mit Zahl in Mono, „nur lesend“, Beschreibung max. 70 ch); rechts optional Aktionen (`header-action`: Knopf, darunter rechtsbündig 11.5-px-Zeitangabe, Sperrgrund 11 px, Fehlerzeile). Auf der Modulseite steht davor die Brotkrume (44 px Trefferhöhe, 8 px Abstand).

### Zustandszeile (`ZustandZeile`)
Ein `article` mit `aria-label`, Raster `240px auto minmax(0,1fr) auto`, 12 px Lücke, min. 58 px, 16 px Innenabstand, {rounded.control}, Haarlinie, transparent. Etikett 13 px/600 Text; LED mit Wort (Ton `healthy`→grün, `warning`→bernstein, `error`→rot, `neutral`→aus); Detail 12 px Text-2 einzeilig mit Ellipse; Aktion rechtsbündig (Knopf, Link oder Sperrgrund).
- **`warning`:** Rand 45 % Bernstein auf Warn-Grund, Detail in Text.
- **`error`:** Rand 45 % Rot auf Fehler-Grund, Detail in Text.
- **`neutral` / `healthy`:** Haarlinie, keine Fläche. Gesund ist nicht grün hinterlegt — nur die LED leuchtet.
Zeilen stapeln in `zustand-liste` mit 8 px Lücke; Kanal und System verwenden dieselben Zeilenbauer (Sender, Chat, Moderator, Bot, Token, letzter Fehler).

### Eigenschaftenliste (`dl.eigenschaften`)
Lesende Werte, die kein Zustand sind (Gründe, Abo-ID, Gültig-bis): zweispaltig, Paar als Raster `1fr 1.3fr`, Name 12 px Text-3, Wert 13 px Text (Zeitstempel und IDs in Mono), 10 px senkrecht, Haarlinie oben und je Paar unten, Leerwert „—“. Unter 768 px einspaltig. Auch der Ereignis-Sub-Inspector nutzt sie für Code, Modul, Zeitstempel.

### Tabelle (`.tabelle`)
Allgemeine Bauform für Mitglieder, Audit, Ereignisse und Befehle (ersetzt `command-table`). `table-layout: fixed`, min. 600 px in scrollbarer `tabelle-wrap`, Zellen 34 px hoch, 8 px 10 px, 12 px, Haarlinie unten (letzte Zeile ohne). Kopf 30 px, Spaltenkopf-Stil auf Tint-2. Zeilenkopf (`th scope="row"`) in Text/600; nur die Befehlstabelle färbt ihn Marke-Text, weil das Token ein Link auf den Sub-Inspector ist. Spaltenbreiten je Tabelle in Prozent (`audit-tabelle` 22/48/30, `ereignis-tabelle` 22/40/18/20; Befehle 116 px/auto/64/88).
- **Wählbare Zeilen** tragen `tabIndex={0}` und `aria-selected`; nur `tr[tabindex]` bekommt Zeiger und Hover (Taste). Gewählt: Tint-1 mit 2 px Markenkante links; Fokus 2 px Marke-Text innen. Enter/Leertaste wählen. Ein Nachladen hebt die Auswahl auf.
- **Aktionsspalte** `tabelle__aktion`: rechtsbündig, Kopf mit `sr-only`-Text; Select und Knopf darin 34 px.
- **Mitgliederzeile:** `avatar-row` mit 28-px-Avatar ({rounded.control}, Platzhalter Taste mit Linie-Stark-Rand), Name in Text und Login-Hinweis 12 px Text-3 darunter (als Profil-Link in Marke-Text).
- **Nachladen:** Container `.veraltet` (55 %), darunter der Knopf „Ältere Einträge laden“.

### Sub-Inspector
Die Fläche für die gewählte Zeile einer Tabelle: 18 px 16 px Innenabstand, Haarlinie, {rounded.control}, Fläche Inspektor. Er ist das zweite Kind eines `inspektor-bereich`; seine Position bestimmt der Bereich, nicht er selbst: ab 1360 px Fensterbreite rechts neben der Liste in einer 592-px-Spalte (`--inspektor-breite`, das 40-rem-Fließtextfeld plus Innenabstand), haftend 16 px unter dem Fensterrand mit innerem Scrollen; darunter im Fluss unter der Liste mit 16 px Abstand, `min(960px, 100%)` breit.
- **Kopf** `inspector-section__heading`: Titel 13 px/600 links, Datensatz-ID in Mono Text-2, rechts die Schließen-Taste — 44 × 44, still (`quiet`), Symbol × aus der Familie (20 px), `aria-label` „Schließen“. Schließen hebt die Auswahl auf (`aria-selected="false"`) und gibt den Fokus an die Zeile zurück; Escape innerhalb des Inspektors tut dasselbe. Das ist die einzige Fokusregel: Beim Öffnen bleibt der Fokus auf der Zeile, damit Tastaturbedienung weiter durch die Liste laufen kann.
- **Auswahl bleibt** beim Nachladen bestehen, solange die Zeile noch existiert; verschwindet die Zeile, schließt der Inspektor. Nie schließt er von selbst, während der Bediener liest.
- **Inhalt ist eng:** Der Inspektor ist Container `inspektor`; seine Inhalte gelten ab 639 px Inspektorbreite als eng (siehe Layout). In der Spalte heißt das immer: Vorher und Nachher untereinander, Eigenschaftenliste einspaltig, Zustandszeile umgebrochen, Tabellen ohne Mindestbreite.
- **Audit:** `inspector-columns` — zwei Spalten `repeat(2, minmax(0,1fr))`, 16 px Lücke, Kopf „Vorher“/„Nachher“ 11 px/600 Text-3, darunter `pre` in der Rinne mit Haarlinie, min. 88 px, 10 px Innenabstand; eng untereinander.
- **Ereignis:** Eigenschaftenliste (Zeitstempel, Modul, Beteiligte) plus Verlauf mit `event-detail-json`: formatiertes JSON als `pre` in der Rinne, 12 px Innenabstand, 16 px Abstand.
- **Abonnement:** Eigenschaftenliste (Typ, Version, ID, Aktualisiert, Twitch-Meldung, HTTP-Status).
- **Befehl:** Felder + Speichern/Löschen, Meta-Zeile „zuletzt“, sobald die Listenspalte unter 640 px liegt.
- **Betreiber-Kanal:** Zustandszeile, Zustimmungsschalter, Einladungslink, Mitgliedertabelle, Mitglied hinzufügen — der längste Inspektor im System und der Grund für das innere Scrollen.
- **Ohne Auswahl bleibt die Spalte leer**, solange auch kein Anlegen-Formular offen ist — sie hat keinen Ruhezustand mehr, weder Formular noch Platzhalter.
- **Plus-Knopf** öffnet das Anlegen-Formular eines Bereichs (Befehl anlegen, Kanal freigeben), sofern es eines gibt: rechts in der `section-heading` der Liste, wo sonst die Anzahl steht — 44 × 44, still (`quiet`), Symbol + aus der Familie (20 px), `aria-label` nennt die Handlung. Ein Klick lässt das Formular in derselben Fläche wie der Inspektor erscheinen, mit derselben Kopfzeile und derselben Schließen-Taste, und es reagiert auf Escape wie er. Das ist neu gegenüber der alten Fassung: Vorher war das Formular der Ruhezustand, da hätte Schließen ins Leere geführt; jetzt hat man es aktiv geöffnet und muss es ebenso aktiv wieder loswerden können. Zeile wählen und Formular öffnen schließen einander aus, ohne Übergang und ohne Einblenden — die Spalte trägt immer nur eines von beidem. Ein Bereich hat so nie zwei primäre Knöpfe zugleich.
- **Scope-Listen sind keine Inspektoren.** Eine Liste fehlender Berechtigungen hat keine gewählte Zeile; sie ist ein Bereich im Fluss (`content-section` mit `section-heading` und `scope-liste`) und trägt die Klasse `sub-inspector` nicht. Wer die Inspektor-Fläche für einen Block ohne Auswahl leiht, baut ein Dock.
- **Mitglied:** Ergebniskasten (`inspector-result`, Taste, {rounded.container}, Avatar-Zeile + Rollenwahl + Knopf) und Bestätigungskasten (`inspector-confirmation`, 14-px-Titel) sind kein Sub-Inspector; beide bleiben im Fluss unter dem Suchformular.

### Brotkrume
13 px, Text-2; Link Marke-Text mit 44 px Trefferhöhe, Hover Text mit Unterstrich; Trenner Text-4; aktuelles Glied 600 in Marke-Text mit 20-px-Glyph davor. Nur auf der Modulseite.

### Leer- und Fehlerkasten
`empty-state` / `module-empty`: gestrichelter Linie-Stark-Rand, {rounded.container}, 18–20 px Innenabstand, Text-2, 13 px; Titel als Bereichstitel in Text. `error-panel`: durchgezogen, 45 % Rot auf Fehler-Grund, Titel in Rot.

### Symbole
Eine Familie: `viewBox 0 0 24 24`, `fill: none`, `stroke: currentColor`, Strich 1,5, runde Enden und Ecken. Schiene 20 px, Taste 25 px, Seitenkopf 28 px, Brotkrume 20 px. Seitensymbole (Übersicht, Kanal, System, Mitglieder, Module, Ereignisse) und Modulsymbole kommen aus derselben `NavigationIcon`/`iconFor`-Quelle. Inline-SVG, `aria-hidden`. Kein Emoji, keine Icon-Schrift, keine zweite Strichstärke.

## Do's and Don'ts

### Do:
- **Do** jede Zustandsanzeige als LED mit Wort bauen; Grün nur mit „Läuft“/„Verbunden“ daneben.
- **Do** neue Module und Kanäle als Taste ins Raster stellen: Symbol aus der Familie, Name, LED. Nichts weiter auf der Taste.
- **Do** jede Seite mit dem Seitenkopf beginnen und Zustand in Zustandszeilen, lesende Werte in der Eigenschaftenliste zeigen.
- **Do** ein neues Ereignis in eine der vier Familien einsortieren und Familie, Stufe, Wort und Zahl-Schlüssel pro Code in `ereignisTon` eintragen; ein Code ohne Eintrag bleibt „Unbekannt“, Betrieb bleibt gezeichnet.
- **Do** genau zwei Radien verwenden: 12 px für Objekte, 6 px für Bedienelemente und Anzeigen.
- **Do** alleinstehende Bedienelemente 44 px hoch machen, Tabellenzeilen und ihre Bedienelemente 34 px.
- **Do** Werte in Plex Mono mit Tabellenziffern setzen (Twitch-ID, Sekunden, Zeitstempel, IDs, Codes, Befehlstoken).
- **Do** jeden Block auf 960 px begrenzen und Bereiche mit Haarlinie plus Abstand trennen; nur Liste und Inspektor stehen nebeneinander.
- **Do** den Sperr- oder Fehlergrund an die Wirkung schreiben (Sperrgrund unter dem Schalter oder Knopf, Hinweis neben dem gedeckten Knopf).
- **Do** veraltete Werte mit 55 % Deckkraft stehen lassen; nur beim ersten Laden eine Ladezeile.
- **Do** wählbare Tabellenzeilen mit `tabIndex` und `aria-selected` bauen, Liste und Inspektor als zwei Kinder eines `inspektor-bereich` anlegen und jeden Inspektor wie auch ein per Plus-Knopf geöffnetes Anlegen-Formular mit Schließen-Taste und Escape wieder schließbar machen.
- **Do** Panel-Ansichten in `.module-stack` und Konfigurationsabschnitte mit Überschrift, Haarlinie und einer benannten Feldbreite bauen.
- **Do** Löschhandlungen dauerhaft als `danger` markieren und mit `inspector-confirmation` bestätigen lassen.

### Don't:
- **Don't** ein ausgeschaltetes Modul bernstein färben. Aus ist neutral; Bernstein heißt unbekannt oder Hinweis.
- **Don't** eine gesunde Zustandszeile grün hinterlegen; nur Warnung und Fehler bekommen Fläche und Rand.
- **Don't** Ereignisfamilien aus dem Codenamen raten oder Grün für etwas anderes als läuft/verbunden vergeben.
- **Don't** eine vierte Familienfarbe erfinden, Familienfarbe außerhalb des Art-Chips verwenden, eine Familie in Zustandsfarbe färben oder einen Betrieb-Chip füllen.
- **Don't** Markenfarbe für Zustand oder Wichtigkeit verwenden, und Zustandsfarbe für Auswahl.
- **Don't** Schatten, Verläufe oder Skelett-Schimmer einsetzen.
- **Don't** einen dritten Radius (auch kein `9999px`), eine dritte Schrift oder eine zweite Symbolfamilie einführen; kein Emoji.
- **Don't** eine Taste mit Absatz, Zähler oder verschachteltem Layout beladen — dann ist sie eine Karte.
- **Don't** Schriftgrößen an den Viewport koppeln; schmal klappt das Gerüst um, nicht die Schrift.
- **Don't** ein rechtes Dock bauen, das leer wartet, eine Tabelle beim Wählen umbrechen lassen oder einen Inspektor ein- und ausblenden; er ist da oder nicht.
- **Don't** eine überlagernde Fläche zum Bearbeiten, Bestätigen oder für ein Formular bauen, und keine dritte Art überlagernder Fläche neben aufklappender Liste und Neue-Ereignisse-Hinweis einführen.
- **Don't** eine Zustandsliste, ein Formular oder Fließtext über 960 px ziehen, nur weil die Seite breiter ist.
- **Don't** Zeilen ohne Inspector klickbar stylen; Zeiger und Hover gibt es nur mit `tabindex`.
- **Don't** eine Panel-Ansicht ohne `.module-stack` oder eine Löschhandlung als `quiet` bauen.

### Eingelöst: Phase 2 (Issue #81)
Übersicht (Kanaltasten), Kanal und System (Seitenkopf, Zustandszeilen, Eigenschaftenliste), Mitglieder (Tabelle mit Aktionsspalte, Inspector im Fluss), Audit und Ereignisse (Tabelle mit Zeilenauswahl, Sub-Inspector mit Vorher/Nachher bzw. JSON, Ereignis-LED-Wort) laufen in dieser Welt; die Blöcke der alten Welt (232-px-Seitenleiste, `status-card`, `channel-card`, `member-table`, `page-heading`, `command-table`, Versalien-Plakette) sind aus `styles.css` entfernt.

Offen bleiben zwei Punkte, die kein Stil lösen kann: die Bündelung von Ereignissen nach Auslöser (die Daten tragen keine Auslöser-ID) und die Ladewettläufe der Mitgliederliste beim schnellen Kanalwechsel (#83).
