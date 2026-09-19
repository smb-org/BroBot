# Module

Ein Modul ist ein isolierter Feature-Slice unter `src/modules/<id>/`.

## Pflichtstruktur

```text
src/modules/<id>/
├── contracts/     # öffentliche Typen und fachliche Ein-/Ausgabeverträge
├── domain/        # reine Regeln und Werte ohne Worker-, UI- oder I/O-Abhängigkeit
├── service.ts     # Anwendungsfälle; orchestriert Domain und Repository
├── repository.ts  # kleines Interface für dauerhafte Daten
├── adapters/      # konkrete D1-, Durable-Object- oder externe Adapter
├── overlay/       # schlanke Overlay-Ansicht mit strikten Bundle-Grenzen
└── panel/         # Panel-Ansicht für Formulare und Bedienung
```

`contracts/` beschreibt, was das Modul nach außen anbietet. `domain/` kennt keine Cloudflare-Bindings und kein React. `service.ts` verbindet die fachlichen Regeln mit dem Repository-Interface. `repository.ts` beschreibt nur die benötigte Persistenz. `adapters/` enthält die Infrastrukturimplementierungen. `overlay/` und `panel/` rendern und sammeln Eingaben, greifen aber nur über die jeweils beschriebenen Grenzen auf den Rest des Moduls zu.

`overlay/` enthält ausschließlich die möglichst kleine Overlay-Ansicht. Dort darf kein Worker-, Service-, Repository- oder Adaptercode und kein Zod importiert werden. `panel/` enthält Formulare und Bedienung; dort sind Zod für Formularvalidierung und Zugriffe auf `service.ts` für das Auslösen von Anwendungsfällen erlaubt. Worker-, Repository- und Adaptercode bleibt auch dort verboten. Das wird durch ESLint geprüft.

## Registrierung

1. Das Modulverzeichnis mit der Pflichtstruktur anlegen.
2. Einen `BotModule`-Wert mit `id`, Settings-Schema und Defaults definieren; optionale EventSub-Typen, Routen sowie ein lazy Overlay und/oder Panel nur bei Bedarf ergänzen.
3. Genau diesen Wert in `src/modules/registry.ts` in `MODULES` eintragen. Das ist die einzige globale Kenntnis aller Module.
4. Prüfen: `pnpm run check`.

Das spätere Mounting verwendet die Registry und hängt Modulrouten unter `/api/modules/<id>` ein.

## Aktivierung und Bundles

Ein Modul wird pro Kanal durch eine Zeile in `channel_modules` aktiviert:

```sql
INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
VALUES ('<channelId>', '<id>', 1, '{}');
```

Das erfordert keinen Deploy. `settings` ist JSON und bleibt dem Modul-Contract untergeordnet.

Die optionalen Felder `overlay` und `panel` des Contracts müssen Funktionen sein, die jeweils ein `import()`-Promise zurückgeben. So kann Vite für beide Ansichten eigene Chunks schneiden; ein deaktiviertes Modul kostet im Overlay- und im Panel-Bundle null Bytes. Direkte Imports würden diese Bundle-Grenzen aufheben.

## Aktionen und Begründungen melden

Ein Modul beschreibt gewünschte Aktionen in der geordneten Liste `actions`.
Chat und Overlay sind semantisch getrennte Varianten; die Reihenfolge bleibt
erhalten und neue Aktionsarten können später additiv ergänzt werden. Das Modul
führt die Aktionen nicht selbst aus.

Zusätzlich meldet ein Modul eine fachliche Entscheidung über das Feld
`diagnostics`. Das gilt auch dann, wenn es keine Aktion erzeugt. So kann der
Host erklären, warum eine Aktion bewusst unterblieben ist.

```ts
return {
  actions: [{ kind: "chat", text: "Danke für den Raid!" }],
  diagnostics: [{
    code: "shoutout.unterdrueckt",
    detail: { grund: "raid_erkannt", zuschauer: 8, schwelle: 10 },
  }],
};
```

`code` ist eine stabile, maschinenlesbare Kennung. `detail` enthält nur die
kleinen Werte, die den Grund erklären, und wird vom Host als JSON gespeichert.
Das Modul schreibt weder selbst in `event_log` noch verwendet es eine
Logging-API. Das Modul begründet Nicht-Handeln. Der Host kennt Kanal, Modul,
`triggerId`, auslösenden Nutzer und Zeitpunkt und protokolliert Handeln und
dessen Ausgang mit host-erzeugten Diagnosen wie `chat.gesendet` oder
`shoutout.fehlgeschlagen` samt Ursache. Dieselbe Schreibfunktion übernimmt
auch die Begrenzung und Löschung der Zeilen; ein Executor existiert noch nicht.

## Grenzen

Module importieren einander nicht. Dadurch bleiben Settings, Domainregeln, Persistenz und UI eines Slices unabhängig austauschbar. Gemeinsame, modulübergreifende Verträge gehören in `src/modules/contract.ts`; fachliche Regeln gehören nicht in diesen Host-Contract. Der Worker kennt nur Host, Registry und die von der Registry bereitgestellten Schnittstellen.
