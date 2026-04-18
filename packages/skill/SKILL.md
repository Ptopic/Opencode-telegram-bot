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

## HTTP API (Cloudflare Tunnel)

When the HTTP server is running and tunneled via cloudflared, I can call it directly from the cloud.

### Start the HTTP API server on your Mac

```bash
opencode-telegram serve [--port 4097]
```

### Tunnel with cloudflared

```bash
cloudflared tunnel --url http://localhost:4097 --hostname cli.petartopic.com
```

Keep both running (e.g. in a `screen` or `tmux` session).

### API Endpoints

Base URL: `https://cli.petartopic.com`

**Important:** I must use `https://cli.petartopic.com` as the base URL for all API calls. This is the cloudflared tunnel to Petar's Mac. Always prepend this to API paths.

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Server health + running instances |
| GET | `/status` | — | Detailed status of all instances |
| GET | `/projects` | — | Project roots |
| GET | `/sessions/:project` | — | List sessions for a project |
| POST | `/sessions/:project/new` | `{ title? }` | Create new session |
| POST | `/send` | `{ project, prompt, sessionId? }` | Send a prompt |
| GET | `/watch/:project` | — | SSE stream of session messages |
| POST | `/stop` | `{ project, sessionId? }` | Abort current execution |

**Example — send a prompt:**
```bash
curl -X POST https://cli.petartopic.com/send \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Petar/my-project", "prompt": "Hello"}'
```

**Example — watch a session via SSE:**
```
GET https://cli.petartopic.com/watch/<encoded-project-path>?session=<session-id>&interval=2000
```

## Start Modes

```bash
opencode-telegram           # bot + CLI together (default)
opencode-telegram bot       # Telegram bot only
opencode-telegram cli       # Interactive CLI REPL only
opencode-telegram serve     # HTTP API server for cloudflared tunnel
opencode-telegram start bot # Same as 'bot'
opencode-telegram start all # Same as default
```

## Project Roots

- **Personal**: `/Users/petartopic/Desktop/Petar`
- **Work**: `/Users/petartopic/Desktop/Profico`

Each project gets its own OpenCode server instance (ports 50000–59999).

## CLI Commands

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

### Watch session activity
```bash
opencode-telegram watch <project-path>              # poll every 2s
opencode-telegram watch <project-path> --interval=1000
```

This streams new messages as they arrive — useful for real-time monitoring.

### Status & logs
```bash
opencode-telegram status              # Show all running instances
opencode-telegram logs <project-path> # Tail logs for a project
```

### Kill all instances
```bash
opencode-telegram kill-all
```
