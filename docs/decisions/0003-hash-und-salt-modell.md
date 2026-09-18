# Hash- und Salt-Modell für Nutzerbezug

**Stand:** 18. September 2026
**Status:** entschieden, siehe [#1](https://github.com/smb-org/BroBot/issues/1)
**Betrifft:** #10, #12, #14, #28, #30 — jedes Modul, das Nutzerdaten schreibt

---

## 1. Kurzfazit

1. **Zwei getrennte Hash-Räume**, nicht einer. Sie unterscheiden sich nicht im Verfahren, sondern in der Lebensdauer ihres Schlüssels — und genau daraus folgt alles Weitere.
2. **Gehasht wird mit HMAC und einem geheimen Schlüssel**, nicht mit einem blanken Hash. Ein Twitch-Login ist kurz, öffentlich und aufzählbar; ein ungesalzener Hash darüber ist in Minuten rückrechenbar.
3. **Der kanalweite Schlüssel wird nicht turnusmäßig rotiert.** Eine Rotation über bereits gehashte Daten ist technisch nicht möglich — sie ist gleichbedeutend mit dem Löschen der Historie. Das ist eine Notfallmaßnahme, kein Wartungsvorgang.
4. **Trinkgeld-Spender werden gar nicht gehasht**, weil sie gar nicht gespeichert werden.

---

## 2. Warum HMAC und nicht „gehasht"

Ein Hash allein schützt hier nichts. Twitch-Logins sind vier bis fünfundzwanzig Zeichen lang, öffentlich sichtbar und lassen sich in großen Mengen abrufen. Wer eine Tabelle mit SHA-256-Werten über Logins in die Hände bekommt, rechnet sie mit einer Namensliste in kurzer Zeit zurück.

Wirksam ist der Bezug nur, wenn in die Berechnung ein **Geheimnis** eingeht, das nicht neben den Daten liegt. Verwendet wird deshalb durchgehend:

```
hash = HMAC-SHA-256(schlüssel, channelId ‖ userId)
```

Zwei Eigenschaften daran sind Absicht:

**`channelId` geht in die Berechnung ein.** Dieselbe Person in zwei Kanälen ergibt zwei verschiedene Werte. Der Betreiber kann aus seinen eigenen Daten nicht ablesen, dass zwei Einträge dieselbe Person betreffen. Das kostet nichts und verhindert eine Auswertung, die niemand angefordert hat.

**Verwendet wird die Twitch-User-ID, nicht der Login.** Logins lassen sich ändern und neu vergeben; die ID ist stabil. Ein Bezug über den Login würde nach einer Umbenennung auf die falsche Person zeigen.

---

## 3. Die zwei Räume

### Flüchtiger Raum — Schlüssel stirbt mit dem Vorgang

**Wofür:** Stimmen bei einem Chat-Voting (#10), Zählung unterschiedlicher Nutzer in einem gleitenden Fenster (#12).

**Schlüssel:** 32 zufällige Bytes, erzeugt beim Start des Vorgangs, gespeichert neben dem Vorgang selbst.

**Lebensdauer:** Der Schlüssel wird mit dem Vorgang gelöscht — beim Schließen eines Votings, beim Ablauf eines Fensters. Danach ist der Bezug **endgültig** weg: Es gibt kein Geheimnis mehr, mit dem sich ein Wert einer Person zuordnen ließe, auch nicht für uns.

**Was bleibt:** Das Ergebnis. „Option A: 47 Stimmen" ist keine personenbezogene Angabe und darf unbegrenzt bleiben.

Das ist die stärkste Schutzwirkung, die überhaupt erreichbar ist, und sie kostet nichts: Nach dem Vorgang gibt es schlicht nichts mehr zu schützen.

### Kanalweiter Raum — Schlüssel bleibt

**Wofür:** Aktivitätszähler über Streams hinweg (#14) — etwa, um wiederkehrende Zuschauer zu erkennen.

**Schlüssel:** Ein Betreiber-Secret `USER_HASH_PEPPER`, nach demselben Muster wie `OVERLAY_TOKEN_PEPPER`. **Nicht** je Kanal, weil `channelId` bereits in die Berechnung eingeht — ein Geheimnis genügt und ist leichter sicher zu halten als viele.

**Lebensdauer:** Dauerhaft, solange der Zähler geführt wird.

**Folge:** Diese Daten bleiben personenbezogen. Sie sind pseudonymisiert, nicht anonymisiert — solange der Schlüssel existiert, ist der Bezug wiederherstellbar. Daraus folgen zwingend Löschfristen und ein Weg für Betroffenenanfragen.

---

## 4. Rotation — was wirklich passiert

Ein kanalweiter Schlüssel lässt sich **nicht** rotieren wie ein Signaturschlüssel. Um bestehende Zeilen auf einen neuen Schlüssel umzurechnen, bräuchte man die ursprünglichen User-IDs im Klartext — genau die speichern wir nicht.

Eine Rotation bedeutet deshalb in der Sache:

- Alle bestehenden Zeilen sind ab sofort niemandem mehr zuzuordnen. Sie sind damit anonym — aber auch auf Anfrage **nicht mehr löschbar**, weil niemand sie findet.
- Alle Zähler beginnen bei null.

**Deshalb wird nicht turnusmäßig rotiert.** Eine Rotation ist eine Notfallmaßnahme, wenn der Schlüssel abgeflossen ist. Sie wird dann zusammen mit dem **Löschen** der betroffenen Zeilen durchgeführt, nicht statt dessen — sonst bleibt ein Bestand zurück, den man nicht mehr aufräumen kann.

Beim flüchtigen Raum stellt sich die Frage nicht: Dort ist jeder Vorgang sein eigener Schlüssel.

---

## 5. Löschfristen

| Datenart | Frist | Begründung |
|---|---|---|
| Stimmen eines Votings | mit dem Schließen, spätestens **24 Stunden** nach Ende | Der Zweck endet mit der Auswertung |
| Gleitendes Fenster der Themen-Erkennung | mit dem Fensterablauf, spätestens **am Streamende** | #12 sieht ohnehin Verfall am Streamende vor |
| Kanalweite Aktivitätszähler je Person | **180 Tage** rollierend | Wiederkehrende Zuschauer zu erkennen braucht Monate, nicht Jahre |
| Audit-Einträge | **24 Monate** | Administrative Nachvollziehbarkeit; betrifft Bedienende, nicht Zuschauer |
| Aggregate ohne Personenbezug | unbegrenzt | siehe Abschnitt 6 |

Die Fristen werden durch einen Lauf durchgesetzt, nicht durch Vorsatz. Der stündliche Cron-Trigger aus #18 ist der naheliegende Ort.

**180 Tage ist eine Setzung, keine Ableitung.** Sie lässt sich verkürzen, ohne dass etwas kaputtgeht — verlängern dagegen nicht, weil die Daten dann schon weg sind. Im Zweifel also kürzer.

---

## 6. Was nicht personenbezogen ist

Unbegrenzt bleiben dürfen ausschließlich Werte **ohne jeden Bezug zu einer einzelnen Person**:

- Nachrichten pro Zeitfenster, Zuschauerzahl, Emote-Spitzen
- Wortfrequenz-Baseline aus #12 — aggregiert über alle Nutzer, ohne Zuordnung
- Ergebnisse abgeschlossener Votings und Quizrunden
- Summen von Trinkgeldern je Stream
- Zeitpunkte von Clips und Stream-Abbrüchen

**Die Abgrenzung ist schärfer, als sie klingt.** Ein Zähler „unterschiedliche Chatter" ist ein Aggregat. Eine Liste „diese Hashes waren aktiv" ist es nicht, auch wenn sie nur aus Hashes besteht. Im Zweifel gilt eine Reihe, die je Person eine Zeile führt, als personenbezogen — unabhängig davon, wie die Spalte heißt.

---

## 7. Betroffenenanfragen

Nur der kanalweite Raum ist auskunfts- und löschfähig. Der Ablauf:

1. Die betroffene Person nennt ihren Twitch-Namen
2. Der Name wird über Helix zur stabilen User-ID aufgelöst
3. Der Hash wird mit `USER_HASH_PEPPER` und der `channelId` berechnet
4. Über den Hash werden die Zeilen gefunden, ausgegeben oder gelöscht

Das setzt voraus, dass der Hash **indiziert** ist — sonst wird eine Anfrage zu einem vollständigen Tabellendurchlauf. Jede Tabelle im kanalweiten Raum bekommt deshalb einen Index auf die Hash-Spalte.

**Für den flüchtigen Raum gibt es keine Auskunft**, und das ist kein Versäumnis: Die Daten existieren höchstens Stunden und sind danach auch für uns nicht mehr zuzuordnen. Auf eine Anfrage wird wahrheitsgemäß geantwortet, dass zu dieser Person nichts vorliegt.

Dieser Ablauf gehört in `docs/OPERATIONS.md`, nicht nur hierher — er wird gebraucht, wenn niemand Zeit hat, eine Entscheidung zu lesen.

---

## 8. Trinkgelder: gar nicht erst speichern

#28 und #30 bringen erstmals personenbezogene Daten aus einem Fremddienst — Name, Nachricht, bei Ko-fi zusätzlich E-Mail-Adresse und bei Shop-Bestellungen die Lieferanschrift.

**Diese Daten werden nicht gehasht, sondern nicht gespeichert.** Der Name wird für die Ansage gebraucht und danach verworfen. Persistiert wird ausschließlich die Summe je Stream, ohne Bezug zum Spender.

Das ist kein Sonderfall, sondern die konsequente Anwendung derselben Frage: Wofür wird der Bezug gebraucht? Für eine Ansage im Chat wird er für Sekunden gebraucht, nicht für Tage. Ein Hash wäre hier eine Scheinlösung — er würde Daten aufbewahren, für die es keinen Zweck gibt.

---

## 9. Folgen

- Neues Betreiber-Secret `USER_HASH_PEPPER`, 32 Byte base64url, nach dem Muster von `OVERLAY_TOKEN_PEPPER` — einschließlich Formatprüfung in Preflight und `/healthz`
- Jede Tabelle im kanalweiten Raum führt eine indizierte Hash-Spalte
- Der stündliche Cron-Lauf setzt die Löschfristen durch
- `docs/OPERATIONS.md` beschreibt den Ablauf einer Betroffenenanfrage
- #10 und #12 arbeiten ausschließlich im flüchtigen Raum
- #14 ist das einzige Modul im kanalweiten Raum
- #28 und #30 speichern keinen Personenbezug
