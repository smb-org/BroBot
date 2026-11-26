# Entscheidung 0014: Discord-Verknüpfungen und Rollenabgleich

## Status

Angenommen.

## Kontext

BroBot gleicht VIP- und Moderator-Rollen zwischen Twitch und einem verknüpften
Discord-Konto ab. Ein Rollenabgleich muss erkennen, welche Rollen BroBot selbst
hinzugefügt hat. Er darf vorhandene manuelle Rollen nicht entfernen und muss
nach einem Abbruch feststellen können, ob ein Discord-Aufruf erfolgreich war.

## Entscheidung

Discord- und Twitch-IDs werden als unveränderte Zeichenketten gespeichert. Die
Discord-API benötigt Discord-IDs für Mitglieder- und Rollenaufrufe. Der Abgleich
verknüpft außerdem `discord_links`, Twitch-Ränge und Vergaben anhand dieser IDs.
Ein Hash könnte diese Vorgänge ohne zusätzlichen geheimen Rückübersetzungsspeicher
nicht durchführen. Die IDs sind deshalb Betriebsdaten und werden wie andere
Kontodaten nur für die benötigten Funktionen verwendet.

Die Speicherorte sind:

- D1 `discord_links`: Discord- und Twitch-ID, Anzeigenamen, Twitch-Login sowie
  Zeitpunkte der Verknüpfung und Prüfung.
- D1 `discord_guilds` und `discord_role_mappings`: Serververbindung und die
  zugeordneten VIP- und Moderator-Rollen.
- D1 `discord_bot_token_lock`: globale Sperre mit Sperr- und letztem Prüfzeitpunkt.
- Channel-DO-SQLite: Vergabe-Ledger mit Server-, Discord-, Twitch- und Rollen-ID,
  `joined_at`, Vergabezeitpunkt und Status; Reconcile-Cursor; Sperren für Server
  und Zuordnungen; Teardown- und Trennzustand; Mitgliedsstatus; Rollennamen sowie
  einmalige Chat-Hinweise.

Vor einem Rollen-`PUT` schreibt BroBot einen Ledger-Eintrag mit Status `pending`.
Nur wenn der direkte Mitgliederabruf die Rolle noch nicht enthält, wird dieser
Eintrag angelegt. Nach bestätigtem `PUT` wird der Status `granted`. Ein späterer
Abgleich klärt offene `pending`-Einträge anhand von Rolle und `joined_at`.
Entfernt wird ausschließlich eine Rolle mit passendem Ledger-Eintrag und
unverändertem `joined_at`.

## Löschregeln

- Beim Lösen einer Verknüpfung oder bei einem Verknüpfungskonflikt entfernt der
  nächste Abgleich die zugehörigen verwalteten Rollen ohne auf einen vollständigen
  Rangabruf zu warten. Die Verknüpfungszeile selbst wird beim Lösen gelöscht;
  Konflikte ersetzen die betroffenen Verknüpfungszeilen.
- Beim Trennen eines Servers löscht BroBot zuerst die Rollen aus dem Ledger und
  danach die Serververbindung und Zuordnungen. Bleibt der Server unerreichbar,
  wird nach 30 Tagen die Verbindung getrennt und das verbleibende Ledger verworfen.
- Beim Deaktivieren entfernt BroBot zuerst die verwalteten Rollen. Währenddessen
  bleibt das Modul aktiv und Änderungen sind gesperrt. Nach dem letzten Entfernen
  wird das Modul deaktiviert.
- Bei abgeschlossenem Teardown oder Trennen werden auch die pro Kanal gespeicherten
  Chat-Hinweise gelöscht. Das gilt ebenso für die 30-Tage-Aufgabe bei unerreichbarem
  Server.
- Ein nicht mehr vorhandenes Discord-Mitglied verliert seine Ledger-Zeilen für
  diesen Server. Die gewünschte Rolle bleibt für einen späteren Abgleich vorgemerkt.

Die Liste der tatsächlich zugewiesenen Discord-Rollen wird nicht als dauerhaftes
Spiegelbild gespeichert. Sie wird bei Bedarf über Discord gelesen; der lokale
Ledger bleibt die Autorität dafür, welche Rollen BroBot entfernen darf.
