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

**If unsure what commands are available, run `opencode-telegram help` first.**

## HTTP API (Cloudflare Tunnel)

### Start the HTTP API server on your Mac

```bash
opencode-telegram serve --port 4097
```

### Tunnel with cloudflared

```bash
cloudflared tunnel --url http://localhost:4097 --hostname cli.petartopic.com
```

### API Base URL

Use `https://cli.petartopic.com` as the base URL for all API calls.

## Complete OpenClaw Agent Workflow

**IMPORTANT:** Follow these exact steps in order. Always URL-encode project paths.

### Step 1: Check if project is running

```bash
curl https://cli.petartopic.com/health
```

### Step 2: Start project if needed

```bash
curl -X POST https://cli.petartopic.com/project/start \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Petar/Employee-tracker"}'
```

### Step 3: Get available agents

```bash
curl "https://cli.petartopic.com/modes/$(python3 -c "import urllib.parse; print(urllib.parse.quote('/Users/petartopic/Desktop/Petar/Employee-tracker'))")"
```

The response:
```json
{
  "modes": [
    {"name": "\u200bAtlas - Plan Executor", "description": "..."},
    {"name": "\u200b\u200bHephaestus - Deep Agent", "description": "..."},
    {"name": "\u200b\u200b\u200bPrometheus - Plan Builder", "description": "..."},
    {"name": "Sisyphus - Ultraworker", "description": "..."}
  ]
}
```

Agents are indexed 0, 1, 2, 3 in this order.

### Step 4: Create a new session

```bash
curl -X POST "https://cli.petartopic.com/sessions/$(python3 -c "import urllib.parse; print(urllib.parse.quote('/Users/petartopic/Desktop/Petar/Employee-tracker'))")/new" \
  -H "Content-Type: application/json" \
  -d '{"title": "task-123"}'
```

Response contains `"id":"ses_xxx"`. Use this `sessionId` for all future calls.

### Step 5: Set agent mode using INDEX (0, 1, 2, or 3)

```bash
curl -X POST "https://cli.petartopic.com/modes/$(python3 -c "import urllib.parse; print(urllib.parse.quote('/Users/petartopic/Desktop/Petar/Employee-tracker'))")/mode" \
  -H "Content-Type: application/json" \
  -d '{"mode": "0", "sessionId": "ses_FROM_STEP_4"}'
```

**The `mode` value must be a STRING containing the index number: `"0"`, `"1"`, `"2"`, or `"3"`.**

Available modes:
- `0` — Atlas - Plan Executor
- `1` — Hephaestus - Deep Agent
- `2` — Prometheus - Plan Builder
- `3` — Sisyphus - Ultraworker

### Step 6: Send a prompt

```bash
curl -X POST https://cli.petartopic.com/send \
  -H "Content-Type: application/json" \
  -d '{
    "project": "/Users/petartopic/Desktop/Petar/Employee-tracker",
    "sessionId": "ses_FROM_STEP_4",
    "prompt": "Your task description here"
  }'
```

### Step 7: Stop execution if needed

```bash
curl -X POST https://cli.petartopic.com/stop \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Petar/Employee-tracker", "sessionId": "ses_FROM_STEP_4"}'
```

## Common Mistakes to Avoid

### WRONG: Passing mode as a number
```json
{"mode": 0}  // WRONG - this is a number
```

### CORRECT: Passing mode as a string
```json
{"mode": "0"}  // CORRECT - this is a string
```

### WRONG: Using full agent name
```json
{"mode": "Atlas - Plan Executor"}  // WRONG - unicode chars cause mismatch
```

### CORRECT: Using index as string
```json
{"mode": "0"}  // CORRECT - server resolves to correct agent
```

## Complete Working Example

```bash
# 1. Check health
curl https://cli.petartopic.com/health

# 2. Create session
SESSION_RESP=$(curl -X POST "https://cli.petartopic.com/sessions/$(python3 -c "import urllib.parse; print(urllib.parse.quote('/Users/petartopic/Desktop/Petar/Employee-tracker'))")/new" \
  -H "Content-Type: application/json" \
  -d '{"title": "my-task"}')
echo $SESSION_RESP
# Extract sessionId from response: {"session":{"id":"ses_xxx",...}}

# 3. Set mode to Atlas (index 0)
curl -X POST "https://cli.petartopic.com/modes/$(python3 -c "import urllib.parse; print(urllib.parse.quote('/Users/petartopic/Desktop/Petar/Employee-tracker'))")/mode" \
  -H "Content-Type: application/json" \
  -d '{"mode": "0", "sessionId": "ses_FROM_ABOVE"}'

# 4. Send prompt
curl -X POST https://cli.petartopic.com/send \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Petar/Employee-tracker", "sessionId": "ses_FROM_ABOVE", "prompt": "Hello"}'
```

## API Endpoints Reference

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Server health + instances |
| GET | `/status` | — | Detailed status |
| POST | `/project/start` | `{"project": "path"}` | Start project instance |
| POST | `/sessions/:project/new` | `{"title": "name"}` | Create session, returns `session.id` |
| GET | `/modes/:project` | — | List agents (indices 0-3) |
| POST | `/modes/:project/mode` | `{"mode": "0", "sessionId": "ses_xxx"}` | Set agent by INDEX |
| POST | `/send` | `{"project", "sessionId", "prompt"}` | Send prompt |
| POST | `/stop` | `{"project", "sessionId"}` | Abort execution |

## CLI Commands (Local)

```bash
opencode-telegram project start <path>
opencode-telegram project stop <path>
opencode-telegram session list <path>
opencode-telegram session new <path>
opencode-telegram mode list --project <path>
opencode-telegram mode <0-3> --project <path>
opencode-telegram send "prompt" --project <path>
opencode-telegram stop --project <path>
opencode-telegram status
opencode-telegram kill-all
```

## State

State is stored in SQLite at `~/.opencode-telegram.db`.
