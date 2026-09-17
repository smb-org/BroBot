# KI-Workflow

Arbeitsteilung zwischen KI-Agenten in diesem Projekt, damit alle Mitarbeitenden dieselbe Delegation nutzen.

## Rollenverteilung

| Aufgabe | Modell |
|---|---|
| Implementierung, alle Themen | Codex `gpt-5.6-luna` mit Reasoning-Effort `xhigh` |
| Zweitreview bei komplexen Themen | Codex `gpt-5.6-sol` mit `xhigh`, zusätzlich zum eigenen Review |
| Leichte Fleißarbeit: Test-Boilerplate, mechanische Edits, Formatierung, Doku-Anpassungen | Haiku oder Sonnet |
| Review, anspruchsvolle Konzepte, Architekturentscheidungen | Hauptmodell, nicht delegieren |

## Aufruf

```bash
codex exec -m gpt-5.6-luna -c model_reasoning_effort="xhigh"
```

Immer den vollen Modellnamen verwenden. Die Kurznamen `luna` und `sol` sind mit ChatGPT-Login nicht verfügbar und brechen im Task-Wrapper still mit Exit 137 ab. Ist Codex nicht verfügbar, ist Sonnet der Implementierungs-Fallback — nicht das Hauptmodell.

## Parallelität

Voneinander unabhängige Delegationen in einer Nachricht gemeinsam starten, statt sie zu serialisieren.

## Verbindliche Schranken

- Agentenausgaben werden vor dem Commit reviewt; kein Agent committet selbst.
- `pnpm run check` muss nach jeder Agentenrunde grün sein, bevor etwas gepusht wird.
- Die Projektregeln aus [CLAUDE.md](../CLAUDE.md) und [CONTRIBUTING.md](./CONTRIBUTING.md) gelten für Agenten unverändert — besonders die Modulgrenzen und das Verbot von Attribution-Trailern.
- Ein Agent, der etwas nicht Beauftragtes hinzufügt (zum Beispiel selbst geschriebene Typdeklarationen anstelle generierter), wird korrigiert statt übernommen.

## GitHub-Issues durch Agenten

- Agenten dürfen Issues anlegen und kommentieren, aber **nicht sich selbst oder anderen zuweisen** und **nicht schließen**. Beanspruchen und Schließen bleibt bei Menschen beziehungsweise passiert über `Closes #N` beim Merge.
- Ein Agent, der eine Aufgabe bearbeitet, prüft vorher, ob das Issue jemandem zugewiesen ist, und arbeitet nicht an fremd zugewiesenen Issues.
- Vor dem Anlegen eines Issues wird geprüft, ob es das Thema schon gibt — Duplikate kosten mehr als die Suche.
- Die Regel zum öffentlichen Repo aus [CONTRIBUTING.md](./CONTRIBUTING.md) gilt für Agenten unverändert: keine internen Einschätzungen in Issue-Texte übernehmen, auch nicht aus `docs/input/`.

Das Skill-Routing (welcher Assistenz-Skill für welche Aufgabe) steht in [CLAUDE.md](../CLAUDE.md).
