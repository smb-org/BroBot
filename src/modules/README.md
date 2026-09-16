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
└── ui/            # React-Oberfläche und Overlay-nahe Darstellung
```

`contracts/` beschreibt, was das Modul nach außen anbietet. `domain/` kennt keine Cloudflare-Bindings und kein React. `service.ts` verbindet die fachlichen Regeln mit dem Repository-Interface. `repository.ts` beschreibt nur die benötigte Persistenz. `adapters/` enthält die Infrastrukturimplementierungen. `ui/` rendert und sammelt Eingaben, aber enthält keine Persistenz- oder Service-Aufrufe.

Overlay-Code bleibt möglichst klein. Unter `ui/` darf kein Worker-, Service-, Repository- oder Adaptercode und kein Zod importiert werden. Das wird durch ESLint geprüft.

## Registrierung

1. Das Modulverzeichnis mit der Pflichtstruktur anlegen.
2. Einen `BotModule`-Wert mit `id`, Settings-Schema und Defaults definieren; optionale EventSub-Typen, Routen und ein lazy Overlay nur bei Bedarf ergänzen.
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

Das optionale Overlay-Feld des Contracts muss eine Funktion sein, die ein `import()`-Promise zurückgibt. So kann Vite einen eigenen Chunk schneiden; ein deaktiviertes Modul kostet im Overlay-Bundle null Bytes. Ein direkter Import würde diese Bundle-Grenze aufheben.

## Grenzen

Module importieren einander nicht. Dadurch bleiben Settings, Domainregeln, Persistenz und UI eines Slices unabhängig austauschbar. Gemeinsame, modulübergreifende Verträge gehören in `src/modules/contract.ts`; fachliche Regeln gehören nicht in diesen Host-Contract. Der Worker kennt nur Host, Registry und die von der Registry bereitgestellten Schnittstellen.
