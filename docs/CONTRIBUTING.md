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

**Granularität:** Ein Commit ist eine inhaltlich vollständige Änderung samt Tests, Doku und Config. Keine Mikro-Commits, kein Commit pro Datei, kein Zwischenstand, der für sich nicht steht.

**Betreff:** Imperativ, höchstens 50 Zeichen, danach eine Leerzeile.

**Body:** Bullet Points, nach Art gruppiert, jede Gruppe mit ihrem eigenen Icon und Unterpunkten, zum Beispiel eine Gruppe `- 🐛 Defects:` mit darunterliegenden Punkten. Konkret statt allgemein: Funktion, Wert und beobachtetes Verhalten benennen. Nur was ein Leser braucht, kompakt. Issue- oder Ticketnummer referenzieren, falls vorhanden.

Keine Attribution-Trailer und keine `claude.ai/code`- oder `session_`-URLs in Commits, Pull Requests oder Dateien. Commit-Messages und Projektdokumentation sind auf Deutsch; technische Bezeichner bleiben unverändert.

**Icon-Legende:**

🚀 perf · ✨ feat · 🛠 improve · 🐛 fix · 📊 db · 🔄 refactor · 📝 docs · 🧪 test · 🔒 security · ⚙️ config · 🎨 style · ⬆️ deps · 🔧 chore

**Beispiel:**

```text
🐛 fix(worker): healthz meldet alle fehlenden Secrets

- 🐛 Defects:
  - /healthz brach bei fehlendem Secret nach dem ersten Namen ab
    statt alle fehlenden Namen aus secrets.required zu melden
- 🧪 Tests:
  - Testfall für mehrere gleichzeitig fehlende Secrets ergänzt
```

## Sicherheit

Keine Secrets, Tokens, privaten Env-Dateien oder echten Betreiberwerte committen. Platzhalter gehören nur in die ausdrücklich vorgesehenen Beispielvorlagen. Secret-Werte niemals in Terminalausgaben, Tickets, Screenshots oder Review-Kommentare kopieren.
