# BroBot

Dieses Projekt ist ein modularer Twitch-Bot auf Cloudflare Workers mit Dashboard und Overlay.

Projektdokumentation: `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `docs/CONTRIBUTING.md`, `docs/AI-WORKFLOW.md`.
Modulkonventionen: `src/modules/README.md`.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Projektregeln

- Sprache ist Deutsch; echte Umlaute verwenden.
- Single-Package, kein Monorepo.
- Module werden ausschließlich über Contract und Registry bekannt gemacht.
- `channelId` ist überall Mandantenschlüssel; es gibt kein `BROADCASTER_ID`-Secret.
- Overlay-Imports sind durch ESLint begrenzt und bleiben lazy.
- Vor jedem Push: `pnpm run check`.
- Keine Secrets im Repository.
- Keine Attribution-Trailer und keine `claude.ai/code`- oder `session_`-URLs in Commits, PRs oder Dateien.
- Commit-Format samt Icon-Legende: `docs/CONTRIBUTING.md`.
- Implementierung wird nach `docs/AI-WORKFLOW.md` delegiert.
- Issue-Handling (Labels, Claiming, Verknüpfung mit Code): `docs/CONTRIBUTING.md`.
- Das Repo ist öffentlich; `docs/input/` bleibt bewusst unversioniert für interne Notizen.
