# Eigene API-Quellen und SSRF-Grenzen

**Stand:** 28. September 2026  
**Status:** entschieden  
**Betrifft:** Modul `api_source`, Textbibliothek, Worker-Fetch, D1  
**Beitrag zu:** [#247](https://github.com/smb-org/BroBot/issues/247)

## Kurzfassung

Kanal-Broadcaster und -Manager dürfen benannte HTTPS-JSON-Quellen mit einem
JSONata-Ausdruck anlegen. Die Quellen können Vorlagenwerte und boolesche
Textblockbedingungen liefern. Das ist bewusst mächtig: Ein Nutzer kann ein
Ziel im Internet auswählen, und der Worker ruft es in seinem Namen ab. Das ist
eine SSRF-Oberfläche und wird durch mehrstufige URL-Prüfungen, kleine Budgets
und eine begrenzte Antwortgröße eingeschränkt.

Die Absicherung kann DNS-Rebinding nicht vollständig verhindern. Workers
`fetch` stellt die aufgelöste Ziel-IP nicht bereit und erlaubt dem Aufrufer
nicht, diese IP für die Verbindung festzuhalten. Die ausgehenden Aufrufe kommen
aus Cloudflares Netzwerk, nicht aus einem internen BroBot-Netzwerk. Dieses
Restrisiko ist für die Funktion akzeptiert.

## 1. Bedrohungsfläche

Die URL, die Antwort und die Weiterleitungen sind durch einen Kanalmanager
bestimmt. Ein bösartiger oder kompromittierter Manager könnte versuchen,
Loopback-, private, Link-Local-, CGNAT-, Multicast- oder reservierte Ziele,
Metadaten-Endpunkte, eigene BroBot-Routen oder Cloudflare-interne Dienste
anzusprechen. Er könnte IPv4- oder IPv6-Literale, IPv4-mapped-IPv6-Schreibweisen,
alternative IPv4-Schreibweisen, URL-Zugangsdaten, einen fremden Port oder eine
Weiterleitung zu einem gesperrten Ziel nutzen. Eine externe Antwort kann groß,
verschachtelt oder für eine sehr teure JSONata-Auswertung gebaut sein.

Auch ein öffentlich aussehender DNS-Name kann seine Antwort ändern. Die URL
enthält nur den geprüften Namen; die spätere DNS-Auflösung liegt bei der
Workers-Runtime. Diese Trennung lässt trotz aller Prüfungen eine Rebinding-
Lücke.

## 2. Verbindliche Schutzregeln

- Es sind ausschließlich HTTPS-URLs auf Standardport 443 zugelassen. IP-
  Literale jeder Art, URL-Benutzername oder -Passwort, Fragmente, einteilige
  interne Namen sowie private, lokale, reservierte, Cloudflare- und eigene
  BroBot-Hostnamen werden abgewiesen.
- `PUBLIC_ORIGIN` und die festgelegten BroBot-Domains werden zur Laufzeit
  berücksichtigt. Jede Weiterleitung wird manuell verarbeitet; höchstens
  drei Weiterleitungen sind erlaubt, und jedes neue Ziel wird vor dem Aufruf
  erneut vollständig geprüft.
- Der GET-Aufruf sendet nur `Accept: application/json` und einen festen
  `User-Agent`. Browser-Cookies, eingehende Authorization-Header, Referer,
  Request-Bodies und andere Clientdaten werden nicht weitergereicht.
- Verbindungen brechen nach ungefähr drei Sekunden ab. Antworten müssen einen
  JSON-Content-Type haben und werden mit dem gemeinsamen begrenzten Reader auf
  64 KiB begrenzt. Für JSONata gelten 64 Ebenen und 20.000 Eingabeknoten.
- Je URL werden Antwortdaten in D1 zwischengespeichert. Das Standardfenster
  beträgt 60 Sekunden; Anbieter dürfen es nicht über fünf Minuten verlängern.
  Je Kanal sind höchstens 100 tatsächliche HTTP-Aufrufe pro Stunde erlaubt.
  Ein Vorlagenlauf darf höchstens drei Aufrufe ausführen; Weiterleitungen
  verbrauchen dasselbe Budget.
- JSONata ist exakt auf Version 2.2.2 festgelegt. Ausdrücke sind höchstens 512
  Zeichen lang und erhalten Laufzeit-, Rekursions- und Sequenzgrenzen. Es gibt
  keine eingespritzten Hostfunktionen, Bindings oder Erweiterungsfunktionen.
- Nur Broadcaster und Manager dürfen Quellen anlegen, ändern oder löschen.
  Diese verwaltende Schwelle wird in derselben SQL-Mutation wie die Änderung
  geprüft und die Änderung wird auditiert ([Entscheidung 0006](0006-rollenschwellen.md)).

## 3. Verbleibendes DNS-Rebinding-Risiko

Die URL-Prüfung kann IP-Literale und bekannte interne Hostnamen sicher
ablehnen, aber sie kann nur den Text des DNS-Namens prüfen. Cloudflare Workers
`fetch` macht weder die für eine konkrete Verbindung verwendete IP sichtbar
noch kann BroBot diese IP zwischen Auflösung und Verbindung pinnen. Ein
Angreifer, der einen eigenen DNS-Namen kontrolliert, kann daher versuchen,
seine Antwort nach der Prüfung zu ändern und den Namen auf eine gesperrte
Adresse zeigen zu lassen.

Ein DNS-Name mit wechselnder Antwort kann somit die direkte Literalsperre
umgehen. Die Laufzeitlimits begrenzen Dauer, Antwortmenge und Anzahl der
Anfragen, schließen diesen Pfad jedoch nicht. Die Plattform führt die Anfrage
aus Cloudflares Netzwerk und nicht aus einem internen BroBot-Netzwerk aus;
damit werden interne Anwendungszugänge nicht automatisch ausgeschlossen.

Wir akzeptieren dieses Restrisiko für #247, weil DNS-Pinning in Workers `fetch`
nicht verfügbar ist und die Funktion von frei benannten externen Quellen
abhängt. Wenn sich die Laufzeitfähigkeit ändert, ist die Ziel-IP vor dem
Versand erneut gegen dieselben IP-Bereiche zu prüfen und an die Verbindung zu
binden.

## 4. Leistungsgrenze

Der kombinierte Test rendert drei ineinander verschachtelte Textblöcke, wertet
zwei JSONata-Bedingungen und einen JSONata-Vorlagenwert aus und verwendet eine
6.000-Elemente-Antwort. Er misst den kalten und warmen D1-Cachepfad mit
stubbed Fetch und verlangt weniger als 10 ms Worker-seitige CPU pro
Vorlagenlauf. Der Test loggt das höchste Ergebnis seiner fünf Durchläufe.
Bei einer Überschreitung ist die Ausführung im Free-Tarif nicht akzeptiert;
vor dem Versand muss die Tarifentscheidung auf Workers Paid fallen.
