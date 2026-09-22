# Realtime-Strecke im Kanal-Durable-Object

**Stand:** 21. September 2026
**Status:** entschieden
**Betrifft:** `ChannelObject`, Worker-Routen, Modul-Executor, Panel, Overlay
**Beitrag zu:** [#7](https://github.com/smb-org/BroBot/issues/7), erster
Nutzer ist [#129](https://github.com/smb-org/BroBot/issues/129) Teil 2,
zweiter [#10](https://github.com/smb-org/BroBot/issues/10)

## Kurzfazit

Ein Durable Object je Kanal ist der einzige Echtzeitraum; das steht in #7 und
wird hier nicht neu verhandelt. Diese Entscheidung legt fest, **wie** die
Strecke abgesichert ist und was über sie geht.

Die Berechtigung wird **im Worker** geprüft, mit denselben Guards wie jede
HTTP-Route. Das Durable Object sieht nie einen Client-Request. Es bekommt vom
Worker einen selbst gebauten internen Request mit einem **Prinzipal** — Kanal,
Art der Gegenstelle, Kennungen, Ablauf — und vertraut ausschließlich diesem.
Tokens, Scopes und Sitzungsdaten erreichen das Objekt nicht.

Die Strecke ist **einseitig**: Server sendet, Client hört. Kommandos bleiben
HTTP-Mutationen, weil dort die Rollenschwelle in der Anweisung steht
([0006](0006-rollenschwellen.md) Abschnitt 4).

Das Panel bekommt **Hinweise mit Kurzdaten** und lädt den verbindlichen Stand
über die API nach. Eine endende Berechtigung wird in drei Schichten abgefangen:
harter Ablauf im Prinzipal, Widerruf aus den Mutationen, ein Alarm alle
fünfzehn Minuten als Netz. Das Overlay weist sich beim Aufbau mit seinem
vorhandenen Token im `Sec-WebSocket-Protocol`-Header aus.

Kosten entstehen nicht durch offene Verbindungen, sondern durch **Weckungen**
des Objekts. Die Stellschraube ist deshalb eine Nachricht je Auslöser, nicht
je Diagnosezeile.

## 1. Befund: das Gerüst nimmt heute alles an

`ChannelObject.fetch` akzeptiert derzeit jeden Upgrade-Request per
`acceptWebSocket`, ohne Prüfung und ohne Kenntnis, wer da ankommt. Das ist nur
deshalb ungefährlich, weil keine Worker-Route auf die `CHANNEL`-Bindung zeigt
— gleichzeitig ist `/ws/*` in `wrangler.jsonc` bereits per `run_worker_first`
dem Worker zugeordnet. Die Tür ist also vorbereitet, und das Objekt dahinter
fragt nicht nach.

Das ist kein Randdetail, sondern der erste Punkt, den die Umsetzung behebt:
Ein Upgrade ohne Prinzipal beantwortet das Objekt mit 403, nicht mit 426 wie
bisher für Nicht-Upgrades. Die Absicherung darf nicht davon abhängen, dass
niemand eine Route anlegt.

## 2. Das Prinzipal-Modell

Ein WebSocket lässt sich nicht wie ein Request absichern: Es gibt nur einen
Handshake, danach keine Header, kein CSRF-Token, keinen Guard je Nachricht. Die
Prüfung muss deshalb beim Aufbau vollständig sein — und sie gehört dorthin, wo
die Guards schon liegen.

Drei Gegenstellen, drei Routen im Worker, ein Eingang am Objekt:

| Gegenstelle | Route | Nachweis | Prüfung |
|---|---|---|---|
| Panel | `GET /ws/channels/:channelId` | Session-Cookie; der Browser sendet es beim Handshake | `requireChannelAuthorization()` unverändert, zusätzlich `Origin` gegen `PUBLIC_ORIGIN` |
| Overlay | `GET /ws/overlay` | Overlay-Token im `Sec-WebSocket-Protocol`-Header | `authenticateOverlayToken()` unverändert; der Kanal kommt ausschließlich aus dem Token-Datensatz |
| Spätere Anzeigequellen | wie Overlay | Overlay-Token | dito — für die Strecke ist eine Anzeigequelle ein Overlay-Token mit anderem Frontend |

Die Origin-Prüfung beim Panel ist ein Gürtel zu den Hosenträgern: WebSockets
kennen kein CORS, und ein fremder Ursprung könnte den Handshake mit unserem
Cookie versuchen. `SameSite=Lax` verhindert das heute schon, weil der
Handshake keine Top-Level-Navigation ist — aber die Sicherheit soll nicht an
einem Cookie-Attribut hängen, das jemand später für ein anderes Problem
lockert.

Nach bestandener Prüfung baut der Worker einen **neuen** Request für das
Objekt. Er reicht den Client-Request nicht durch. Der neue Request trägt
`Upgrade: websocket` und genau einen internen Header mit dem Prinzipal:

```ts
type Principal =
  | { v: 1; kind: "panel"; channelId; userId; sessionId; role; expiresAt: string }
  | { v: 1; kind: "overlay"; channelId; tokenId; expiresAt: string | null };
```

**Warum der Prinzipal nicht fälschbar ist:** Das Objekt ist ausschließlich
über die Bindung im Worker erreichbar; es hat keine öffentliche Adresse. Der
einzige Code, der einen Request an das Objekt richtet, ist der Worker — und
der setzt den Header selbst, aus dem Ergebnis seines Guards, in einen Request,
den er von Grund auf neu erzeugt. Ein Client kann einen Header namens
`X-BroBot-Principal` mitschicken, so viel er will: Er landet im Client-Request,
und der Client-Request endet im Worker. Es gibt keinen Pfad, auf dem ein
Client-Header das Objekt erreicht.

Der Prinzipal enthält, was das Objekt für Zustellung und Widerruf braucht, und
nichts darüber hinaus: keine Tokens, keine Scopes, keinen Cookie-Inhalt. Das
Objekt legt ihn per `serializeAttachment` an den Socket — er überlebt damit
den Schlaf (Abschnitt 6) — und akzeptiert den Socket mit Tags für Art,
Sitzung, Nutzer und Token, damit ein Widerruf gezielt trifft.

## 3. Vier Sicherungen der Mandantentrennung

`channelId` ist überall der Mandantenschlüssel, und die Strecke darf ihn nicht
aufweichen — auch nicht durch einen Fehler in einem Modul oder im Host selbst.
Vier Sicherungen greifen unabhängig voneinander:

1. **Die Identität des Objekts ist der Kanal.** Das Objekt wird mit
   `idFromName(channelId)` angesprochen; je Kanal existiert genau eines, und
   ein Socket hängt physisch an genau einem Objekt. Einen kanalübergreifenden
   Fan-out kann es nicht geben, weil es kein kanalübergreifendes Objekt gibt.
2. **Das Objekt prüft sich selbst gegen `ctx.id.name`.** Jede Nachricht, die
   der Worker zur Verteilung übergibt, trägt `channelId`. Das Objekt vergleicht
   sie mit dem Namen, unter dem es erzeugt wurde, und wirft bei Abweichung.
   Das ist die Stelle, an der ein Host-Fehler der Art „falscher Stub, richtige
   Nachricht" auffliegt, statt still in einem fremden Kanal anzukommen.
3. **Der Prinzipal trägt den Kanal.** Beim Aufbau prüft das Objekt
   `principal.channelId` gegen denselben Namen. Ein Routing-Fehler im Worker,
   der einen Panel-Socket an das falsche Objekt reicht, endet damit in 403.
4. **Module wählen keinen Kanal.** `ModuleAction.overlay` hat kein Kanalfeld;
   der Executor nimmt `event.channelId`, genau wie heute für Chataktionen. Den
   Nachrichtentyp präfixiert der Host mit der Modulkennung
   (`modul.<moduleId>.<type>`), damit ein Modul weder Host-Nachrichten noch
   die eines anderen Moduls vortäuschen kann. Die Nutzlast wird als JSON
   serialisiert und in der Größe gedeckelt; was nicht passt, wird als
   `host.overlay.verworfen` protokolliert statt gesendet.

Zusätzlich steht `channelId` in jeder ausgehenden Nachricht, und das Panel
schließt die Verbindung, wenn der Wert nicht zu seinem Kanal passt. Das kostet
nichts und macht einen Fehler auf beiden Seiten sichtbar.

## 4. Was über die Strecke geht

Jede Nachricht ist eine Envelope mit Version, eindeutiger ID,
Server-Zeitstempel, Kanal, Typ und Nutzlast. Die Version wird beim Handshake
über `Sec-WebSocket-Protocol` verhandelt (`brobot.v1`); der Server sendet je
Verbindung genau eine Envelope-Version. Neue Typen und neue optionale Felder
kommen additiv hinzu; ein unbekannter Typ wird vom Client ignoriert, damit ein
altes Panel ein neues Modul nicht zum Absturz bringt.

**Der Feed bekommt Hinweise mit Kurzdaten, nicht die Zeilen.** Eine
`event_log.new`-Nachricht trägt je neuem Eintrag `eventId`,
`createdAt`, `moduleId`, `code` und `actorUserId` — genug, um clientseitig
gegen die aktiven Filter vorzusortieren und zu zählen, aber ohne `detail` und
ohne Namen. Den verbindlichen Stand lädt das Panel über `GET …/events` nach.
So bleiben Filter, Namensauflösung über Helix und Sichtbarkeitsregeln an einer
Stelle, der Route; die Strecke wiederholt keine Logik. Alles in der Nachricht
darf nach [0004](0004-ereignisprotokoll.md) Abschnitt 7 jedes Kanalmitglied
sehen. Der Preis ist ein API-Aufruf je Ereignisschub bei offenem Panel —
deutlich weniger als das Polling im Takt, das #129 vermeiden will.

## 5. Warum die Strecke einseitig ist

Das Panel sendet nichts außer einem Ping. Alle Kommandos — auch das
„Voting schließen" aus #10, das dort als funktional zwingend beschrieben ist —
bleiben HTTP-Mutationen.

Der Grund ist [0006](0006-rollenschwellen.md) Abschnitt 4: Die Schwelle steht
in der Mutation, nicht nur im Handler, weil sich zwischen Prüfung und
Ausführung die Rolle ändern kann. Eine Kommandostrecke über den Socket hätte
keine Mutation, in der die Schwelle stehen könnte — sie müsste CSRF,
`actorGuard`, Audit und Sitzungsprüfung im Objekt nachbauen, und das Objekt
hat nach Abschnitt 2 bewusst keine Sitzung. Das wäre ein zweiter
Berechtigungspfad mit schwächeren Mitteln, also genau die Angriffsfläche, die
der Request-Pfad heute nicht hat.

Das Objekt ignoriert eingehende Nachrichten. Pings beantwortet die Runtime
per `setWebSocketAutoResponse`, ohne das Objekt zu wecken.

## 6. Hibernation: das Objekt hält keinen Zustand im Speicher

Das Epic verlangt WebSocket Hibernation. Sie bedeutet: Das Objekt wird bei
Inaktivität aus dem Speicher entfernt, die Sockets bleiben bei der Runtime
offen; beim nächsten Ereignis läuft der Konstruktor erneut. Klassenfelder,
Timer und laufende Promises sind dann weg. Was überlebt: die Attachments und
Tags der Sockets, die SQLite-Ablage und gesetzte Alarme.

Deshalb ist die Regel: **Nichts, was nach dem Wecken noch stimmen muss, liegt
in `this.*`.** Der Prinzipal liegt im Attachment. Für den Feed braucht das
Objekt keine eigene Tabelle — die „begrenzte Warteschlange", die das Epic
nennt, ist für den Feed das `event_log` in D1 mit seinen 500 Zeilen, und das
Panel lädt nach einem Reconnect ohnehin die erste Seite neu. Erst Overlays mit
Wiederholung nicht angezeigter Ereignisse bekommen eine SQLite-Tabelle im
Objekt; das kommt additiv mit #10.

Eine Bündelung mehrerer Auslöser über die Zeit (etwa „höchstens eine
Nachricht je Sekunde") wäre im Speicher nicht hibernationsfest. Gebündelt
wird deshalb je Auslöser im Worker und entprellt im Client, nicht im Objekt.

## 7. Drei Widerrufsschichten und das ehrliche Restfenster

Ein Request wird bei jedem Aufruf neu geprüft; ein Socket nur einmal. Läuft die
Sitzung ab, wird die Rolle entzogen oder das Token widerrufen, muss die
Verbindung enden, ohne dass das Objekt bei jeder Nachricht D1 fragt. Drei
Schichten, keine davon im Sendepfad:

1. **Harter Ablauf im Prinzipal.** Vor jedem Senden prüft das Objekt
   `expiresAt` aus dem Attachment — sieben Tage für Sitzungen, das gesetzte
   Datum für Tokens. Abgelaufen heißt schließen; der Client meldet sich neu.
2. **Widerruf aus den Mutationen.** Nach erfolgreicher Mutation ruft der
   Worker das Objekt: Logout schließt die Sitzung, Entfernen oder Rollenwechsel
   eines Mitglieds schließt alle Sockets dieses Nutzers, Token-Widerruf
   schließt das Overlay. Ein Rollenwechsel wird nicht umgelabelt, sondern
   geschlossen — der Client verbindet neu und bekommt den frischen Prinzipal.
   Das erspart dem Objekt jede Rollenverwaltung.
3. **Ein Alarm alle fünfzehn Minuten als Netz.** Solange Sockets offen sind,
   prüft das Objekt beim Wecken alle Sitzungen und Tokens seiner Verbindungen
   in je einer D1-Abfrage und schließt, was nicht mehr trägt. Das fängt, was
   Schicht 2 nicht kennt: Sitzungen, die der Cron in `login-maintenance`
   widerruft, und künftige Mutationspfade, an die niemand gedacht hat.

**Das Restfenster beträgt bis zu fünfzehn Minuten**, wenn ein Widerruf aus
Schicht 2 fehlschlägt oder einen Pfad nicht kennt; im Normalfall ist es null.
Das ist angemessen, weil über die Strecke ausschließlich geht, was
[0004](0004-ereignisprotokoll.md) Abschnitt 7 ohnehin jedem Kanalmitglied
zeigt: Betriebsinformation, die nach vierzehn Tagen gelöscht wird. Wer in
diesen fünfzehn Minuten noch Hinweise empfängt, sieht Kennungen und Codes,
die er vor einer Viertelstunde legitim lesen durfte — und keinen
verbindlichen Stand, denn den gibt nur die API heraus, und die prüft die
Sitzung bei jedem Aufruf. Sollte je etwas über die Strecke gehen, das diese
Eigenschaft nicht hat, ist das Fenster neu zu bewerten.

## 8. Kosten: Weckungen, nicht Verbindungen

Die Zahlen stammen aus der Cloudflare-Preis- und Limit-Dokumentation für
Durable Objects, gelesen am 21. September 2026 (Workers Paid): Requests
0,15 $ je Million, eine Million im Monat inklusive; Laufzeit 12,50 $ je
Million GB-s, 400.000 GB-s im Monat inklusive; ein Objekt wird mit 128 MB
angesetzt, eine GB-s entspricht damit acht Sekunden Objektlaufzeit.
Eingehende WebSocket-Nachrichten zählen 20:1 als Request, ausgehende sind
kostenlos, im Schlaf fällt keine Laufzeit an, Auto-Response-Pings wecken
nicht.

Daraus folgt: **Ein offenes Panel, in dem nichts passiert, kostet nichts.**
Hundert offene Overlays kosten nichts, solange nichts passiert, und beim
Senden nur den Fan-out, der kostenlos ist. Was kostet, ist jede Weckung des
Objekts — ein Request plus die Laufzeit, bis es wieder schläft. Mit der
Annahme von etwa zehn Sekunden Nachlauf (siehe Abschnitt 9) sind das rund
1,25 GB-s je Weckung, also knapp 0,00002 $.

Das Inklusiv-Kontingent trägt damit rund **320.000 Weckungen im Monat, etwa
10.700 am Tag über alle Kanäle**. Darüber kostet es rund 1,56 $ je weitere
100.000. Ein Kanal mit 5.000 Ereignissen an einem Streamtag liegt bequem
darin; zehn solche Kanäle täglich überschreiten das Kontingent und kosten
dann wenige Dollar im Monat. Das Modell kippt also nicht an Verbindungen,
sondern an der Zahl der Auslöser — und die Stellschraube dafür ist **eine
Nachricht je Auslöser, nicht je Diagnosezeile**: Ein EventSub-Ereignis, das
drei Module mit je zwei Diagnosen durchläuft, weckt das Objekt einmal, nicht
sechsmal. Dass eine Chatnachricht ohne Befehl nach 0004 Abschnitt 3 gar keine
Zeile erzeugt, hilft hier ein zweites Mal: Sie weckt auch nichts.

Der Worker weiß nicht, ob jemand verbunden ist, und weckt das Objekt auch bei
null Zuhörern. Ein Merker „Kanal hat Zuhörer" wäre möglich, lohnt aber erst,
wenn das Kontingent tatsächlich drückt.

## 9. Was nicht sicher ist

Die folgenden Punkte sind **Unsicherheiten**, keine Entscheidungen. Sie sind
so gekennzeichnet, damit sie beim ersten Betrieb geprüft werden, statt als
Wissen weitergetragen zu werden.

- **Inaktivitätsdauer bis zur Hibernation.** Die Kostenschätzung in
  Abschnitt 8 rechnet mit rund zehn Sekunden Nachlauf nach dem letzten
  Handler. Die gelesene Dokumentation nennt keine Zahl. Ein Faktor zwei in
  beide Richtungen verschiebt die Schwelle entsprechend, nicht die
  Schlussfolgerung.
- **Free-Plan-Kontingente.** Die gelesene Preisseite führt nur die Werte des
  bezahlten Plans. Aus dem Gedächtnis: 100.000 Requests und 13.000 GB-s am
  Tag, also rund 10.000 Weckungen täglich über alle Kanäle. Welche Stufe das
  Konto hat, steht nicht im Repository; der Free-Plan erlaubt nur
  SQLite-gestützte Objekte, was zur bestehenden Migration passt.
- **Ob Auto-Response-Pings als eingehende Nachricht berechnet werden.** Die
  Dokumentation sagt nur, dass sie nicht wecken. Selbst wenn sie 20:1
  zählen, sind es bei einem Ping je halbe Minute sechs Requests je Stunde
  und Verbindung.
- **Ob OBS-Browserquellen den `Sec-WebSocket-Protocol`-Header durchreichen.**
  Der Browser-Standard erlaubt, beim Öffnen eines WebSockets eine
  Protokollliste anzugeben; ob die in OBS eingebettete Browser-Engine und
  StreamElements-iframes den Header unverändert senden, ist nicht geprüft.
  **Der Rückfallweg ist ein Einmal-Ticket:** Das Overlay ruft mit seinem
  Token per `Authorization: Bearer` eine Route auf, die ein kurzlebiges,
  einmalig gültiges Ticket ausgibt, und öffnet den WebSocket damit. Der
  Worker tauscht das Ticket gegen denselben Prinzipal — **das Durable Object
  ändert sich dabei nicht**, weil es ohnehin nur den Prinzipal kennt. Der
  Preis wäre eine D1-Schreibung je Verbindungsaufbau und ein kurzlebiges
  Ticket in den Workers Logs, die bei `head_sampling_rate: 1` jede URL
  mitschreiben. Der Header-Weg ist die erste Wahl, weil der langlebige Token
  dort weder in URL noch Referer noch Logs erscheint — dieselbe Eigenschaft,
  die der heutige Bearer-Header hat.
- **Höchstzahl hibernierender Sockets je Objekt.** Die Limits-Seite nennt
  keine. Für ein bis drei OBS-Quellen und wenige Panels je Kanal ist sie
  ohne Belang.
- **Hibernation unter dem Test-Plugin.** Das Objekt läuft in den
  Worker-Tests real; ob Attachments und Tags unter Miniflare vollständig
  abgebildet sind, ist nicht geprüft.

## 10. Was das für den Betrieb heißt

- Der bestehende Zustand aus Abschnitt 1 wird behoben, bevor die erste Route
  auf das Objekt zeigt. Ein Upgrade ohne Prinzipal endet mit 403.
- Der erste Nutzer ist der Ereignis-Feed im Panel. Das Overlay bleibt bis zum
  zweiten Schritt beim heutigen HTTP-Status; die Overlay-Aktion eines Moduls
  wird weiterhin als `host.overlay.nicht_ausgefuehrt` protokolliert, bis
  Overlay-Route und Executor gemeinsam kommen — sonst sendet der Host ins
  Leere.
- Logout, Mitglied entfernen, Rollenwechsel und Token-Widerruf rufen das
  Objekt nach erfolgreicher Mutation. Das ist best-effort; das Netz ist der
  Alarm. Wer eine neue Mutation anlegt, die eine Berechtigung beendet, trägt
  den Widerruf nach — und wenn er es vergisst, greift das Netz nach spätestens
  fünfzehn Minuten.
- Das Panel zeigt den Verbindungszustand (`connected`, `reconnecting`,
  `offline`) und verbindet mit exponentiellem Backoff neu. Nach jedem
  Reconnect lädt es die erste Seite neu; doppelte Hinweise erkennt es an der
  Nachrichten-ID.
- Die Zahl der Weckungen je Tag ist die Betriebsgröße, die beobachtet gehört.
  Steigt sie in die Nähe der Schwelle aus Abschnitt 8, ist zuerst zu prüfen,
  ob ein Modul mehr Auslöser erzeugt als nötig, und erst danach ein Merker
  für Zuhörer zu erwägen.
- Wird je etwas über die Strecke geschickt, das nicht unter 0004 Abschnitt 7
  fällt, ist das Restfenster aus Abschnitt 7 neu zu entscheiden — nicht
  stillschweigend hinzunehmen.
