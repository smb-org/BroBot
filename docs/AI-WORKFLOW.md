# KI-Workflow

Arbeitsteilung zwischen KI-Agenten in diesem Projekt, damit alle Mitarbeitenden dieselbe Delegation nutzen.

## Rollenverteilung

| Aufgabe | Modell |
|---|---|
| Implementierung, alle Themen | Codex `gpt-6-luna`, Reasoning-Effort `xhigh` (Codex-CLI ≥ 0.155) |
| Implementierung, wenn Codex nicht verfügbar ist | Sonnet |
| Kleine Korrekturen mit klarer Ursache (CSS, eine Beschriftung, eine Bedingung; ein, zwei Dateien) | Sonnet — ein Codex-Lauf kostet hier mehr als die Arbeit |
| Review vor jedem Merge | Codex `gpt-6-sol`, Reasoning-Effort `xhigh`, nur lesend |
| Leichte Fleißarbeit: Test-Boilerplate, mechanische Edits, Formatierung, Doku-Anpassungen | Haiku oder Sonnet |
| Befunde bewerten, anspruchsvolle Konzepte, Architekturentscheidungen | Hauptmodell, nicht delegieren |

## Codex-Vorgeschichte

Am 2026-09-22 wurde Codex hier vorübergehend gesperrt. Mit den `gpt-5.6`-Modellen ist es in der Umbenennungsrunde
von Epic 1 viermal an derselben Sache gescheitert: Bei langen Umbenennungen über viele Dateien hielt
es die **eigenen** wachsenden Änderungen für einen fremden Prozess und rollte sie zurück, einmal bis
zu `killall -9` auf `node`, `pnpm`, `zsh` und `sh`.

Mit `gpt-6-luna` ist Codex wieder der Implementierer. Zeigt ein Lauf dasselbe Muster, wird er
abgebrochen und die Aufgabe an Sonnet übergeben.

## Vor dem Merge

Kein Pull Request wird gemergt, bevor beides erfüllt ist:

1. **Unabhängiges Review über den kompletten Diff** — Codex `gpt-6-sol`, `xhigh`, im Sandbox-Modus `read-only` in einem eigenen Worktree auf dem Stand des PRs. Jeder Befund wird am Code geprüft und entweder behoben oder mit Begründung verworfen. Grüne Tests und Stichproben ersetzen das Review nicht.
2. **CI grün und SonarCloud gelesen.** Die Branch-Protection von `main` verlangt `quality`. SonarCloud blockiert technisch nicht; seine Fehler-, Sicherheits- und Zuverlässigkeitsbefunde werden trotzdem vor dem Merge behoben. Eine rote Duplikationsschwelle allein hält den Merge nicht auf und wird als Aufräumaufgabe erfasst.

Das unabhängige Review ersetzt nicht die Verantwortung des Hauptmodells: Es bewertet jeden Befund selbst, entscheidet über Architekturfragen und verwirft Befunde nur mit Begründung.

Besonders genau zu prüfen sind Migrationen und Datenzugriffe: Umfang jedes `UPDATE`/`DELETE` (fehlendes oder zu weites `WHERE`), Tabellen-Neuaufbauten (Indizes, Constraints, Fremdschlüssel), Mandantentrennung über `channelId`. Scanner-Befunde werden gelesen und entschieden, nicht übergangen.

## Parallelität

Voneinander unabhängige Delegationen in einer Nachricht gemeinsam starten, statt sie zu serialisieren.

## Verbindliche Schranken

- Agentenausgaben werden vor dem Commit reviewt; kein Agent committet selbst.
- `pnpm run check` muss nach jeder Agentenrunde grün sein, bevor etwas gepusht wird.
- Die Projektregeln aus [CLAUDE.md](../CLAUDE.md) und [CONTRIBUTING.md](./CONTRIBUTING.md) gelten für Agenten unverändert — besonders die Modulgrenzen und das Verbot von Attribution-Trailern.
- Ein Agent, der etwas nicht Beauftragtes hinzufügt (zum Beispiel selbst geschriebene Typdeklarationen anstelle generierter), wird korrigiert statt übernommen.

## GitHub-Issues durch Agenten

- **Ein Agent beansprucht das Issue, bevor er mit der Arbeit beginnt** — durch Zuweisung an das Konto, unter dem er arbeitet. Erst zuweisen, dann arbeiten. Sonst arbeiten zwei Sitzungen unbemerkt am selben Issue.
- Vor dem Beanspruchen prüft er, ob das Issue bereits jemandem zugewiesen ist. An fremd zugewiesenen Issues wird nicht gearbeitet; wenn etwas festhängt, erst im Issue nachfragen.
- Ein Agent schließt ein Issue, dessen Ergebnis **kein** Merge ist — insbesondere einen Spike, sobald die Entscheidung als Kommentar festgehalten und, wo nötig, unter `docs/decisions/` dokumentiert ist.
- Ein Issue, das **Code** erledigt, wird nicht von Hand geschlossen. Das passiert über `Closes #N` beim Merge, damit die Verknüpfung zwischen Issue und Commit erhalten bleibt.
- Wird die Arbeit abgebrochen oder liegen gelassen, gibt der Agent die Zuweisung zurück, statt das Issue zu blockieren.
- Vor dem Anlegen eines Issues wird geprüft, ob es das Thema schon gibt — Duplikate kosten mehr als die Suche.
- Die Regel zum öffentlichen Repo aus [CONTRIBUTING.md](./CONTRIBUTING.md) gilt für Agenten unverändert: keine internen Einschätzungen in Issue-Texte übernehmen, auch nicht aus `docs/input/`.

Das Skill-Routing (welcher Assistenz-Skill für welche Aufgabe) steht in [CLAUDE.md](../CLAUDE.md).
