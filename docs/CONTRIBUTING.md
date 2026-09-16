# Mitarbeit

## Branches und Pull Requests

1. Ausgangspunkt ist der aktuelle `main`-Branch.
2. Für jede Änderung einen kurzen Feature- oder Fix-Branch anlegen.
3. Änderungen klein halten, lokal prüfen und einen Pull Request gegen `main` öffnen.
4. Review-Kommentare einarbeiten; gemergt wird erst nach grüner CI.
5. Keine Commits direkt auf `main` und keine fachfremden Änderungen im selben Pull Request.

Vor dem Push muss `pnpm run check` lokal grün durchlaufen. CI prüft zusätzlich dieselbe Installations- und Browser-Teststrecke.

## Ordner- und Namenskonventionen

- Single-Package: keine `apps/`- oder `packages/`-Monorepo-Struktur ergänzen.
- TypeScript-Dateien verwenden klare, rollenbezogene Namen; React-Einstiegspunkte heißen `main.tsx`.
- Worker-Code liegt unter `src/worker/`, Dashboard unter `src/dashboard/`, Overlay unter `src/overlay/`.
- Fachliche Funktionalität kommt ausschließlich in Feature-Slices unter `src/modules/<id>/`.
- Ein neues Modul folgt [src/modules/README.md](../src/modules/README.md).
- Mandantenbezug immer über `channelId` beziehungsweise `channel_id`; kein `BROADCASTER_ID`-Secret einführen.

## Modul anlegen

Die Pflichtstruktur und der Registrierungsweg stehen in [src/modules/README.md](../src/modules/README.md). Kurzfassung: Contract und Registry ergänzen, das Modul isoliert halten, Aktivierung über `channel_modules` vorsehen und das Overlay lazy importieren.

## Commit-Messages

Format:

```text
<Icon> <type>(<modul>): summary
```

Der Betreff steht im Imperativ und ist höchstens 50 Zeichen lang. Der Body nutzt gruppierte Bullets, wenn zusätzliche Erklärung nötig ist. Keine Attribution-Trailer und keine `claude.ai/code`- oder `session_`-URLs in Commits, Pull Requests oder Dateien. Commit-Messages und Projektdokumentation sind auf Deutsch; technische Bezeichner bleiben unverändert.

## Sicherheit

Keine Secrets, Tokens, privaten Env-Dateien oder echten Betreiberwerte committen. Platzhalter gehören nur in die ausdrücklich vorgesehenen Beispielvorlagen. Secret-Werte niemals in Terminalausgaben, Tickets, Screenshots oder Review-Kommentare kopieren.
