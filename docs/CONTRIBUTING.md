# Mitarbeit

## Issues

**Kategorisierung.** Jedes Issue trägt genau ein Modul-Label und, wo zutreffend, ein Art-Label:

- Modul-Labels: `modul:host` (Worker, Auth, Overlay-Grundlage, alles ohne eigenes Modul), `modul:polls`, `modul:voting`, `modul:clips`, `modul:themen`, `modul:raid`, `modul:quiz`, `modul:statistik`
- Art-Labels: `typ:epic` für ein Modul-Sammelissue mit Akzeptanzkriterien, `typ:spike` für eine zeitlich begrenzte Untersuchung, deren Ergebnis eine Entscheidung ist, kein Feature
- Die GitHub-Standardlabels bleiben in Gebrauch: `enhancement` für neue Funktionalität, `bug`, `documentation`, `question`
- **Milestones sind die Phasen** der Roadmap, nicht die Labels. Ein Issue ohne Milestone ist noch nicht eingeplant.

**Beanspruchen (Claiming).**

- Ein Issue wird beansprucht, indem man sich selbst zuweist. Nicht durch einen Kommentar allein.
- An einem Issue, das jemand anderem zugewiesen ist, wird nicht gearbeitet. Wenn es festhängt, erst im Issue nachfragen.
- Wer ein Issue länger nicht bearbeitet, gibt die Zuweisung zurück, statt es zu blockieren.
- Ein Epic wird nicht als Ganzes beansprucht; beansprucht werden die daraus geschnittenen Teilaufgaben.

**Schneiden.** Ein Epic beschreibt das Modul mit Akzeptanzkriterien. Teilaufgaben entstehen daraus erst, wenn das Modul näher rückt und man mehr weiß — nicht auf Vorrat.

**Verknüpfung mit Code.**

- Branch-Name enthält die Issue-Nummer, zum Beispiel `42-poll-queue`.
- Der Pull Request referenziert das Issue mit `Closes #42`, damit es beim Merge automatisch schließt. Issues werden nicht von Hand geschlossen, wenn Code sie erledigt.
  - **Das Schlüsselwort bleibt englisch**, auch wenn Commit-Messages und Beschreibung sonst deutsch sind. GitHub erkennt ausschließlich `close`/`closes`/`closed`, `fix`/`fixes`/`fixed` und `resolve`/`resolves`/`resolved`. Ein übersetztes „Schließt #42" schließt nichts — der Merge läuft durch, das Issue bleibt offen, und es fällt erst Wochen später auf. Am 20. September 2026 ist genau das mit #115 passiert.
- Ein Spike schließt mit einem Kommentar, der die getroffene Entscheidung festhält — das Ergebnis eines Spikes ist eine Entscheidung, kein Merge.

**Öffentliches Repo.** Das Repo ist öffentlich. Issues, Kommentare und Titel sind für jeden lesbar. Interne Einschätzungen, Zuschauerzahlen, Bewertungen fremder Dienste und persönliche Anekdoten gehören nicht hinein, sondern bleiben in den nicht versionierten Notizen unter [docs/input/](./input/). Issues beschreiben Anforderung, Akzeptanzkriterien und Technik.

## Branches und Pull Requests

1. Ausgangspunkt ist der aktuelle `main`-Branch.
2. Für jede Änderung einen kurzen Feature- oder Fix-Branch anlegen.
3. Änderungen klein halten, lokal prüfen und einen Pull Request gegen `main` öffnen.
4. Review-Kommentare einarbeiten; gemergt wird erst nach grüner CI.
5. Keine Commits direkt auf `main` und keine fachfremden Änderungen im selben Pull Request.

Vor dem Push muss `pnpm run check` lokal grün durchlaufen. CI prüft zusätzlich dieselbe Installations- und Browser-Teststrecke.

**Diese Regeln werden erzwungen, nicht nur vereinbart.** `main` ist geschützt:

- Änderungen nur über Pull Request; Direkt-Commits werden abgelehnt
- Die Prüfung `quality` muss grün sein — sie fährt dieselbe Strecke wie `pnpm run check`
- Der Zweig muss auf dem aktuellen Stand von `main` sein, damit zwei parallele Zweige einander nicht stillschweigend brechen
- Offene Kommentare am Pull Request blockieren den Merge
- Force-Push und Löschen von `main` sind gesperrt
- Der Schutz gilt **auch für Administratoren**

Freigaben sind bewusst **nicht** erforderlich: Einen eigenen Pull Request kann man bei GitHub nicht selbst freigeben, und bei der derzeitigen Besetzung würde das jede Arbeit blockieren. Die verbindliche Hürde ist die grüne CI.

**SonarCloud ist absichtlich keine Pflichtprüfung.** Es läuft mit und ist sichtbar, scheitert in diesem Projekt aber regelmäßig an der Duplikationsschwelle — Ursache sind fast immer Tests, die ihren Aufbau bewusst wiederholen. Zusammengefasste Tests sind an dieser Stelle schlechtere Tests. Sicherheitsbefunde von SonarCloud werden ernst genommen und behoben; die Duplikationsschwelle allein blockiert nichts.

Muss der Schutz im Notfall umgangen werden, geschieht das über die Repository-Einstellungen unter Branches — als bewusste Entscheidung, nicht nebenbei.

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

Keine Attribution-Trailer und keine `claude.ai/code`- oder `session_`-URLs in Commits, Pull Requests oder Dateien.

**Sprachen.** Commit-Messages, Issues und Pull Requests sind seit dem 22. September 2026 englisch; ältere bleiben, wie sie sind. Der Quelltext ist durchgehend englisch — Bezeichner, Kommentare, JSDoc und Testnamen. Ausgenommen sind allein die deutschen Hälften der zweisprachigen Kataloge (`src/dashboard/locale.ts`, `src/dashboard/labels.ts`, Modul-Sprachkataloge): das sind Übersetzungen für Nutzer. Diese Dokumentation ist noch deutsch, die Umstellung steht aus.

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
