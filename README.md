# BroBot

Modularer Twitch-Bot auf Cloudflare Workers mit Hono, React/Vite-Dashboard,
transparentem React-Overlay, Durable Object und D1. Dieses Repository enthält
bewusst nur das Projektgerüst; fachliche Module kommen später als Feature-Slices.

Voraussetzungen: Node.js 24.20.0 oder neuer und pnpm 12.1.0.

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm run dev
pnpm run check
```

Die Architektur steht in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), der
Betrieb in [docs/OPERATIONS.md](docs/OPERATIONS.md), und die Mitarbeitregeln in
[docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). Die Modulgrenzen sind in
[src/modules/README.md](src/modules/README.md) beschrieben.
