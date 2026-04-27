# OpenCode Per-Project Configuration

This directory contains OpenCode configuration that enforces use of the custom `code-search` tool instead of grep/ripgrep.

## Files

- `opencode.json` - Project-level OpenCode config
- `AGENTS.md` - Agent instructions/rules

## Usage

Place the `.opencode` folder in your project root to apply these settings:

```bash
cp -r .opencode /path/to/your/project/
```

## What This Config Does

1. **Denies grep/ripgrep tools** - Prevents use of direct search tools
2. **Enables code-search MCP** - Uses our custom semantic search tool
3. **Provides instructions** - Tells the agent to use code-search for all code queries

## For the OpenCode Telegram Bot

The bot uses these configs when launching OpenCode instances. Each project can have its own `.opencode` configuration by placing it in the project root.

## Manual Override

If OpenCode doesn't pick up the config automatically, you can:

1. Start OpenCode from the project directory:
   ```bash
   cd /path/to/your/project
   opencode
   ```

2. Or set the config path explicitly:
   ```bash
   OPENCODE_CONFIG=/path/to/your/project/.opencode/opencode.json opencode
   ```
