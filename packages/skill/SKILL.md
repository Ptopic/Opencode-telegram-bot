---
name: opencode-cli
description: Use when Petar wants to control OpenCode on his Mac via the opencode-telegram CLI or HTTP API. Covers starting the bot, switching projects, sending prompts, managing sessions, modes, and stopping executions. Triggers on mentions of OpenCode, coding sessions, projects on his Mac, or CLI commands for OpenCode.
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
opencode-telegram serve --port 4097
```

### Tunnel with cloudflared

```bash
cloudflared tunnel --url http://localhost:4097 --hostname cli.petartopic.com
```

Keep both running (e.g. in a `screen` or `tmux` session).

### API Base URL

**Important:** Use `https://cli.petartopic.com` as the base URL for all API calls.

## Complete OpenClaw Agent Workflow

When Petar asks me to work on a project, I should use the HTTP API:

### Step 1: Ensure project is running

```bash
curl https://cli.petartopic.com/health
```

If no instance for the project, start it:

```bash
curl -X POST https://cli.petartopic.com/project/start \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Petar/Employee-tracker"}'
```

### Step 2: Get available agents

```bash
curl "https://cli.petartopic.com/modes/$(python3 -c "import urllib.parse; print(urllib.parse.quote('/Users/petartopic/Desktop/Project/path'))")"
```

The response includes agent names with their index. **Agent names have leading unicode zero-width spaces — use the EXACT name returned, including those characters.**

Example response:
```json
{
  "modes": [
    {"name": "\u200b\u200b\u200b\u200bAtlas - Plan Executor", "description": "..."},
    {"name": "\u200b\u200bHephaestus - Deep Agent", "description": "..."},
    {"name": "\u200b\u200b\u200bPrometheus - Plan Builder", "description": "..."},
    {"name": "\u200bSisyphus - Ultraworker", "description": "..."}
  ]
}
```

### Step 3: Create a new session

```bash
curl -X POST "https://cli.petartopic.com/sessions/$(python3 -c "import urllib.parse; print(urllib.parse.quote('/Users/petartopic/Desktop/Project/path'))")/new" \
  -H "Content-Type: application/json" \
  -d '{"title": "my-task"}'
```

Returns the new `sessionId`. Use this sessionId for all subsequent calls.

### Step 4: Set the agent mode

```bash
curl -X POST "https://cli.petartopic.com/modes/$(python3 -c "import urllib.parse; print(urllib.parse.quote('/Users/petartopic/Desktop/Project/path'))")/mode" \
  -H "Content-Type: application/json" \
  -d '{"mode": "\u200b\u200b\u200b\u200bAtlas - Plan Executor", "sessionId": "ses_xxx"}'
```

**Critical:** Use the EXACT agent name from Step 2 (with unicode chars). The backend expects the raw name.

### Step 5: Send prompts

```bash
curl -X POST https://cli.petartopic.com/send \
  -H "Content-Type: application/json" \
  -d '{
    "project": "/Users/petartopic/Desktop/Project/path",
    "sessionId": "ses_xxx",
    "prompt": "Your task description here"
  }'
```

If `sessionId` is omitted, uses the active session for that project.

### Step 6: Stop execution if needed

```bash
curl -X POST https://cli.petartopic.com/stop \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Project/path", "sessionId": "ses_xxx"}'
```

## API Endpoints Reference

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Server health + running instances |
| GET | `/status` | — | Detailed status of all instances |
| GET | `/projects` | — | Project roots |
| GET | `/sessions/:project` | — | List sessions for a project |
| POST | `/sessions/:project/new` | `{ title? }` | Create new session, returns `session.id` |
| GET | `/modes/:project` | — | List available agents (with unicode chars) |
| POST | `/modes/:project/mode` | `{ mode, sessionId? }` | Set agent mode |
| POST | `/send` | `{ project, prompt, sessionId? }` | Send a prompt |
| GET | `/watch/:project` | — | SSE stream of session messages |
| POST | `/stop` | `{ project, sessionId? }` | Abort current execution |
| POST | `/project/start` | `{ project }` | Start a project instance |
| POST | `/project/stop` | `{ project }` | Stop a project instance |

### URL Encoding

For paths with project paths, URL-encode the path:
```bash
python3 -c "import urllib.parse; print(urllib.parse.quote('/path/to/project'))"
```

Example: `/Users/petartopic/Desktop/Project` → `%2FUsers%2Fpetartopic%2FDesktop%2FProject`

## Available Agents

The 4 main agents (fetched from OpenCode `/agent` endpoint):

| Index | Name | Description |
|-------|------|-------------|
| 0 | Atlas - Plan Executor | Orchestrates work via task() to complete ALL tasks in a todo list |
| 1 | Hephaestus - Deep Agent | Autonomous Deep Worker - goal-oriented execution |
| 2 | Prometheus - Plan Builder | Plan agent |
| 3 | Sisyphus - Ultraworker | Powerful AI orchestrator with strategic delegation |

**Use the EXACT name including unicode chars when setting mode.**

## CLI Commands (Local)

When running commands directly on Petar's Mac:

### Start/stop project instances
```bash
opencode-telegram project start <project-path>
opencode-telegram project stop <project-path>
opencode-telegram project list
```

### Manage sessions
```bash
opencode-telegram session list <project-path>
opencode-telegram session new <project-path>
opencode-telegram session switch <project-path> <session-id>
```

### Agent mode selection
```bash
opencode-telegram mode list --project <project-path>
opencode-telegram mode <index> --project <project-path>
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
opencode-telegram watch <project-path>
```

### Status & logs
```bash
opencode-telegram status
opencode-telegram logs <project-path>
```

### Kill all instances
```bash
opencode-telegram kill-all
```

## State Management

State is stored in SQLite database at `~/.opencode-telegram.db`:
- `instances` table: running OpenCode server processes
- `active_sessions` table: active session + mode per project
- `projects` table: project root configurations

This means state persists across server restarts and is shared between CLI and API.
