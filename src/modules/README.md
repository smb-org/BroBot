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

Eine Panel-Ansicht rendert keine eigene Überschrift mit dem Modulnamen. Der
Host trägt Name, Kennung und Kurzbeschreibung im Eigenschaften-Inspektor; die
Ansicht beginnt direkt mit ihrem fachlichen Inhalt.

### Hülle und Bauteile der Panel-Ansicht

Die äußerste Ansicht liegt in `.module-stack` (normalerweise als `<section>`
mit `aria-label`). Diese Hülle ist die Gestaltungskonvention des Hosts: Sie
vererbt die Regeln für Beschriftungen, Eingabefelder, Textareas, Selects und
Hinweise an die Modul-Ansicht. Ohne `.module-stack` bleibt eine neue Ansicht
unformatiert und fällt auf das Browser-Standardaussehen zurück.

Eine Konfigurationsfläche teilt ihren Inhalt in `.config-section`-Abschnitte.
Jeder Abschnitt beginnt mit einer Überschrift in `.section-heading`, die von
einer Haarlinie getrennt wird; Container-Karten gehören nicht zu dieser Welt.
Die Feldhülle trägt genau eine Inhaltsstufe: `config-field--schmal` für
Zahlen und kurze Werte, `config-field--mittel` für Namen und Bezeichner oder
`config-field--breit` für Fließtext.

Eine Tabelle mit wählbaren Zeilen und der Inspektor ihrer gewählten Zeile
liegen zusammen in einem `.config-section.inspektor-bereich` mit genau zwei
direkten Kindern: zuerst `.inspektor-bereich__liste` (Überschrift, Tabelle,
Nachladen-Knopf, Fehler- und Leerzeile), dann der `.sub-inspector` — oder,
solange dessen Anlegen-Formular über den Plus-Knopf an der Überschrift
geöffnet ist, das Formular auf derselben Fläche. Ohne Auswahl und ohne
geöffnetes Formular bleibt die Fläche leer; beides schließt sich gegenseitig
aus. Wo die Fläche neben oder unter der Liste steht, entscheidet der Host
nach Fensterbreite (ab 1360 px daneben, darunter wie bisher im Fluss); die
Ansicht legt nur die Reihenfolge fest und bleibt selbst höchstens 960 px
breit. Inspektor wie Anlegen-Formular beginnen mit `.inspector-section__heading`
(Titel, Kennung in Mono, Schließen-Taste) und rufen bei Schließen und Escape
den vom Host gereichten Rückruf: Der Inspektor hebt die Auswahl auf und gibt
den Fokus an die Zeile zurück, das Formular schließt sich. Die Auswahl bleibt
beim Nachladen bestehen, solange die Zeile noch existiert. Zerstörende
Handlungen verwenden `button--danger`, stehen vom primären Knopf abgesetzt und
fragen mit `.inspector-confirmation` an Ort und Stelle nach. Eine Ansicht ohne
`.inspektor-bereich` bleibt einspaltig; sie bricht nicht, sie nutzt nur die
Breite nicht. Eine Liste fehlender Berechtigungen ist kein Inspektor und trägt
`.sub-inspector` nicht.

## Registrierung

1. Das Modulverzeichnis mit der Pflichtstruktur anlegen.
2. Einen `BotModule`-Wert mit `id`, Settings-Schema und Defaults definieren; optionale EventSub-Typen, `handleEvent`, Routen sowie ein lazy Overlay und/oder Panel nur bei Bedarf ergänzen.
3. Genau diesen Wert in `src/modules/registry.ts` in `MODULES` eintragen. Das ist die einzige globale Kenntnis aller Module.
4. Prüfen: `pnpm run check`.

Das erste Modul ist `src/modules/textbefehle/`. Es ist in der Registry als
`textbefehle` eingetragen, abonniert `channel.chat.message` und besitzt die
zentrale Migration `migrations/0010_modul_textbefehle.sql`. Die Tabelle
`textbefehle_commands` ist kanalgebunden; der D1-Adapter dieses Moduls liest
und schreibt ausschließlich diese Tabelle.

Der Host mountet registrierte Modulrouten kanalbezogen unter
`/api/channels/:channelId/modules/<id>`. Textbefehle stellen dort die
CRUD-Routen unter `/befehle` bereit. Die Host-Middleware prüft Session,
CSRF und Mitgliedschaft und gibt dem Modul anschließend den Akteur, eine
SQL-gebundene Mutationsautorisierung und eine vorbereitete Audit-Funktion für
Moduldatenänderungen weiter. Das Modul entscheidet selbst, ob es diese
Funktion nutzt; der Host erzwingt sie nicht rückwirkend.

## Aktivierung und Bundles

Ein Modul wird pro Kanal über das Panel aktiviert, nicht per Hand-SQL: Ein Broadcaster
oder Verwalter des Kanals ruft `GET /api/channels/:channelId/modules` auf, um die
Registry mit dem gespeicherten Zustand jedes Moduls zu sehen, und schaltet es über
`PATCH /api/channels/:channelId/modules/:moduleId` mit `{ "enabled": true }` ein oder
aus. Ein `bediener` darf die Liste lesen, aber nicht schreiben. Beim Einschalten
schreibt der Worker `defaultSettings` des Moduls in `channel_modules.settings`; eine
eigene Route zum Bearbeiten von Einstellungen gibt es bewusst nicht — dafür ist
`module.panel` aus dem Contract vorgesehen, sobald ein Modul eigene Einstellungen
braucht. Ein Modul kann zusätzlich über den Aktivierungshook einmalige, eigene
Initialdaten anlegen. Das erfordert keinen Deploy.

## Wie ein Modul zu seinem Ereignis kommt

`handleEvent` ist der fachliche Einstiegspunkt. Es beschreibt weiterhin in
`ModuleResult.actions`, was geschehen soll, und führt Chataktionen nicht selbst
aus; der Host führt sie aus und protokolliert ihren Ausgang. Für Module mit
eigenem Zustand erhält der Einstiegspunkt zusätzlich den
`ModuleExecutionContext`: Er enthält den D1-Binding und eine vom Host erzeugte,
kanalgebundene Mutationsautorisierung. Das Modul kapselt den Bindingzugriff in
seinem Adapter und kennt weder `channel_members` noch die Sitzungsprüfung.
Das Modul begründet Handeln oder Nicht-Handeln mit `diagnostics` (Entscheidung
0004).

Ein Ereignis erreicht ein Modul nur, wenn alle drei Bedingungen gelten: Das
Modul ist in diesem Kanal aktiviert, es steht in `MODULES`, und der Abo-Typ
steht in seinen `eventSubTypes`.

Der Zielkanal kommt aus dem geprüften Ereignis und wird dem Modul in
`ModuleEvent.channelId` mitgeteilt. Der Host löst außerdem den Akteur anhand
von `channel_members` auf und übergibt `actor` mit User-ID, Login und Rolle.
Eine Rolle `null` bedeutet, dass der Nutzer kein Mitglied dieses Kanals ist;
`actor: null` bedeutet, dass das Ereignis keinen Nutzer enthält.
Bei `channel.chat.message` leitet der Host zusätzlich aus den Twitch-Badges
den eigenständigen `ModuleEvent.chatStatus` ab. `founder` zählt dabei als
`abonnent`; `moderator` und `broadcaster` erfüllen auch niedrigere Stufen.
Ereignisse ohne Chatbezug tragen dort `null`. Ein Modul kann keinen anderen
Kanal angeben — die Mandantentrennung liegt beim Host.

Wirft `handleEvent`, hält das weder den Worker noch die übrigen Module auf. Der
Fehler landet als `host.modul.fehler` im Ereignisprotokoll.

Die optionalen Felder `overlay` und `panel` des Contracts müssen Funktionen sein, die jeweils ein `import()`-Promise zurückgeben. So kann Vite für beide Ansichten eigene Chunks schneiden; ein deaktiviertes Modul kostet im Overlay- und im Panel-Bundle null Bytes. Direkte Imports würden diese Bundle-Grenzen aufheben. Panel-Ansichten erhalten über `ModulePanelProperties` den bereits geprüften `channelId`.

Textbefehle werden im Panel angelegt, bearbeitet und entfernt. Jede Zeile hat
eine Art (`text` oder `liste`), einen Schalter und eine Mindeststufe
(`alle`, `abonnent`, `vip`, `moderator` oder `broadcaster`). Die Art `liste`
zählt beim Auslösen alle eingeschalteten Zeilen auf. Die angelegten Befehle
werden kanalbezogen als `!<name>` ausgelöst. `{user}` und `{channel}` werden
erst bei der Ausgabe ersetzt. Die atomare `beanspruchen`-Mutation setzt
`last_used_at`; scheitert sie wegen der Abkühlzeit, bleibt die Chataktion leer
und das Modul meldet `textbefehle.abgekuehlt`. Ein unbekannter, ausgeschalteter
oder für den Chatstatus zu niedriger `!`-Befehl erzeugt keine Chataktion,
sondern jeweils die Diagnose `textbefehle.unbekannt`,
`textbefehle.deaktiviert` bzw. `textbefehle.berechtigung`.

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
