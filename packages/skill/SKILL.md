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



## Quick OpenCode Workflow

### Commands

**`/opencode_new`** — Create a new session for a project.
Usage: `/opencode_new project-name`
Examples:
- `/opencode_new hegnar-journalist-boost` → creates session on `hegnar-journalist-boost`
- `/opencode_new employee-tracker` → creates session on `Employee-tracker`

Projects are matched by name (case-insensitive, partial match). Default project is `hegnar-journalist-boost`.

**`opencode:`** — Send a task to OpenCode.
Usage: `opencode: [task description]`
- If a session already exists for the current project → sends to that session
- If no session exists → creates a new one first
- Always appends git restriction + Telegram callback automatically
- **ALWAYS spawns a watcher subagent** after sending — monitors SSE stream, notifies via Telegram when done (handles long tasks automatically)
- **Default agent: Sisyphus — Ultraworker (index 3)** for all tasks unless a different agent is explicitly specified in the request

### How It Works (Automatic)
1. You: `opencode: [task]`
2. I: Create/reuse session, send prompt to OpenCode
3. I: Spawn watcher subagent to monitor SSE stream
4. OpenCode: Works on task, fires Telegram callback when done
5. You: Get notified in Telegram with results
6. Long tasks (>5 min): handled automatically by watcher subagent — no manual intervention needed

**`/opencode_status`** — Check current session status.

### Default Settings
- **Project:** `/users/petartopic/desktop/profico/hegnar-journalist-boost`
- **Agent mode:** Sisyphus - Ultraworker (index 3) for all tasks unless a different agent is explicitly specified

### Session Reuse
- `opencode:` reuses the existing session for that project if one is active
- `opencode:` on a different project or no existing session → creates new session
- `/opencode_new` always creates a fresh session regardless of existing ones

### Automatic Prompt Append
Every prompt sent via `opencode:` automatically includes:
```
IMPORTANT: Do NOT run any git commands (git commit, git push, git add, etc.). Only modify local files. We handle version control manually.
```


### Browser Handoff for Anti-Bot Protected Sites

When using `agent-browser` to interact with e-commerce sites, many retailers (instar-informatika.hr, etc.) use Cloudflare/Imperva bot protection that blocks headless Chrome.

**Signs of bot protection blocking automation:**
- `agent-browser eval` returns `null` or empty response
- `browser_navigate` (Hermes native) returns empty page
- Direct product URLs fail with `net::ERR_HTTP_RESPONSE_CODE_FAILURE`
- CDP accessibility snapshot returns 0 buttons (site hydrates interactives after load)
- Snapshot refs point to wrong elements (non-button elements)

**When automation fails → create a browser handoff session so the user can take over manually:**

```bash
# Create a new OpenCode session with handoff enabled
opencode session create --name <session-name> --handoff
```

The handoff URL format: `https://desktop-handoff.petartopic.com/session/{session_id}`

Give this URL to the user and they can complete the task in their own browser while the session stays alive.

**Known anti-bot sites:**
- `instar-informatika.hr` — blocks headless Chrome via Cloudflare/Imperva


### Project Paths (for /opencode_new)
| Project Name | Full Path |
|--------------|-----------|
| hegnar-journalist-boost | `/users/petartopic/desktop/profico/hegnar-journalist-boost` |
| employee-tracker | `/users/petartopic/desktop/petar/employee-tracker` |
| opencode-telegram-bot | `/users/petartopic/desktop/petar/opencode-telegram-bot` |

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

## Critical: Never Commit to Git

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
    {"name": "Atlas - Plan Executor", "description": "..."},
    {"name": "Hephaestus - Deep Agent", "description": "..."},
    {"name": "Prometheus - Plan Builder", "description": "..."},
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
- `1` — Hephaestus - Deep Agent *(recommended — less aggressive summarization)*
- `2` — Prometheus - Plan Builder
- `3` — Sisyphus - Ultraworker

### Step 6: Send a prompt

**Note: Do NOT include Telegram callbacks — they are no longer used.**

```bash
curl -X POST https://cli.petartopic.com/send \
  --max-time 300 \
  -H "Content-Type: application/json" \
  -d '{
    "project": "/Users/petartopic/Desktop/Petar/Employee-tracker",
    "sessionId": "ses_FROM_STEP_4",
    "prompt": "Your task description here\n\nIMPORTANT: Do NOT run any git commands. Only modify local files. We handle version control manually."
  }'
```

### Step 7: Stop execution if needed

```bash
curl -X POST https://cli.petartopic.com/stop \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Petar/Employee-tracker", "sessionId": "ses_FROM_STEP_4"}'
```

## Critical: Never Commit to Git

**OpenCode must NEVER run `git commit`, `git push`, or any git write operations.** All code changes are made locally only. We handle git commits manually after OpenCode completes its work.

Append this instruction to every prompt sent to OpenCode:

```
IMPORTANT: Do NOT run any git commands (git commit, git push, git add, etc.). Only modify local files. We will handle version control manually.
```


## UI Components

When building or modifying UI components, use these appropriate HTML elements:

- **Text input:** `<input type="text" placeholder="Enter value" />`
- **Textarea:** `<textarea placeholder="Enter details"></textarea>`
- **Button:** `<button>Analyze</button>`

Example:
```html
<div>
  <input type="text" placeholder="Search term" />
  <textarea placeholder="Describe your issue"></textarea>
  <button>Analyze</button>
</div>
```



## Known Limitation: Agent Summarization

OpenCode agents (Atlas, Hephaestus, etc.) naturally wrap their outputs in the `reply` field — they summarize what they did rather than dumping raw logs. This means Telegram will receive the agent's summary, not a verbatim transcript of every action.

If full raw output is needed, a custom OpenCode agent with minimal summarization would be required.



## Subagent Monitoring (for raw full output)

For long-running tasks where you want the complete raw output (not agent summary), spawn a subagent to watch the session:

### Spawn a watcher subagent:

**Session Key:** `agent:main:subagent:<uuid>`
**Task template:**

```
Watch an OpenCode session and send the raw output to Telegram when done.

1. Poll the SSE watch endpoint every 5 seconds using the PROJECT SLUG (not full path):
curl -sN "https://cli.petartopic.com/watch/hegnar-journalist-boost?session=<session-id>&interval=5000"

2. Watch for SSE events:
   - data: {"type": "message", ...} — new session message
   - data: {"type": "permission.asked", ...} — **OpenCode needs approval** (show buttons!)
   - data: {"type": "done"} — session is complete, stop polling
   - data: {"type": "error", ...} — error occurred

3. When you receive done, fetch full session messages:
curl "https://cli.petartopic.com/sessions/%2Fusers%2Fpetartopic%2Fdesktop%2Fprofico%2Fhegnar-journalist-boost" -H "Accept: application/json"

4. Extract the `reply` field from EACH message in the messages array — these are the raw agent outputs. Send them ALL to Telegram (split into multiple messages if needed, 4000 char limit each):

curl -X POST "https://api.telegram.org/bot8356106264:AAFlIyS9Va9XTw-BqiHU0qxYP5G-2en14x8/sendMessage" -d "chat_id=1687461542&text=[paste the reply text here]"

Send every reply field value, do not skip any. If a reply is empty, skip it. Do not summarize, do not format as JSON — send raw text.
```

**Important:** The SSE watch endpoint uses project slug/name, NOT URL-encoded path. The sessions API uses full URL-encoded path.

### Key rule:
- Send EACH `reply` field from the messages array as a separate Telegram message
- Do NOT send the full JSON — extract and paste only the `reply` values
- Skip empty replies


## Long-Running Tasks (Tasks > 5 minutes)

When a task might take a long time (implementation, refactoring, large analysis):

### Workflow

1. **Send the prompt** — use a long `--max-time` (10 min) on the curl, or don't wait for response

2. **Spawn a watcher subagent** — immediately after sending, spawn a subagent to monitor the SSE stream:
```
Sessions: spawn
Task: Watch OpenCode session <session-id> on project <project-name> via SSE watch. Poll every 30s. When session becomes idle (no events for 30s), send final status to Telegram.
Runtime: subagent
Mode: run
```

3. **Wait for Telegram callback** — OpenCode fires the callback when done

### Don't Do This
- Don't repeatedly poll `/send` waiting for a response
- Don't assume timeout = failure — task may still be running

### Example: Sending a big implementation task
1. Create session (or reuse existing)
2. Set mode
3. Send prompt with `--max-time 600` (10 min)
4. Immediately spawn SSE watcher subagent
5. Done — callback fires when OpenCode finishes



## Permission / Approval Flow

When OpenCode needs user approval for a tool execution (bash, file write, etc.), the watch SSE stream emits a `permission.asked` event.

### Permission Event Format

```json
{
  "type": "permission.asked",
  "id": "perm_xxx",
  "sessionID": "ses_xxx",
  "permission": "bash",
  "patterns": ["*.ts"],
  "tool": "bash",
  "metadata": {}
}
```

### Responding to Permission Requests

POST to `/permission/respond` with one of three actions:

```bash
# Approve once:
curl -X POST https://cli.petartopic.com/permission/respond \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Petar/Employee-tracker", "requestID": "perm_xxx", "reply": "once"}'

# Always allow this permission:
curl -X POST https://cli.petartopic.com/permission/respond \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Petar/Employee-tracker", "requestID": "perm_xxx", "reply": "always"}'

# Reject:
curl -X POST https://cli.petartopic.com/permission/respond \
  -H "Content-Type: application/json" \
  -d '{"project": "/Users/petartopic/Desktop/Petar/Employee-tracker", "requestID": "perm_xxx", "reply": "reject"}'
```

**Reply values:**
| Value | Effect |
|-------|--------|
| `"once"` | Approve this one request only |
| `"always"` | Approve this and all future requests of the same permission type |
| `"reject"` | Deny the request |

### Watcher Subagent Pattern

When a watcher subagent receives a `permission.asked` event, it should:
1. Notify the user via Telegram with the tool name and permission type
2. Present three options: Approve (once), Always Allow, Reject
3. On user selection, POST to `/permission/respond`
4. Continue watching the SSE stream

---

## Permanent Agent Monitor

A watchdog cron job runs every minute monitoring all OpenCode sessions. It:
- Tracks active sessions in `active-sessions.json`
- Alerts via Telegram if a session appears stuck (>5 min without new messages)
- Auto-cleans old sessions (60+ min inactive)
- Sends Telegram alert on stuck tasks

State file: `~/.openclaw/active-sessions.json`

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

## Long-Running Tasks

The `/send` endpoint has a timeout (default ~2 min). For tasks that take longer:

### Workflow

1. **Send the prompt** — may timeout on long tasks, but the task keeps running on OpenCode
2. **Monitor with `watch`** — SSE stream of session messages in real-time
3. **Poll session status** — check when session becomes idle
4. **Fetch final messages** — get the complete result

### Step 1: Send prompt

```bash
curl -X POST https://cli.petartopic.com/send \
  --max-time 300 \
  -H "Content-Type: application/json" \
  -d '{
    "project": "/Users/petartopic/Desktop/Petar/Employee-tracker",
    "sessionId": "ses_xxx",
    "prompt": "Complex task...\n\nIMPORTANT: Do NOT run any git commands. Only modify local files. We handle version control manually."
  }'
```

If it times out, the task is still running on OpenCode. Move to Step 2.

### Step 2: Monitor with SSE Watch

```bash
# Use project SLUG (not full path) for SSE watch:
curl -sN "https://cli.petartopic.com/watch/hegnar-journalist-boost?session=ses_xxx&interval=5000"
```

The SSE stream outputs `data: {...}` lines. Parse with `grep`:
- `grep '"type":"message"'` — session messages
- `grep '"type":"permission.asked"'` — **approval needed** (respond via `/permission/respond`)
- `grep '"type":"done"'` — session complete
- `grep '"type":"text"'` — text parts within messages
- `grep '"reasoning"'` — agent reasoning traces

When you see `data: {"type":"done"}`, the session is finished.

### Step 3: Poll until idle

```bash
# Sessions API uses full URL-encoded path:
curl "https://cli.petartopic.com/sessions/%2Fusers%2Fpetartopic%2Fdesktop%2Fprofico%2Fhegnar-journalist-boost" \
  -H "Accept: application/json"
```

Or check the `watch` output — when you stop seeing new events, the task is likely done.

### Step 4: Fetch final messages

```bash
curl "https://cli.petartopic.com/sessions/%2Fusers%2Fpetartopic%2Fdesktop%2Fprofico%2Fhegnar-journalist-boost" \
  -H "Accept: application/json"
```

Look for `summary` in the session object — it shows files changed, additions, deletions.

---

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
  --max-time 300 \
  -H "Content-Type: application/json" \
  -d '{
    "project": "/Users/petartopic/Desktop/Petar/Employee-tracker",
    "sessionId": "ses_FROM_ABOVE",
    "prompt": "Hello\n\nIMPORTANT: Do NOT run any git commands. Only modify local files. We handle version control manually."
  }'
```

---

### API Endpoints Reference
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
| GET | `/watch/:project?session=ses_xxx&interval=5000` | — | SSE stream for session messages |
| POST | `/permission/respond` | `{"project", "requestID", "reply"}` | Respond to permission request (`"once"`, `"always"`, or `"reject"`) |

**SSE Watch URL format:** Use the project slug/name directly — NOT the full URL-encoded path.
- ✅ `https://cli.petartopic.com/watch/hegnar-journalist-boost?session=ses_xxx&interval=5000`
- ❌ `https://cli.petartopic.com/watch/%2Fusers%2Fpetartopic%2Fdesktop%2Fprofico%2Fhegnar-journalist-boost?session=ses_xxx`

All other API calls (send, sessions, modes) require the full URL-encoded path like `/users/petartopic/desktop/profico/hegnar-journalist-boost`.

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
