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

`npm run start`, `npx --yes .`, and `opencode-telegram` now start:
- OpenCode server (`opencode-ai serve`) on `0.0.0.0:62771`
- Telegram bot process using `OPENCODE_BASE_URL=http://127.0.0.1:62771` by default

Run the same managed setup explicitly in dev mode:

```bash
opencode-telegram dev
```

Or without global link:

```bash
npx --yes . dev
```

`opencode-telegram dev` uses the same default server host and port.

Optional dev env vars:
- `OPENCODE_DEV_PORT` (default `62771`)
- `OPENCODE_DEV_HOST` (default `0.0.0.0`)

Or link globally for a stable command:

```bash
npm link
opencode-telegram
```

Create and attach a session from your current project directory (no path argument needed):

```bash
opencode-telegram attach http://localhost:62771
```

If URL is omitted, it defaults to `OPENCODE_BASE_URL`/`OPENCODE_URL` or `http://127.0.0.1:62771`.

The CLI loads `.env` from the current folder, parent folder, or repository root.

Required env var:

- `TELEGRAM_TOKEN`

Optional:

- `OPENCODE_TELEGRAM_ENV_FILE` (custom env file path)
- `OPENCODE_BASE_URL` (shared OpenCode server URL, default `http://127.0.0.1:62771` for the managed local server)
- `OPENCODE_URL` (legacy alias for `OPENCODE_BASE_URL`)

## Docker fallback (optional)

From repository root:

```bash
docker compose up --build
```

If you use Docker instead of the managed local startup, start OpenCode separately and point the bot to it using `OPENCODE_BASE_URL`.
This repo's compose stack runs OpenCode on port `62771`.
