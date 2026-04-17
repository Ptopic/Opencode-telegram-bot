---
name: opencode-cli
description: Use when Petar wants to control OpenCode on his Mac via the opencode-telegram CLI. Covers starting the bot, switching projects, sending prompts, managing sessions, and stopping executions. Triggers on mentions of OpenCode, coding sessions, projects on his Mac, or CLI commands for OpenCode.
---

# OpenCode CLI Skill

Instructions for using the `@opencode-telegram/cli` package to interact with Petar's OpenCode instances on his Mac.

## Setup

The CLI is part of the `opencode-telegram` monorepo at `~/code/opencode-telegram/`.

```bash
cd ~/code/opencode-telegram
pnpm install
```

## Project Roots

Petar works from two directories on his Mac:
- **Personal projects**: `/Users/petartopic/Desktop/Petar`
- **Work projects**: `/Users/petartopic/Desktop/Profico`

## Commands

### Start the Telegram bot
```bash
pnpm start
# or
opencode-telegram
```
Requires `TELEGRAM_TOKEN` env var or `.env` in repo root.

### List projects
Use `/projects` via Telegram bot — each project spawns its own OpenCode server instance on a separate port (50000–59999).

### Send a prompt to a project
```bash
opencode-telegram send "your prompt here" --project /Users/petartopic/Desktop/Petar/my-project
```

### Stop current execution
```bash
opencode-telegram stop --project /Users/petartopic/Desktop/Petar/my-project
```

### Attach a terminal session to a project
```bash
opencode-telegram attach --project /Users/petartopic/Desktop/Petar/my-project
```

### Kill all OpenCode server instances
```bash
opencode-telegram kill-all
```

## Architecture

- Each project gets its own OpenCode server instance (port 50000–59999)
- The Telegram bot manages lifecycle of all instances
- Sessions are isolated per project
- Instance state is persisted to `~/.opencode-telegram-instances.json`
