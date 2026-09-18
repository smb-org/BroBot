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

1. **Kein `BROADCASTER_ID`-Secret.** Der Kanal kommt aus Route und Session; die Freigabe erfolgt über eine Zeile in `channels`, nicht über einen Konfigurationswert. So wird ein Kanal nicht durch einen geheimen Konfigurationswert mit der Identität des Benutzers verwechselt.
2. **`channelId` ist der Mandantenschlüssel.** Jede Tabelle trägt `channel_id`; derselbe Schlüssel bildet den Durable-Object-Namen. Der Bot unterstützt den Mehrkanalbetrieb mit kanalweiser Drosselung; offene Selbstanmeldung und Abrechnung sind nicht vorgesehen.
3. **`twitch_connections` ist eine eigene Tabelle.** Eine Broadcaster-Verbindung gehört zu Kanal und Zweck (`broadcaster`) und speichert Scopes sowie Ablauf. Der `bot`-Wert bleibt im Check-Ausdruck für einen späteren kanalbezogenen Bot erhalten, wird aber in #18 nicht verwendet: Der laufende Bot autorisiert sich einmal global in `bot_identity`, weil ein rotierendes Refresh-Token nicht je Kanal dupliziert werden darf.
4. **Login-Tokens und Sessions bleiben getrennt.** `twitch_login_identity` hält die verschlüsselten Login- und Refresh-Tokens je Twitch-User; `auth_sessions` hält nur die kurzlebige, serverseitig widerrufbare Sitzung. Kein Token gelangt in Cookie oder Browser-Speicher.
5. **`channel_members` existiert ab Tag 1.** Autorisierung fragt immer, ob ein User in genau diesem Kanal zugelassen ist. Eine globale Rolle außerhalb des Kanalmandanten gibt es nicht.

Diese Entscheidungen halten den ersten Betrieb klein und bewahren trotzdem die notwendige Trennung zwischen Kanal, Benutzer, Twitch-Verbindung und Modulaktivierung.

## Mandantenmodell

`channelId` ist überall der Mandantenschlüssel: Jede persistierende Tabelle führt `channel_id`, und für jeden Kanal gibt es ein eigenes Durable Object. Der Bot läuft gleichzeitig in mehreren Kanälen.

Die Autorisierung ist ausdrücklich: Nur eine Zeile mit Rolle in `channel_members` berechtigt zur Bedienung. Eine Twitch-Moderatorrolle berechtigt nicht; sie dient beim Einrichten lediglich dazu, eine Vorschlagsliste vorzubelegen, standardmäßig ohne Zugriff. Auch Twitch-Nutzer ohne Rolle im Kanal sind berechtigbar, dann mit ausdrücklicher Sicherheitsabfrage.

Ein Kanal erscheint in der Auswahl eines Nutzers nur, wenn alle drei Bedingungen erfüllt sind: Es gibt eine Zugriffszeile in `channel_members`, der Kanal ist per OAuth verbunden und der Kanal ist in `channels` freigegeben.

Eine offene Selbstanmeldung ist bewusst nicht vorgesehen. Sie ließe sich ohne Datenmodelländerung ergänzen, bräuchte dann aber Quoten, Missbrauchsschutz sowie Datenexport und -löschung je Mandant.

EventSub-Kontingent und Helix-Rate-Limit gelten pro Client-ID, nicht pro Kanal. Deshalb braucht es eine Drosselung je Kanal, damit ein aktiver Kanal den anderen nicht die Aufrufe wegnimmt.
