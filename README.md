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

## Docker fallback

From repository root:

```bash
docker compose up --build
```
