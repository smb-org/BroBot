# BroBot in StreamElements und Sound Alerts

## StreamElements

Die Widget-Dateien liegen unter [`streamelements/`](streamelements/). In StreamElements ein Overlay öffnen und *Add Widget → Static/Custom → Custom Widget* wählen. `widget.html` in den HTML-Reiter, `widget.js` in JS und `fields.json` in Fields kopieren; den CSS-Reiter leer lassen. In *BroBot-Adresse* den HTTPS-Ursprung deiner BroBot-Instanz und in *Overlay-URL* den vollständigen Overlay-Link mit Zugangstoken eintragen. Das Widget akzeptiert nur `/overlay` oder `/overlay.html` von genau dieser Adresse, ohne URL-Query und mit Token im Fragment. Das Widget füllt seine Box mit dem Overlay. Bei einem einzelnen Element die Box im Editor positionieren; für das ganze Overlay die Box auf die Overlay-Fläche setzen.

## Sound Alerts

Die [Sound Alerts-Dokumentation zu Custom Widgets](https://support.soundalerts.com/article/Custom-Widget) beschreibt sowohl eigene Widgets mit HTML, CSS, JavaScript und Fields als auch den Import kompatibler StreamElements-Widgets über *Scenes → Add Widget → Import Widget*. Daher sollte sich das StreamElements-Widget aus [`streamelements/`](streamelements/) dort importieren lassen. Falls der Import es nicht übernimmt, kann man ein *Custom Widget* anlegen und die HTML-, JS- und Fields-Inhalte in die entsprechenden Reiter kopieren; der CSS-Reiter bleibt leer.

**Nicht am echten Sound Alerts-Produkt verifiziert.** Insbesondere Import-Kompatibilität, Feldformat und die Anzeige im sandboxed iframe wurden hier nicht praktisch geprüft.
