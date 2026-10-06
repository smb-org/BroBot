const picker = (
  de: { label: string; description: string },
  en: { label: string; description: string },
) => ({ de, en });

export const belaboxCatalog = {
  de: {
    unavailable: "BELABOX-Daten nicht verfügbar",
    connected: "verbunden",
    disconnected: "getrennt",
    phases: { healthy: "stabil", low: "Bitrate niedrig", disconnected: "Verbindung weg", inactive: "inaktiv" },
  },
  en: {
    unavailable: "BELABOX data unavailable",
    connected: "connected",
    disconnected: "disconnected",
    phases: { healthy: "healthy", low: "low bitrate", disconnected: "disconnected", inactive: "inactive" },
  },
} as const;

export const BELABOX_TEMPLATE_VARIABLES = [
  {
    name: "belabox.bitrate", maxLength: 32, sample: "4,520 kbps", external: true,
    picker: picker(
      { label: "Bitrate", description: "Aktuelle Relay-Bitrate in Kilobit pro Sekunde" },
      { label: "Bitrate", description: "Current relay bitrate in kilobits per second" },
    ),
  },
  {
    name: "belabox.bitrate_mbps", maxLength: 32, sample: "4.5 Mbit/s", external: true,
    picker: picker(
      { label: "Bitrate (Mbit/s)", description: "Aktuelle Relay-Bitrate in Megabit pro Sekunde" },
      { label: "Bitrate (Mbit/s)", description: "Current relay bitrate in megabits per second" },
    ),
  },
  {
    name: "belabox.rtt", maxLength: 24, sample: "38 ms", external: true,
    picker: picker(
      { label: "RTT", description: "Aktuelle Round-Trip-Zeit des Relays" },
      { label: "RTT", description: "Current relay round-trip time" },
    ),
  },
  {
    name: "belabox.latency", maxLength: 24, sample: "2,000 ms", external: true,
    picker: picker(
      { label: "Latenz", description: "Aktuelle vom Relay gemeldete Latenz" },
      { label: "Latency", description: "Current latency reported by the relay" },
    ),
  },
  {
    name: "belabox.network", maxLength: 24, sample: "2", external: true,
    picker: picker(
      { label: "Netzwerk", description: "Aktueller numerischer Netzwerkstatus des Relays" },
      { label: "Network", description: "Current numeric network value reported by the relay" },
    ),
  },
  {
    name: "belabox.dropped", maxLength: 24, sample: "9", external: true,
    picker: picker(
      { label: "Verlorene Pakete", description: "Summe der verlorenen Pakete im laufenden Stream" },
      { label: "Dropped packets", description: "Sum of dropped packets in the current stream" },
    ),
  },
  {
    name: "belabox.connected", maxLength: 16, sample: "connected", external: true,
    picker: picker(
      { label: "Verbindung", description: "Ob der BELABOX-Publisher verbunden ist" },
      { label: "Connection", description: "Whether the BELABOX publisher is connected" },
    ),
  },
  {
    name: "belabox.status", maxLength: 24, sample: "healthy", external: true,
    picker: picker(
      { label: "Status", description: "Aktueller BELABOX-Zustand" },
      { label: "Status", description: "Current BELABOX health state" },
    ),
  },
  {
    name: "belabox.down_for", maxLength: 40, sample: "1 minute", external: true,
    picker: picker(
      { label: "Ausfalldauer", description: "Dauer der aktuellen schwachen oder getrennten Verbindung" },
      { label: "Down for", description: "Duration of the current low or disconnected episode" },
    ),
  },
] as const;
