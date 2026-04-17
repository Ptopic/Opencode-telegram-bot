# OpenCode Telegram

Control OpenCode on your Mac via Telegram or CLI. Each project gets its own isolated OpenCode server instance.

## Requirements

- Node.js 20+
- [pnpm](https://pnpm.io/installation)
- `opencode` CLI installed on the machine (`brew install opencode-ai/opencode/opencode` or from [opencode.ai](https://opencode.ai))
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

### 1. Clone the repo

```bash
git clone git@github.com:Ptopic/Opencode-telegram-bot.git
cd Opencode-telegram-bot
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment

Create a `.env` file at the repo root:

```bash
cp .env.example .env
```

Edit it and set your Telegram bot token:

```
TELEGRAM_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
```

### 4. Configure project roots (optional)

The CLI needs to know where your projects live. Copy the example config:

```bash
cp .opencode-telegram.example.json ~/.opencode-telegram.json
```

Edit `~/.opencode-telegram.json` to match your setup:

```json
{
  "projectRoots": [
    {
      "scope": "petar",
      "path": "/Users/petartopic/Desktop/Petar",
      "label": "Petar"
    },
    {
      "scope": "profico",
      "path": "/Users/petartopic/Desktop/Profico",
      "label": "Profico"
    }
  ]
}
```

If you skip this step, defaults will be used (Petar and Profico desktop folders).

### 5. Link the CLI (optional, for global access)

```bash
npm link
```

This makes `opencode-telegram` available globally as a command.

## Usage

### Start everything (bot + CLI)

```bash
pnpm start
# or with npm link:
opencode-telegram
```

This starts the Telegram bot. Each project gets its own OpenCode server instance on ports 50000–59999.

### Start bot only

```bash
pnpm start -- --bot
# or after npm link:
opencode-telegram bot
```

### Start CLI REPL only

```bash
pnpm start -- --cli
# or after npm link:
opencode-telegram cli
```

### Get help

```bash
opencode-telegram help
```

## CLI Commands

```bash
# Projects
opencode-telegram projects list         # List all projects and running status

# Sessions
opencode-telegram session list <path>   # List sessions for a project
opencode-telegram session new <path>    # Create a new session
opencode-telegram session switch <path> <id>   # Switch to a session

# Interact
opencode-telegram send "prompt" --project <path>   # Send a prompt, print reply
opencode-telegram stop --project <path>             # Abort current execution

# Agent mode
opencode-telegram mode list --project <path>       # List available modes
opencode-telegram mode agent --project <path>       # Set mode

# Status & logs
opencode-telegram status              # Show all running instances
opencode-telegram logs <path>         # Tail logs for a project

# Lifecycle
opencode-telegram kill-all            # Stop all OpenCode server instances
```

Run `opencode-telegram help` to see all commands.

## Shell Completions

### Bash

```bash
source /path/to/packages/cli/completions/bash
```

Add to `.bashrc` for permanence:
```bash
echo 'source /path/to/Opencode-telegram-bot/packages/cli/completions/bash' >> ~/.bashrc
```

### Zsh

Add to `.zshrc`:
```bash
fpath=(/path/to/Opencode-telegram-bot/packages/cli/completions $fpath) && compinit
```

## Architecture

Each project on your Mac gets its own OpenCode server instance managed by the bot:

- **Port range**: 50000–59999 (one port per project)
- **State file**: `~/.opencode-telegram-instances.json` (instance URLs, PIDs, ports)
- **Config file**: `~/.opencode-telegram.json` (project root directories)
- **No auth**: runs on localhost only

## Packages

| Package | Description |
|---------|-------------|
| `packages/bot` | Telegram bot (node-telegram-bot-api) |
| `packages/cli` | CLI entry point (`opencode-telegram` command) |
| `packages/skill` | OpenClaw agent skill (for AI control via OpenClaw) |

## Monorepo Structure

```
opencode-telegram/
├── packages/
│   ├── bot/
│   │   └── src/index.js       # Telegram bot
│   ├── cli/
│   │   ├── src/
│   │   │   ├── index.js        # CLI entry point
│   │   │   ├── api-client.js   # OpenCode HTTP API client
│   │   │   ├── config.js       # Config file loader
│   │   │   └── commands/       # Subcommands
│   │   └── completions/        # bash + zsh completions
│   └── skill/
│       └── SKILL.md           # OpenClaw agent instructions
├── package.json
└── pnpm-workspace.yaml
```
