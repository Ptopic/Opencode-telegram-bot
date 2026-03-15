# OpenCode Telegram Bot

## Local CLI (recommended)

Install dependencies:

```bash
npm install
```

Run with npx from this folder:

```bash
npx --yes .
```

Or link globally for a stable command:

```bash
npm link
opencode-telegram
```

The CLI loads `.env` from the current folder, parent folder, or repository root.

Required env var:

- `TELEGRAM_TOKEN`

Optional:

- `OPENCODE_TELEGRAM_ENV_FILE` (custom env file path)
- `OPENCODE_BASE_URL` (shared OpenCode server URL, default `http://127.0.0.1:4096`)
- `OPENCODE_URL` (legacy alias for `OPENCODE_BASE_URL`)

## Docker fallback

From repository root:

```bash
docker compose up --build
```

The bot does not spawn `opencode serve`. Start OpenCode separately (for example with Docker) and point the bot to it using `OPENCODE_BASE_URL`.
This repo's compose stack runs OpenCode on port `62771`.
