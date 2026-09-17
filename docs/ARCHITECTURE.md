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

Ein Modul ist ein Feature-Slice unter `src/modules/<id>/` mit `contracts/`, `domain/`, `service.ts`, `repository.ts`, `adapters/`, `overlay/` und `panel/`. Sein `BotModule`-Contract beschreibt Settings, Migrationen, EventSub-Typen, Commands, Routen sowie ein lazy Overlay und eine optionale lazy Panel-Ansicht.

`src/modules/registry.ts` ist die einzige Stelle, die alle Module kennt. Später mountet der Worker die registrierten Router unter `/api/modules/<id>`. Ein Modul wird aktiviert, indem in `channel_modules` eine Zeile für den jeweiligen `channel_id` und `module_id` mit `enabled = 1` steht. Dafür ist kein Deploy erforderlich.

Das Overlay und das Panel laden ihre Quellen über einen `import()`-Promise. Dadurch kann Vite beide Ansichten in eigene Chunks schneiden; ein deaktiviertes Modul kostet in keinem der beiden Bundles Bytes. Direkte Imports wären deshalb bewusst zu vermeidende Bundle-Kopplungen.

ESLint schützt die Grenze: Overlay-Ansichten importieren weder Worker-, Service-, Repository- oder Adaptercode noch Zod. Panel-Ansichten importieren weder Worker-, Repository- noch Adaptercode; Zod und der Service sind dort für Formulare und ausgelöste Anwendungsfälle erlaubt. Module importieren keine Geschwistermodule. Der Worker importiert kein React.

### Panel

Das Admin- und Mod-Panel ist die primäre Bedienoberfläche. Sein Grundgerüst gehört dem Host; die konkrete Ansicht kommt pro Modul optional über den `BotModule`-Contract hinzu. Overlay- und Panel-Ansichten werden lazy geladen, damit ein deaktiviertes Modul in keinem der beiden Bundles Gewicht trägt.

Serverdaten bleiben autoritativ: Eine Live-Nachricht meldet nur, dass sich etwas geändert hat; den aktuellen Stand lädt das Panel über die API nach.

## Verbindliche Architekturentscheidungen

1. **Kein `BROADCASTER_ID`-Secret.** Der Kanal kommt aus Route und Session. `ALLOWED_CHANNEL_LOGINS` ist eine nicht geheime Komma-Liste und steuert, welcher Kanal freigeschaltet ist. So wird ein Kanal nicht durch einen geheimen Konfigurationswert mit der Identität des Benutzers verwechselt.
2. **`channelId` ist der Mandantenschlüssel.** Jede Tabelle trägt `channel_id`; derselbe Schlüssel bildet später den Durable-Object-Namen. Funktional bleibt genau ein Kanal freigeschaltet. Es gibt kein Onboarding, keine Quoten und keine Abrechnung.
3. **`twitch_connections` ist eine eigene Tabelle.** Eine Verbindung gehört zu Kanal und Zweck (`broadcaster` oder `bot`) und speichert Scopes sowie Ablauf. Verschlüsselte Tokens hängen an der Verbindung, nicht am Kanal, damit beide Twitch-Zwecke getrennt rotierbar bleiben.
4. **`channel_members` existiert ab Tag 1.** Autorisierung fragt immer, ob ein User in genau diesem Kanal zugelassen ist. Eine globale Rolle außerhalb des Kanalmandanten gibt es nicht.

Diese Entscheidungen halten den ersten Betrieb klein und bewahren trotzdem die notwendige Trennung zwischen Kanal, Benutzer, Twitch-Verbindung und Modulaktivierung.

## Mandantenmodell

`channelId` wird aus Route und Session in die jeweilige Kanaloperation übernommen und in jeder persistierenden Tabelle als `channel_id` geführt. Die Initialmigration enthält nur die Tabellen, die das Grundgerüst trägt: `channels`, `channel_members`, `twitch_connections` und `channel_modules`.

Die Datenstruktur ist damit mandantenfähig geschnitten, aber das Produkt ist absichtlich auf genau einen freigeschalteten Login begrenzt. Weitere Kanäle werden nicht automatisch angelegt und erhalten keine implizite Berechtigung.
