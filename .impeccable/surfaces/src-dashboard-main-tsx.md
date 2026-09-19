---
version: 1
slug: "src-dashboard-main-tsx"
primary_target: "src/dashboard/main.tsx"
related_targets: ["src/dashboard/styles.css","index.html"]
---

# Panel (Admin und Mod)

Modus: operate. Zielgruppe: Streamer und Mods, zweiter Monitor neben OBS, nachts, unter Zeitdruck. Aufgabe: sehen, ob der Bot läuft, und wenn nicht, warum — dann Module bedienen. Unantastbar: Rollenschwellen (0006), Zweisprachigkeit (0007), lazy geladene Modulansichten, WCAG AA.

## Direction contract

**THESIS:** Das Panel ist ein Stream Deck: Module sind beleuchtete Tasten, nicht Tabellenzeilen. Es verweigert das Seitenleisten-Admin mit Titelzeile und Tabelle.

**OWN-WORLD:** Mattschwarz mit warmem Grau, Tasten 12px-Radius in dunklen Rinnen. Eine Taste trägt Symbol, Name, LED mit Wort — nie einen Absatz. Aktiv leuchtet grün, Aus ist gezeichnet. Standard-Steuerelemente: Text, Zahl, Schalter, Auswahl, Tabelle. Archivo; Plex Mono für Zahlen.

**STORY:** Ein Blick aufs Raster sagt, was läuft. Taste antippen führt zur Detailseite in der Mitte; die Brotkrume sagt, wo man ist, und führt zurück. Befehle als Tabelle, Zeile wählen öffnet ihre Felder.

**FIRST VIEWPORT:** Kopfleiste 56px: Marke, Kanalwahl mit Twitch-ID, LED mit Wort, Lebenszeichen, Konto. Schiene 80px, Seitentasten als feste 64×64-Kästen. Mitte: Raster mit 132px-Tasten; auf der Detailseite Brotkrume, Modulkopf mit Symbol, Hauptschalter, Inhalt, max. 960px. Kein rechtes Dock. Signatur: Tastendruck — sinkt 120ms, leuchtet, LED blendet ein.

**FORM:** Stream Deck, Nummer 1 meiner Liste, IMPECCABLE'S PICK; Wurf wies Nummer 3 (OBS-Quellenliste) zu, vom Nutzer abgewählt. Seed-Schlüssel f31be6ec.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
