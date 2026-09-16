# Architektur

Die vollständige Stack-Entscheidung liegt in [Decision 0001](decisions/0001-stack-und-plattform.md). Dieses Dokument beschreibt, wie sie für das Grundgerüst von BroBot umgesetzt wird.

## Laufzeit und Datenfluss

Eine Cloudflare-Worker-Deployment-Einheit liefert die statischen React-Dateien und später API-, EventSub- und WebSocket-Routen aus. Das Gerüst beantwortet bereits `/healthz` und reicht alle anderen Anfragen an Static Assets weiter.

```text
Twitch EventSub
      │ Webhook
      ▼
Worker / Hono ───────► D1
      │                 │ Konfiguration und Verbindungen
      │ channelId
      ▼
Channel Durable Object (SQLite + WebSocket-Hibernation)
      │ WebSocket
      ▼
OBS-/StreamElements-Overlay
```

Der spätere Ereignisfluss ist: EventSub → Worker → fachliches Modul → Channel Durable Object → Overlay. Ein Durable Object wird deterministisch aus dem `channelId`-Namen angesprochen. Der Worker bleibt das Gateway für HTTP und die Module; der DO hält den kanalbezogenen Echtzeitraum.

## Modulsystem

Ein Modul ist ein Feature-Slice unter `src/modules/<id>/` mit `contracts/`, `domain/`, `service.ts`, `repository.ts`, `adapters/` und `ui/`. Sein `BotModule`-Contract beschreibt Settings, Migrationen, EventSub-Typen, Commands, Routen und ein lazy Overlay.

`src/modules/registry.ts` ist die einzige Stelle, die alle Module kennt. Später mountet der Worker die registrierten Router unter `/api/modules/<id>`. Ein Modul wird aktiviert, indem in `channel_modules` eine Zeile für den jeweiligen `channel_id` und `module_id` mit `enabled = 1` steht. Dafür ist kein Deploy erforderlich.

Das Overlay lädt seine Quelle über einen `import()`-Promise. Dadurch kann Vite Overlay-Code in einen eigenen Chunk schneiden; ein deaktiviertes Modul kostet im Overlay-Bundle null Bytes. Der direkte Import wäre deshalb eine bewusst zu vermeidende Bundle-Kopplung.

ESLint schützt die Grenze: Overlay- und Modul-UIs importieren weder Worker-, Service-, Repository- oder Adaptercode noch Zod. Module importieren keine Geschwistermodule. Der Worker importiert kein React.

## Verbindliche Architekturentscheidungen

1. **Kein `BROADCASTER_ID`-Secret.** Der Kanal kommt aus Route und Session. `ALLOWED_CHANNEL_LOGINS` ist eine nicht geheime Komma-Liste und steuert, welcher Kanal freigeschaltet ist. So wird ein Kanal nicht durch einen geheimen Konfigurationswert mit der Identität des Benutzers verwechselt.
2. **`channelId` ist der Mandantenschlüssel.** Jede Tabelle trägt `channel_id`; derselbe Schlüssel bildet später den Durable-Object-Namen. Funktional bleibt genau ein Kanal freigeschaltet. Es gibt kein Onboarding, keine Quoten und keine Abrechnung.
3. **`twitch_connections` ist eine eigene Tabelle.** Eine Verbindung gehört zu Kanal und Zweck (`broadcaster` oder `bot`) und speichert Scopes sowie Ablauf. Verschlüsselte Tokens hängen an der Verbindung, nicht am Kanal, damit beide Twitch-Zwecke getrennt rotierbar bleiben.
4. **`channel_members` existiert ab Tag 1.** Autorisierung fragt immer, ob ein User in genau diesem Kanal zugelassen ist. Eine globale Rolle außerhalb des Kanalmandanten gibt es nicht.

Diese Entscheidungen halten den ersten Betrieb klein und bewahren trotzdem die notwendige Trennung zwischen Kanal, Benutzer, Twitch-Verbindung und Modulaktivierung.

## Mandantenmodell

`channelId` wird aus Route und Session in die jeweilige Kanaloperation übernommen und in jeder persistierenden Tabelle als `channel_id` geführt. Die Initialmigration enthält nur die Tabellen, die das Grundgerüst trägt: `channels`, `channel_members`, `twitch_connections` und `channel_modules`.

Die Datenstruktur ist damit mandantenfähig geschnitten, aber das Produkt ist absichtlich auf genau einen freigeschalteten Login begrenzt. Weitere Kanäle werden nicht automatisch angelegt und erhalten keine implizite Berechtigung.
