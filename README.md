# OpenCode Telegram

Monorepo for the OpenCode Telegram bot, CLI client, and OpenClaw skill.

## Packages

- [`packages/bot`](packages/bot/) — Telegram bot (node-telegram-bot-api)
- [`packages/cli`](packages/cli/) — CLI entry point (`opencode-telegram` command)
- [`packages/skill`](packages/skill/) — OpenClaw agent skill

## Quick Start

```bash
pnpm install
pnpm start
```

Requires `TELEGRAM_TOKEN` in environment or `.env` at repo root.

## Architecture

Each project on Petar's Mac gets its own OpenCode server instance managed by the bot. Instances run on ports 50000–59999, with state persisted to `~/.opencode-telegram-instances.json`.

## Development

```bash
pnpm dev          # start in managed mode
pnpm attach       # attach terminal to existing instance
pnpm kill-all     # stop all OpenCode server instances
```

## Monorepo Structure

```
opencode-telegram/
├── packages/
│   ├── bot/          # Telegram bot (move from repo root)
│   ├── cli/          # CLI entry point (moved from bin/)
│   └── skill/       # OpenClaw agent skill
├── package.json      # Root workspace
└── pnpm-workspace.yaml
```
