# Ereignisprotokoll für Modulverhalten

**Stand:** 19. September 2026
**Status:** entschieden
**Betrifft:** Modulverarbeitung, Host und Panel

## Kurzfazit

Module geben ihre fachlichen Begründungen als `diagnostics` und ihre
gewünschten, geordneten Aktionen als `actions` im `ModuleResult` zurück. Das
Modul begründet Nicht-Handeln; der Host protokolliert Handeln und dessen
Ausgang. Der Host schreibt diese Diagnosen mit `triggerId` in das kurzlebige,
kanalgebundene `event_log`; jedes Kanalmitglied kann sie im Panel lesen.

## 1. Getrennt vom `audit_log`

Das Ereignisprotokoll ist eine eigene Tabelle und bleibt vom `audit_log`
getrennt. Das Audit-Log ist vollständig, rechtlich relevant und wird nach
Entscheidung 0003 24 Monate aufbewahrt. Modulereignisse sind dagegen
betriebliche Diagnosezeilen: Sie dürfen lückenhaft sein, entstehen häufiger
und werden nach 14 Tagen gelöscht. Eine gemeinsame Tabelle würde die lange
Audit-Frist auf Chat- und Modulverkehr ausdehnen und das Audit mit
Debug-Informationen unübersichtlich machen.

## 2. D1 für die Betriebsansicht, Workers Logs für Laufzeitfehler

Die Zeilen liegen in D1, weil das Panel eine kanalgebundene, seitenweise und
autorisierte Abfrage braucht, die auch nach dem kurzen Moment einer
Worker-Ausführung verfügbar ist. D1 kennt den Kanal als Mandanten, lässt die
Aufbewahrung per Cron durchsetzen und kann die Einträge gemeinsam mit den
übrigen Paneldaten lesen.

Workers Logs sind der getrennte Leser für Laufzeitbeobachtung und
Betriebsfehler des Hosts, etwa eine fehlgeschlagene Helix-Anfrage oder ein
unerwarteter Executor-Fehler. Sie ersetzen nicht die dauerhaft abrufbare,
pro Kanal geschützte D1-Historie. D1 und Workers Logs haben deshalb zwei
verschiedene Leser und zwei verschiedene Zwecke.

## 3. Modulentscheidungen und ausgeführte Aktionen

Eine Chatnachricht ohne passendes Kommando erzeugt keine Zeile im
`event_log`. Dieses Akzeptanzkriterium bleibt offen, bis das erste Modul mit
der Command-Pipeline existiert; dann ist es mit diesem Modul nachzuholen.

Das Modul schreibt keine Eingabenachrichten und keine Infrastrukturfehler.
Es begründet fachliches Handeln oder Nicht-Handeln in `diagnostics`. Der Host
protokolliert jede von ihm ausgeführte Modulaktion und deren Ausgang mit
host-erzeugten Diagnosen, zum Beispiel `chat.gesendet` oder
`shoutout.fehlgeschlagen` samt Ursache. So ist ein eingegangener Raid von
einem unterdrückten Shoutout und von einem fehlgeschlagenen Twitch-Aufruf
unterscheidbar. Es entsteht keine zweite Chat-Historie.

Zusätzlich bleiben pro Kanal höchstens **500 Zeilen** erhalten. Der Host setzt
die Grenze beim Schreiben durch und entfernt ältere Zeilen in derselben
D1-Transaktion. Damit kann ein fehlerhaftes oder sehr gesprächiges Modul die
Tabelle nicht unbegrenzt wachsen lassen.

## 4. Vierzehn Tage, rohe `user_id`, Name beim Lesen

`actor_user_id` wird im Ereignisprotokoll roh gespeichert, wenn eine Person die
Verarbeitung ausgelöst hat; bei Zeitgebern oder EventSub-Nachrichten ohne
Absender ist der Wert `NULL`. Beim Anzeigen löst die Ereignisroute vorhandene
IDs über Twitch Helix in Login und Anzeigenamen auf, genau wie die
Mitgliederliste. Namen werden nicht zusätzlich gespeichert. Fällt die
Auflösung aus, bleibt die gespeicherte ID im Panel sichtbar.

Die rohe ID ist eine eng begrenzte Ausnahme, keine Änderung des allgemeinen
Hash-Modells. Ein stündlicher Cron löscht Einträge, deren Zeitpunkt länger als
14 Tage zurückliegt. Die kurze Frist und die 500-Zeilen-Grenze begrenzen den
personenbezogenen Bestand; die Ausnahme ist in Entscheidung 0003 ausdrücklich
vermerkt.

## 5. Sichtbar für alle Mitglieder

Das Ereignisprotokoll ist Betriebsinformation des Kanals. Deshalb dürfen
Broadcaster, Verwalter und ausdrücklich auch Bediener die Einträge lesen.
Gerade Bediener betreuen den Stream im Alltag und müssen bei einer
unterbliebenen Aktion den Grund nachsehen können. Die Sichtbarkeit erweitert
nicht den Mandanten: Der bestehende Kanal-Guard verlangt weiterhin eine
Mitgliedszeile im genau angefragten Kanal; Fremdkanäle antworten mit 403.

## 6. Geordnete Aktionen, keine Zustandsänderungs-API

`ModuleResult.actions` ist eine geordnete diskriminierte Union aus `chat` und
`overlay`. Der Executor kann sie per `switch` erschöpfend prüfen. Eine spätere
semantische Art wie `shoutout` mit Zielkanal, `clip` oder `wake` tritt additiv
bei und bricht bestehende Module nicht. Das Modul kennt dabei Twitch nicht als
generische Helix-Schnittstelle.

`stateChanges`, `ModuleStateChange` und `leeresErgebnis` gehören nicht zum
Contract. Es gibt dafür weder ein Modul noch einen Executor. Persistenz gehört
dem jeweiligen Modul; die offene Zustandsfrage wird mit dem ersten konkreten
Bedarf entschieden und tritt dann als weiteres Union-Mitglied bei.

`diagnostics` ist ein Feld von `ModuleResult`, keine separate Logging-API. Die
Schreibfunktion in `src/worker/event-log.ts` nimmt neben Kanal, Modul, Akteur,
Zeitpunkt und Diagnosen auch die `triggerId` des Host-Aufrufs entgegen und
legt sie in jeder Zeile ab. So bleiben mehrere Diagnosen eines Ereignisses
korrelierbar und EventSub-Zustellwiederholungen können über den Auslöser
erkannt werden.
