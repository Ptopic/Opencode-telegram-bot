---
name: opencode-cli
description: Use when Petar wants to control OpenCode on his Mac via the opencode-telegram CLI. Covers starting the bot, switching projects, sending prompts, managing sessions, and stopping executions. Triggers on mentions of OpenCode, coding sessions, projects on his Mac, or CLI commands for OpenCode.
---

# OpenCode CLI Skill

Instructions for using the `@opencode-telegram/cli` to interact with Petar's OpenCode instances on his Mac.

## Setup

The CLI lives at `~/code/opencode-telegram/`.

```bash
cd ~/code/opencode-telegram
pnpm install
```

## Key Rule

**If unsure what commands are available, run `opencode-telegram help` first.** This always reflects the actual CLI surface — use it to recover if this skill is outdated.

## Start Modes

```bash
opencode-telegram           # bot + CLI together (default)
opencode-telegram bot       # Telegram bot only
opencode-telegram cli       # Interactive CLI REPL only
opencode-telegram start bot # Same as 'bot'
opencode-telegram start all # Same as default
```

## Project Roots

- **Personal**: `/Users/petartopic/Desktop/Petar`
- **Work**: `/Users/petartopic/Desktop/Profico`

Each project gets its own OpenCode server instance (ports 50000–59999).

## Commands

Run `opencode-telegram help` for the full list. Key commands:

### List projects
```bash
opencode-telegram projects list
```

### Manage sessions
```bash
opencode-telegram session list <project-path>
opencode-telegram session new <project-path>
opencode-telegram session switch <project-path> <session-id>
```

### Send a prompt
```bash
opencode-telegram send "fix the login bug" --project <project-path>
```

### Stop execution
```bash
opencode-telegram stop --project <project-path>
```

### Agent mode
```bash
opencode-telegram mode list --project <project-path>
opencode-telegram mode agent --project <project-path>
```

### Watch session activity
```bash
opencode-telegram watch <project-path>              # poll every 2s
opencode-telegram watch <project-path> --interval=1000
```

This streams new messages as they arrive — useful for real-time monitoring.

### Kill all instances
```bash
opencode-telegram kill-all
```
