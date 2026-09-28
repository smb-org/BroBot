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
verschachtelt oder für eine sehr teure JSONata-Auswertung gebaut sein. Deshalb
ist JSONata durch eine statisch geprüfte AST-Knotentyp-Allowlist begrenzt; die
kooperative Zeitoption allein gilt nicht als CPU-Grenze.

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
  64 KiB begrenzt. JSONata erhält höchstens 64 KiB, 64 Ebenen und 20.000
  Eingabeknoten.
- Antwortdaten werden in D1 unter einem Hash aus Kanal-ID und URL
  zwischengespeichert. Das Standardfenster beträgt 60 Sekunden; Anbieter dürfen
  es nicht über fünf Minuten verlängern. Antworten mit `private`, `no-store`
  oder `no-cache` werden nicht gespeichert; `max-age` gilt innerhalb dieser
  Grenzen.
  Je Kanal sind höchstens 100 tatsächliche HTTP-Aufrufe pro Stunde erlaubt.
  Ein Vorlagenlauf darf höchstens drei Aufrufe ausführen; Weiterleitungen
  verbrauchen dasselbe Budget.
- JSONata ist exakt auf Version 2.2.2 festgelegt. Ausdrücke sind höchstens 512
  Zeichen lang. Derselbe AST-Validator prüft sie beim Speichern und vor jeder
  Auswertung. Seine Sicherheitsgrenze ist eine Allowlist aus Knotentypen und
  ihren ausdrücklich erlaubten Eigenschaften: Pfade aus Feldnamen sowie
  numerische Array-Indizes mit nichtnegativem Ganzzahlliteral, Zeichenketten-,
  Zahlen-, Boolesche- und Null-Literale, `+`, `-`, `*`, `/`, `%`, Vergleiche,
  `and`, `or`, Zeichenkettenverkettung `&`, Bedingungsausdrücke `?:` und
  Funktionsaufrufe mit einem direkten, unverzierten `$name` als Prozedur.
  Zulässige Funktionen sind `$string`, `$number`, `$boolean`, `$not`,
  `$exists`, `$length`, `$substring`, `$substringBefore`, `$substringAfter`,
  `$uppercase`, `$lowercase`, `$trim`, `$contains`, `$join`, `$sum`, `$max`,
  `$min`, `$average`, `$count`, `$round`, `$floor`, `$ceil`, `$abs`,
  `$formatNumber`, `$fromMillis`, `$toMillis`, `$now`, `$split` und `$replace`.
  Die Formatargumente von `$formatNumber` und `$fromMillis` müssen, falls
  vorhanden, Zeichenkettenliterale im AST sein und einer festen Allowlist
  entsprechen. `$formatNumber` erlaubt nur `#,##0`, `#,##0.00`, `0`, `0.0`,
  `0.00` und `0%`; zusätzliche Optionen sind nicht erlaubt. `$fromMillis`
  erlaubt ISO-Ausgabe oder das feste Bild `[H01]:[m01]`. `$toMillis` akzeptiert
  nur streng geprüfte UTC-ISO-Zeitstempel ohne Formatbild. Der Validator prüft
  diese Regeln sowohl beim Speichern als auch vor jeder Auswertung; Bilder und
  Optionen aus Antwortdaten werden abgewiesen.
  `$replace` erfordert ein Zeichenkettenmuster und ein festes Ganzzahllimit von
  höchstens zehn Treffern. Jeder Knoten und jede Kind-Eigenschaft wird geprüft,
  auch Prädikate an Funktionsreferenzen, Pfadstufen, Argumente, Gruppen und
  beide Seiten binärer Ausdrücke. Höchstens 64 AST-Knoten und 12 Ebenen sind
  zulässig.

  Eine Funktions-Blockliste wäre keine Sicherheitsgrenze: Sie betrachtet nur
  bekannte Funktionsnamen und kann unbekannte Knotentypen, neu eingeführte
  JSONata-Konstrukte oder Eigenschaften außerhalb des üblichen Arguments
  übersehen. Zum Beispiel trägt `$join[$pad(...)](...)` sein Prädikat an der
  Prozedurvariable; ein Walk, der nur Funktionsargumente untersucht, sieht es
  nicht. Die Allowlist weist alle Konstrukte und Eigenschaften zurück, die
  nicht einzeln freigegeben wurden, darunter Regexliterale, Array- und
  Objektkonstruktoren, freie Prädikate, Wildcards, Nachfahrenzugriffe, Sortieren,
  Gruppieren, Transformieren, Blöcke, Bindings, Lambdas, partielle Anwendung,
  Funktionsverkettung und Bereiche. Dadurch sind synchrone Regexauswertung, das
  Parsen eines zweiten Ausdrucks aus Antwortdaten, Lambda-Auswertung und
  benutzerdefinierte Funktionsdefinitionen ausgeschlossen.

  JSONatas eingebaute Implementierungen für potenziell teure Format-, Datums-,
  Zeichenketten- und Aggregatfunktionen werden pro Ausdruck durch eigene
  gebundene Funktionen gleichen Namens ersetzt: `$string`, `$number`,
  `$length`, `$substring`, `$substringBefore`, `$substringAfter`, `$uppercase`,
  `$lowercase`, `$trim`, `$contains`, `$join`, `$sum`, `$max`, `$min`,
  `$average`, `$count`, `$round`, `$floor`, `$ceil`, `$abs`, `$formatNumber`,
  `$fromMillis`, `$toMillis`, `$split` und `$replace`. Zahlenformatierung
  verwendet `Intl.NumberFormat` mit den obigen festen Optionen und weist
  nichtendliche Zahlen ab. Datumsfunktionen verwenden begrenzte ISO-Prüfungen
  und UTC-Felder, keine JSONata-Bildparser oder benutzerdefinierten Regexe.
  Zeichenkettenarbeit ist auf 8.192 Zeichen pro Aufruf begrenzt; erzeugte
  Zeichenketten werden während des Aufbaus auf 2.000 Zeichen gekürzt. `$split`
  liefert höchstens 1.000 Teile. `$join`, `$sum`, `$max`, `$min`, `$average`
  und `$count` verarbeiten höchstens 1.000 Elemente. Jeder arithmetische
  Operator wird intern durch eine geprüfte Implementierung ausgewertet;
  nichtendliche Zwischenergebnisse machen den Ausdruck nicht verfügbar.
  Unverändert bleiben nur die einfachen eingebauten Funktionen `$boolean`,
  `$not`, `$exists` und `$now`. Auch die fertige Ausgabe wird auf 2.000 Zeichen
  gekürzt. Das Ergebnis eines Vorlagenlaufs wird je
  Quellen-Ausdruck-Paar höchstens einmal berechnet; höchstens zehn verschiedene
  Paare werden ausgewertet. JSONatas 10-ms-Option wird nicht verwendet: Sie
  prüft nur zwischen Auswertungsschritten, kann unter Last einfache Ausdrücke
  zurückweisen und bietet keine harte CPU-Garantie. Es gibt keine vom Nutzer
  bereitgestellten Hostfunktionen oder Bindings; registrierte interne
  Implementierungen sind nicht aus Ausdrücken aufrufbar.
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
6.000-Elemente-Antwort. Mit stubbed Fetch misst er den kalten und warmen
D1-Cachepfad und protokolliert die höchste Thread-CPU-Zeit seiner fünf
Durchläufe. Diese Messung läuft in Node. Sie beschreibt weder Workers-CPU noch
garantiert sie dort ein 10-ms-Budget.

Die verbleibende Leistungsgrenze ist die durch statische Regeln eingehegte
Auswertungsarbeit: Antwortgröße, AST-Länge, Eingabetiefe, Knotenzahl,
Sequenzlänge, Zeichenkettenausgabe und verschiedene Ausdrücke pro Vorlagenlauf
sind begrenzt. D1-Cachetreffer vermeiden Netzwerkabrufe, aber nicht die
Auswertung; das Zehn-Paar-Limit gilt daher auch bei warmem Cache. Es gibt keine
Behauptung, dass diese Grenzen eine bestimmte Workers-CPU-Zeit garantieren.
