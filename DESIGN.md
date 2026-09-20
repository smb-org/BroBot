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
typography:
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
beginnt mit demselben Seitenkopf (56-px-Symbolkachel, Titel, Unterzeile) und
begrenzt ihren Inhalt auf 960 px. Die Schiene links bleibt in jeder Breite ein
Band fester 64×64-Tasten.

Seit Phase 2 gilt das Gerät auf allen fünf Seiten: Die Übersicht zeigt Kanäle
als Tasten, Kanal und System sprechen in Zustandszeilen (LED + Wort + Detail +
Aktion), Mitglieder, Audit und Ereignisse liegen in einer gemeinsamen Tabelle,
deren gewählte Zeile ihren Sub-Inspector im Fluss darunter öffnet. Die alte
Welt (232-px-Seitenleiste, Zustandskarten, Versalien-Plaketten) ist aus dem
Stylesheet entfernt.

Abgelehnt wurde am 19. September 2026 der Kategoriestandard (Seitenleiste mit
Titelzeile und Tabelle): zu asketisch. Die Welt darf souverän sein, ohne bunt
zu werden — die einzigen Farben bedeuten Zustand oder markieren den Ort des
Bedieners.

**Key Characteristics:**
- Mattschwarz (#141312) mit warmen Graustufen; vier Textstufen, kein Verlauf, kein Schatten.
- Tasten sind Objekte mit 12 px Radius in dunklen Rinnen; Steuerelemente haben 6 px. Es gibt keinen dritten Radius.
- Zustand spricht in Grün, Bernstein, Rot — immer als LED mit Wort, nie Farbe allein. Aus ist neutral gezeichnet.
- Marke (Blau) markiert ausschließlich den Ort des Bedieners, nie Wichtigkeit.
- Archivo für alles; IBM Plex Mono mit Tabellenziffern nur für Zahlen, Zeitstempel, IDs und Befehlstoken.
- Eine Symbolfamilie: 24er-Viewbox, Strich 1,5, runde Enden, `fill: none`. Kein Emoji, keine zweite Familie.
- Feste Maße: Kopfleiste 56 px, Schiene 80 px, Schienentaste 64×64, Modul-/Kanaltaste 132×132, Bedienelement 44 px, Tabellenzeile 34 px, Zustandszeile 58 px, Zustands-Etikettspalte 240 px.

## Colors

Ein warmer, mattschwarzer Grundton in acht Abstufungen, eine Markenfarbe für den
Ort des Bedieners, drei Zustandsfarben. Sonst nichts.

### Primary
- **Marke** ({colors.marke}, Hover {colors.marke-hover}, Druck {colors.marke-press}): primäre Aktion, gewählte Taste im Raster (Rand), aktive Schienentaste (Rand), gewählte Tabellenzeile (2 px Innenkante links). Blau statt Twitch-Violett, damit BroBot als eigenes Werkzeug erkennbar bleibt.
- **Marke-Text** ({colors.marke-text}): Brotkrume, Befehlsname in der Befehlstabelle, Seitenkopf-Symbol, aktive Schienentaste, Profil-Link in der Mitgliederliste (Unterstrich 40 %, beim Hinzeigen voll), Fokusring (2 px, Abstand 2 px). Auf {colors.grund} der lesbare Bruder der Marke.
- **Marke-Auf** ({colors.marke-auf}): Text auf primärem Knopf.
- **Marke-Linie** ({colors.marke-linie}): gedämpfte Markenkante, wo eine volle Marke zu laut wäre.
- **Tint-1 / Tint-2** ({colors.tint-1} / {colors.tint-2}): Markenfarbe als Material — so entsättigt, dass niemand sie Farbe nennt. Tint-1 füllt das Seitenkopf-Symbol, die gewählte Tabellenzeile und die Textauswahl; Tint-2 die aktive Schienentaste, die gewählte Modultaste und Tabellenköpfe.

### Secondary (Zustand)
- **Grün** ({colors.gruen}, Fläche {colors.gruen-grund}): läuft, verbunden, gesendet, gesund. LED-Punkt und LED-Wort, Symbolkachel einer eingeschalteten Taste, Schalter-Spur „an“, Ereignis-LED „Info“ für `host.chat.gesendet`. Grün steht nie ohne Wort daneben.
- **Bernstein** ({colors.warn}, Fläche {colors.warn-grund}): unbekannt oder nicht aktiv — Verbindung unklar, Modul ohne Zustand, Zustandszeile `warning`, Ereignis-LED „Hinweis“ (abgekühlt, unterdrückt, bereits vorhanden). **Nicht** für „ausgeschaltet“.
- **Rot** ({colors.fehler}, Fläche {colors.fehler-grund}): Fehler, Löschen. LED-Punkt, Zustandszeile `error`, Fehlerkasten, Formularfehler mit vorangestelltem ×; der stille Löschknopf färbt sich erst beim Hinzeigen rot.
- **Fehler-Text** ({colors.fehler-text}): ausschließlich das LED-Wort bei rotem Punkt. Eine Stufe heller als Rot, weil das 12-px-Wort auf Tint-1 (gewählte Zeile) sonst unter AA fällt: 4,71:1 auf Tint-1, 5,70:1 auf Grund. Für Flächen, Ränder und Punkte bleibt {colors.fehler}.

### Neutral
- **Grund** ({colors.grund}): Seitenhintergrund und Arbeitsfläche der Mitte.
- **Rail** ({colors.rail}): Kopfleiste und Schiene — eine Stufe heller als der Grund, durch eine Haarlinie getrennt.
- **Taste** ({colors.taste}, Hover {colors.taste-hover}): Tastenkörper, neutraler Knopf, Tabellenzeile beim Überfahren, Ergebnis- und Bestätigungskasten im Mitglieder-Inspector, Avatar-Platzhalter.
- **Rinne** ({colors.rinne}): das Dunkelste — Eingabefelder, Symbolkachel einer ausgeschalteten Taste, der Punkt einer LED „aus“, `pre`-Flächen im Sub-Inspector (Vorher/Nachher, Ereignis-JSON). Die Rinne liegt tiefer als die Taste, deshalb liest sich die Taste als erhoben.
- **Inspektor** ({colors.inspektor}): Fläche des Sub-Inspectors unter Audit- und Ereignistabelle — eine halbe Stufe über dem Grund, damit der geöffnete Bereich als eigener Block lesbar ist, ohne zur Taste zu werden.
- **Linie / Linie-Stark / Linie-Hell** ({colors.linie} / {colors.linie-stark} / {colors.linie-hell}): Haarlinie für Bereichs-, Zeilen- und Eigenschaftentrennung; stärkere Kante für Feld- und Knopfränder, gestrichelt für Leerzustände; hellste Kante beim Überfahren.
- **Text** ({colors.text}): Namen, Werte, Überschriften, Zustands-Etikett, Eigenschaftswerte, Zeilenkopf in Tabellen. **Text-2** ({colors.text-2}): Beschreibungen, Feldnamen, Tabellenantworten, Zustandsdetail, Seitenkopf-Unterzeile, LED-Wort ohne Zustand (8,27:1 auf Grund). **Text-3** ({colors.text-3}): Metadaten, Spaltenköpfe, Schienenetikett, Eigenschaftsnamen, Vorher/Nachher-Kopf, Login-Hinweis unter dem Mitgliedsnamen, ausgeschaltete Taste, Platzhalter (5,08:1 auf Grund, 4,65:1 auf Taste). **Text-4** ({colors.text-4}): Trenner, Datenalter, LED-Punkt und Schalter-Spur im Ruhezustand — nie für Fließtext.

### Named Rules
**Die Zwei-Rollen-Regel.** Marke markiert den Ort des Bedieners (Auswahl, Fokus, primäre Aktion, Verknüpfung). Zustand spricht in Grün, Bernstein, Rot. Das System spricht nie in Markenfarbe, und Zustand nie in Marke — die Rollen kollidieren strukturell nicht, nicht nur farbmetrisch.

**Die LED-mit-Wort-Regel.** Wo Zustand steht, steht eine LED (8 px Punkt) und ein Wort: „Läuft“, „Aus“, „Verbunden“, „Fehler“, „Hinweis“, „Info“. Farbe allein informiert nie. Grün ohne Wort ist ein Fehler, kein Stil.

**Die Aus-ist-neutral-Regel.** Ein ausgeschaltetes Modul ist kein Problem. Es bekommt eine gezeichnete LED (Rinne mit Text-4-Rand), Text-3 und keine Farbe. Bernstein bedeutet ausschließlich „unbekannt“ oder „nicht aktiv, obwohl es sollte“.

**Die Ereignis-je-Code-Regel.** Die Farbe eines Ereignisses steht in `ereignisTon` (locale.ts) pro Ereigniscode — nie wird sie aus einem Namensmuster geraten („…fehler“ → rot). Ein Code ohne Eintrag bekommt die gezeichnete LED „Unbekannt“ und seinen rohen Code in Mono. Grün ist dabei nur „läuft / verbunden / gesendet“; alles Erwartbar-Unerwünschte (abgekühlt, unterdrückt, bereits vorhanden) ist Bernstein „Hinweis“, alles Gescheiterte Rot „Fehler“.

## Typography

**Display Font:** Archivo (mit ui-sans-serif, system-ui) — selbst gehostet, variabel 400–700, latin-Subset.
**Body Font:** Archivo.
**Label/Mono Font:** IBM Plex Mono 400 (mit ui-monospace) — `font-variant-numeric: tabular-nums`.

**Charakter:** Eine Grotesk mit technischer Ruhe, in einem festen 14-px-Raster, das nicht mitwächst. Die Hierarchie entsteht aus wenigen Größen zwischen 10 und 22 px und aus den vier Textstufen, nicht aus Größensprüngen. Es gibt keine Großüberschrift: Der Modultitel (22 px) ist die größte Schrift im System.

### Hierarchy
- **Modultitel** (600, 22 px, 1.25, −0.015 em): `h1` im Seitenkopf jeder Seite (Übersicht, Kanalname, System, Mitglieder, Ereignisse, Module, Modulname).
- **Bereichstitel** (600, 15 px): `h2` in der Bereichsüberschrift `section-heading` („Aktive Module“, „Audit-Log“, „Eigenschaften“, „Protokoll“, Leerzustand-Titel). Rechts daneben steht die Anzahl als Zahl in Mono.
- **Abschnitt** (600, 13 px): Inspektor-Abschnitte (`h2`/`h3` innerhalb `inspector-section__heading`), Titel des Sub-Inspectors (Aktion bzw. Ereignistext), Zustands-Etikett. Bewusst so klein wie der Fließtext — Gewicht trennt, nicht Größe.
- **Tastenname** (600, 13 px, eine Zeile, Ellipse): Name auf der Modul- und Kanaltaste.
- **Body** (400, 13 px, 1.5): Beschreibungen (max. 70 ch), Seitenkopf-Unterzeile, Eigenschaftswerte, Brotkrume, Knopftext, Leerzustand.
- **Feldname** (500, 12 px, Text-2): Beschriftung über Feldern; Hinweis darunter 12 px, 400, Text-3. Auch Zustandsdetail, Eigenschaftsnamen und Login-Hinweis stehen in 12 px.
- **LED-Wort** (600, 12 px): das Wort neben dem LED-Punkt, in Zustandsfarbe (bei Rot in Fehler-Text).
- **Schienenetikett** (400, 11 px, 1.1, Ellipse): Wort unter dem Symbol in der 64er-Taste; Modul-ID unter dem Modultitel; Sperrgrund unter dem Schalter; Vorher/Nachher-Kopf im Sub-Inspector (600, Text-3).
- **Spaltenkopf** (600, 10 px, 0.06 em, Versalien, Text-3, auf Tint-2): einziger Versalien-Einsatz im System.
- **Zahl** (Plex Mono 400, 12 px, Tabellenziffern): Twitch-ID in der Kopfleiste, Abkühlzeit, Befehlstoken `!name`, Meta-Zeile „zuletzt“, Zeitstempel und Nutzer-IDs in Audit und Ereignissen, Audit-Aktion, Audit-/Ereignis-ID, rohe Ereignis- und Modulcodes, Zähler neben Bereichstiteln.

### Named Rules
**Die Mono-für-Zahlen-Regel.** Plex Mono ist die Schrift für Werte, die man abliest, vergleicht oder wörtlich eintippt: Twitch-ID, Sekunden, Zeitstempel, Befehlstoken (`!name`), Aktions- und Ereigniscodes, Datensatz-IDs. Ein Ereignis oder Modul, für das es ein lesbares Wort gibt, steht in Archivo; erst der unbekannte Code fällt auf Mono zurück. Für Namen, Beschreibungen und Etiketten ist Mono verboten.

**Die Feste-Skala-Regel.** Keine `clamp()`, keine Viewport-Einheiten in der Schrift. Schmale Fenster klappen das Gerüst um; die Schriftgrößen bleiben.

## Layout

Das Gerüst ist ein Gerät mit festen Maßen:

- **Kopfleiste** 56 px, Rail-Farbe, Haarlinie unten, Innenabstand 0 20 px, Spaltenraster `auto minmax(180px,1fr) auto auto auto`: Marke (18-px-Quadrat mit 2 px Marke-Text-Rand, 6 px Radius, Wortmarke 15 px/700), Kanalwahl (Select bis 280 px, 44 px hoch) mit Twitch-ID in Mono, LED mit Wort, Lebenszeichen („aktualisiert vor …“, Text-3, 12 px), Abmelden. Auf der Modulseite kommt der Hauptschalter als sechste Spalte hinzu.
- **Schiene** 80 px breit, Rail-Farbe, Haarlinie rechts, Innenabstand 12 px 8 px. Enthält senkrecht gestapelte 64×64-Tasten mit 8 px Lücke, zentriert. Zustandspunkt 7 px oben rechts nur für Warnung/Fehler.
- **Mitte** ist auf `--dashboard-content-width` 960 px plus 32 px Seitenabstand begrenzt (`min(1024px, 100%)`), Innenabstand 24 px 32 px 40 px; der Modul-Arbeitsbereich hebt das auf und setzt 28 px 32 px 40 px. Jede Seite beginnt mit dem Seitenkopf (56-px-Symbolkachel + Titel + Unterzeile + optionale Aktionen rechts, Haarlinie unten, 24 px Abstand). Das Tastenraster ist `repeat(4, 132px)` mit 12 px Lücke, linksbündig, nicht fluid. Zustandszeilen stapeln mit 8 px Lücke. Bereiche (`content-section`) tragen eine Bereichsüberschrift mit Haarlinie.
- **Zustandszeile** ist ein Vier-Spalten-Raster `240px auto minmax(0,1fr) auto`: Etikett in fester Spalte (`--zustand-label`), LED mit Wort, Detail einzeilig mit Ellipse, Aktion rechtsbündig. Mindesthöhe 58 px, Innenabstand 16 px.
- **Eigenschaftenliste** (`dl.eigenschaften`) ist zweispaltig; jedes Paar ist selbst ein Raster `1fr 1.3fr` mit 16 px Lücke, 10 px senkrechtem Abstand und Haarlinie unten. Werte sind einzeilig mit Ellipse.
- **Abstandsrhythmus** 4-8-12-16-20-24-32-40-48. Bereiche trennt eine Haarlinie plus Abstand, nie ein Rahmen um alles.
- **Formulare** stapeln ihre Felder (Lücke 14–16 px, max. 40 rem); Zahleneingaben max. 9 rem. Aktionen stehen in einer Zeile mit Hinweis rechts daneben. Der Mitglieder-Inspector setzt Suchfeld und Knopf in einer `form-row`.
- **Kein rechtes Dock.** Der Sub-Inspector einer gewählten Tabellenzeile öffnet sich unter der Tabelle im selben Fluss (16 px Abstand).

**Schmal (≤ 768 px):** Kopfleiste zweizeilig (40 px + 40 px; mit Hauptschalter dreizeilig): Marke, LED, Abmelden oben; Kanalwahl über die volle Breite darunter. Das Lebenszeichen verschwindet. Die Schiene wird zu einem waagerechten, scrollbaren Band mit denselben 64×64-Tasten (Lücke 6 px). Das Raster wird zweispaltig, die Taste bleibt 132×132. Der Seitenkopf verliert seine dritte Spalte; Aktionen rutschen linksbündig in eine eigene Zeile. Die Eigenschaftenliste wird einspaltig; `form-row` und Ergebniskasten stapeln. Unter 420 px schrumpft nur die Rasterlücke auf 8 px.

**Eng (≤ 639 px):** Die Zustandszeile bricht um: Etikett über die volle Breite, darunter LED und mehrzeiliges Detail, Aktion linksbündig in eigener Zeile. Der Sub-Inspector zeigt Vorher und Nachher untereinander. Tabellen geben ihre Mindestbreite von 600 px auf und verstecken die dritte Spalte (Audit „Wer“, Ereignis „Modul“).

**Container ≤ 640 px (Befehlstabelle):** Die Spalte „zuletzt“ verschwindet; der Wert wandert als Mono-Metazeile in den Sub-Inspector der gewählten Zeile.

**Die Trefferflächen-Regel.** Alleinstehende Bedienelemente (Knopf, Feld, Select, Schalter, Brotkrumen-Link) sind mindestens 44 px hoch. In dichten Tabellenzeilen gelten 34 px — auch für Select und Knopf in der Aktionsspalte —, weil Dichte dort ein Feature ist. Beides liegt über der AA-Untergrenze von 24 px.

## Elevation & Depth

Keine Schatten. Tiefe entsteht ausschließlich aus Tonstufen und Haarlinien: Die Rinne (#100f0e) liegt unter dem Grund (#141312), Rail (#181716), Inspektor (#1a1917) und Taste (#1e1c1a) darüber. Eine Taste wirkt erhoben, weil ihre Symbolkachel in der Rinne sitzt und ihr Rand eine Haarlinie ist. Eingabefelder und `pre`-Flächen liegen in der Rinne — man tippt und liest in eine Vertiefung. Der Sub-Inspector liegt eine halbe Stufe über dem Grund. Beim Überfahren hellt sich eine Taste um eine Stufe auf (#262321) und ihr Rand wird zur hellen Linie.

Bewegung ist die einzige „Tiefe“ im System: Tastendruck skaliert auf 0,97 in 120 ms (`ease`) und füllt die Taste mit 18 % Grün; LED-Punkt und LED-Wort blenden Farbe und Deckkraft in 160 ms; Schalter-Spur und -Knopf wandern in 160 ms. Unter `prefers-reduced-motion` fällt alles auf 0,01 ms.

### Named Rules
**Die Keine-Schatten-Regel.** Kein `box-shadow` als Tiefe, kein Verlauf, kein Schimmer. Die einzigen `inset`-Kanten sind die 2 px Markenkante der gewählten Tabellenzeile.

**Die Kein-Skelett-Regel.** Veraltete Werte bleiben mit 55 % Deckkraft stehen (`.veraltet` um die Tabelle, sobald Audit, Ereignisse oder Mitglieder nachladen und schon Daten da sind); nichts schimmert. Beim ersten Laden ohne Daten steht eine Ladezeile in Text-2. Bewegung im Augenwinkel sieht neben einem laufenden Stream wie eine Änderung aus.

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
`inline-flex`, Punkt 8 px + Wort 12 px/600, Lücke 7 px, min. 20 px hoch. Zustände `green`, `amber`, `red`, `off`. Aus: Punkt in Rinne mit Text-4-Rand, Wort Text-3. Rot: Punkt Fehler, Wort Fehler-Text. Übergang 160 ms auf Punkt und Wort. Auch die Verbindungs-LED in der Kopfleiste, die LED der Zustandszeile und das Ereignis-LED-Wort sind diese Bauform.

### Ereignis-LED-Wort
In der Ereignistabelle steht vor jedem Ereignistext eine LED mit Wort, das aus `ereignisTon` folgt: rot „Fehler“, bernstein „Hinweis“, grün „Info“, kein Eintrag → gezeichnet „Unbekannt“ und der rohe Code in Mono. `event-label` ist `flex` mit 10 px Lücke; der Text dahinter ist einzeilig mit Ellipse.

### Buttons
- **Form:** {rounded.control}, 44 px hoch, 10 px 16 px, 13 px/500. In einer Tabellenzelle 34 px hoch, 6 px 12 px.
- **Neutral:** Taste mit Linie-Stark-Rand; Hover Taste-Hover mit Linie-Hell.
- **Primär:** Marke mit Marke-Auf-Text, 600; Hover Marke-Hover, Druck Marke-Press. Genau einer pro Bereich. Auf der Kanalseite ist die Moderatorprüfung nur dann primär, wenn der Moderatorstatus fehlt (`dringend`); sonst neutral.
- **Gedeckt:** Der Anlege-Knopf ist neutral, solange das Formular unvollständig ist, und wird erst mit gültigen Feldern primär; der Grund steht als Hinweis (Text-3, 12 px) direkt daneben.
- **Still (`quiet`):** transparent, Text-2, 12.5 px; erst beim Hinzeigen Rot auf Fehler-Grund mit 45 % Fehler-Rand. Für Löschen.
- **Gefahr (`danger`):** Rot ohne Rand; Hover Weiß auf Rot.
- **Nachladen (`secondary`):** neutraler Knopf mit 16 px Abstand nach oben, unter Tabellen („Ältere Einträge laden“).
- **Deaktiviert:** 50 % Deckkraft, `not-allowed`.

### Schalter (Hauptschalter)
44×44 Trefferfläche, Spur 36×20 auf Text-4, Knopf 14 px in Text; an: Spur Grün, Knopf um 16 px verschoben (160 ms). In der Kopfleiste mit Etikett links (12 px/600, Text-2). Für Bediener gesperrt (45 %) — der Sperrgrund steht als 11-px-Zeile direkt darunter, nicht als Meldung anderswo.

### Inputs / Fields
- **Stil:** Rinne mit Linie-Stark-Rand, {rounded.control}, 44 px hoch, 8 px 10 px; Textarea 88 px, senkrecht ziehbar; Zahl max. 9 rem. Select in Tabellenzellen 34 px.
- **Hover:** Rand Linie-Hell. **Fokus:** 2 px Marke-Text außen, Abstand 2 px.
- **Deaktiviert:** 55 % Deckkraft. **Fehler:** rote Zeile mit × unter den Aktionen, `role="alert"`.

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
Öffnet sich unter der Tabelle für die gewählte Audit- oder Ereigniszeile: `min(960px, 100%)`, 16 px Abstand oben, 18 px 16 px Innenabstand, Haarlinie, {rounded.control}, Fläche Inspektor. Kopf `inspector-section__heading`: Titel 13 px/600 links, Datensatz-ID in Mono Text-2 rechts.
- **Audit:** `inspector-columns` — zwei Spalten `repeat(2, minmax(0,1fr))`, 16 px Lücke, Kopf „Vorher“/„Nachher“ 11 px/600 Text-3, darunter `pre` in der Rinne mit Haarlinie, min. 88 px, 10 px Innenabstand. Unter 640 px untereinander.
- **Ereignis:** Eigenschaftenliste (Code, Modul, Zeitstempel) plus `event-detail-json`: formatiertes JSON als `pre` in der Rinne, 12 px Innenabstand, 16 px Abstand.
- **Befehl:** Felder + Speichern/Löschen (Phase 1), Meta-Zeile „zuletzt“ unter 640 px Containerbreite.
- **Mitglied:** Ergebniskasten (`inspector-result`, Taste, {rounded.container}, Avatar-Zeile + Rollenwahl + Knopf) und Bestätigungskasten (`inspector-confirmation`, 14-px-Titel) — beide im Fluss unter dem Suchformular.

### Brotkrume
13 px, Text-2; Link Marke-Text mit 44 px Trefferhöhe, Hover Text mit Unterstrich; Trenner Text-4; aktuelles Glied 600 in Marke-Text mit 20-px-Glyph davor. Nur auf der Modulseite.

### Leer- und Fehlerkasten
`empty-state` / `module-empty`: gestrichelter Linie-Stark-Rand, {rounded.container}, 18–20 px Innenabstand, Text-2, 13 px; Titel als Bereichstitel in Text. `error-panel`: durchgezogen, 45 % Rot auf Fehler-Grund, Titel in Rot.

### Symbole
Eine Familie: `viewBox 0 0 24 24`, `fill: none`, `stroke: currentColor`, Strich 1,5, runde Enden und Ecken. Schiene 20 px, Taste 25 px, Seitenkopf 28 px, Brotkrume 20 px. Seitensymbole (Übersicht, Kanal, System, Mitglieder, Module, Ereignisse) und Modulsymbole kommen aus derselben `NavigationIcon`/`iconFor`-Quelle. Inline-SVG, `aria-hidden`. Kein Emoji, keine Icon-Schrift, keine zweite Strichstärke.

## Do's and Don'ts

### Do:
- **Do** jede Zustandsanzeige als LED mit Wort bauen; Grün nur mit „Läuft“/„Verbunden“/„Info (gesendet)“ daneben.
- **Do** neue Module und Kanäle als Taste ins Raster stellen: Symbol aus der Familie, Name, LED. Nichts weiter auf der Taste.
- **Do** jede Seite mit dem Seitenkopf beginnen und Zustand in Zustandszeilen, lesende Werte in der Eigenschaftenliste zeigen.
- **Do** Ereignisfarben pro Code in `ereignisTon` eintragen; ein neuer Code ohne Eintrag bleibt „Unbekannt“.
- **Do** genau zwei Radien verwenden: 12 px für Objekte, 6 px für Bedienelemente und Anzeigen.
- **Do** alleinstehende Bedienelemente 44 px hoch machen, Tabellenzeilen und ihre Bedienelemente 34 px.
- **Do** Werte in Plex Mono mit Tabellenziffern setzen (Twitch-ID, Sekunden, Zeitstempel, IDs, Codes, Befehlstoken).
- **Do** die Seite auf 960 px begrenzen und Bereiche mit Haarlinie plus Abstand trennen.
- **Do** den Sperr- oder Fehlergrund an die Wirkung schreiben (Sperrgrund unter dem Schalter oder Knopf, Hinweis neben dem gedeckten Knopf).
- **Do** veraltete Werte mit 55 % Deckkraft stehen lassen; nur beim ersten Laden eine Ladezeile.
- **Do** wählbare Tabellenzeilen mit `tabIndex` und `aria-selected` bauen und ihren Inspector im Fluss darunter öffnen.

### Don't:
- **Don't** ein ausgeschaltetes Modul bernstein färben. Aus ist neutral; Bernstein heißt unbekannt oder Hinweis.
- **Don't** eine gesunde Zustandszeile grün hinterlegen; nur Warnung und Fehler bekommen Fläche und Rand.
- **Don't** Ereignisfarben aus dem Codenamen raten oder Grün für etwas anderes als läuft/verbunden/gesendet vergeben.
- **Don't** Markenfarbe für Zustand oder Wichtigkeit verwenden, und Zustandsfarbe für Auswahl.
- **Don't** Schatten, Verläufe oder Skelett-Schimmer einsetzen.
- **Don't** einen dritten Radius (auch kein `9999px`), eine dritte Schrift oder eine zweite Symbolfamilie einführen; kein Emoji.
- **Don't** eine Taste mit Absatz, Zähler oder verschachteltem Layout beladen — dann ist sie eine Karte.
- **Don't** Schriftgrößen an den Viewport koppeln; schmal klappt das Gerüst um, nicht die Schrift.
- **Don't** ein rechtes Dock bauen; der Inspector öffnet sich im Fluss unter der Tabelle.
- **Don't** Zeilen ohne Inspector klickbar stylen; Zeiger und Hover gibt es nur mit `tabindex`.

### Eingelöst: Phase 2 (Issue #81)
Übersicht (Kanaltasten), Kanal und System (Seitenkopf, Zustandszeilen, Eigenschaftenliste), Mitglieder (Tabelle mit Aktionsspalte, Inspector im Fluss), Audit und Ereignisse (Tabelle mit Zeilenauswahl, Sub-Inspector mit Vorher/Nachher bzw. JSON, Ereignis-LED-Wort) laufen in dieser Welt; die Blöcke der alten Welt (232-px-Seitenleiste, `status-card`, `channel-card`, `member-table`, `page-heading`, `command-table`, Versalien-Plakette) sind aus `styles.css` entfernt.

Offen bleiben zwei Punkte, die kein Stil lösen kann: die Bündelung von Ereignissen nach Auslöser (die Daten tragen keine Auslöser-ID) und die Ladewettläufe der Mitgliederliste beim schnellen Kanalwechsel (#83).
