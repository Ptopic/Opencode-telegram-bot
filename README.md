# OpenCode Telegram Bot

## VPS / Docker Compose deployment

This repo now supports a Compose-first deployment model for running the Telegram bot on a VPS.
In this mode, the bot talks to the shared `opencode` service over the Compose network instead of spawning local OpenCode processes.

### 1. Create your env file

```bash
cp .env.example .env
```

Required:
- `TELEGRAM_TOKEN` (override the Compose placeholder before real use)

Typical VPS settings:

### 2. Mount your workspaces

The Compose stack mounts `./workspace` into `/workspace` inside both containers.
The bot lists every direct child directory under `/workspace` as a project, so your VPS workspace can stay simple, for example:

```text
./workspace/
  project-a/
  project-b/
  client-a/
```

### 3. Start the stack

```bash
docker compose up --build -d
```

The stack starts:
- `redis` for session storage
- `opencode` as the shared OpenCode service
- `telegram-bot` as the long-polling Telegram worker

### 4. Operate the bot

Once the containers are healthy, use Telegram commands like:
- `/projects`
- `/new`
- `/session`
- `/close`
- `/git-clone <repo_url>`
- `/git-fetch`
- `/git-pull`
- `/git-commit [message]`
- `/git-push`
- `/git-branch <branch_name>`

In Compose mode, `/close` clears the active project and bot runtime state, but it does not stop the shared `opencode` container.

Git commands operate on the currently selected project inside `./workspace`. `/git-clone` clones into `./workspace`, switches the active project to the new repo, and starts a fresh OpenCode session for it.
Telegram may show these commands with underscores in the command picker, but typed hyphenated forms such as `/git-clone` and `/git-commit` are supported.

For Git operations to work in Docker, make sure the environment inside the container can authenticate to your remote and has Git author identity configured:
- `git config --global user.name "Your Name"`
- `git config --global user.email "you@example.com"`
- provide SSH keys or HTTPS credentials for private repositories

`/git-pull` uses `--ff-only` by default. Without explicit arguments it pulls the current branch's configured upstream; if no upstream exists, the bot tells you to pass `<remote> <branch>` explicitly.

## Local CLI workflow

The local CLI workflow still exists for development.

Install dependencies:

```bash
npm install
```

Run with npx from this folder:

```bash
npx --yes .
```

`npm run start`, `npx --yes .`, and `opencode-telegram` start a managed local setup:
- OpenCode server (`opencode-ai serve`) on `0.0.0.0:62771`
- Telegram bot process using the local managed runtime

Run the same managed setup explicitly in dev mode:

```bash
opencode-telegram dev
```

Or without global link:

```bash
npx --yes . dev
```

Optional local env vars:
- `OPENCODE_DEV_PORT` (default `62771`)
- `OPENCODE_DEV_HOST` (default `0.0.0.0`)
- `OPENCODE_TELEGRAM_ENV_FILE` (custom env file path)
- `OPENCODE_BASE_URL` / `OPENCODE_URL` (use a shared OpenCode server instead of managed local startup)

Create and attach a session from your current project directory:

```bash
opencode-telegram attach http://localhost:62771
```

If the URL is omitted, it defaults to `OPENCODE_BASE_URL` / `OPENCODE_URL` or `http://127.0.0.1:62771`.
