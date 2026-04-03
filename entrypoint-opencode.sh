#!/usr/bin/env sh
set -e

CONFIG_DIR="${OPENCODE_CONFIG_DIR:-/root/.config/opencode}"
CONFIG_REPO="${OPENCODE_CONFIG_REPO:-}"

if [ -n "$CONFIG_REPO" ]; then
  echo "[entrypoint] Cloning opencode config from $CONFIG_REPO"

  if [ -n "$GITHUB_TOKEN" ] && echo "$CONFIG_REPO" | grep -q "https://github.com"; then
    AUTH_URL=$(echo "$CONFIG_REPO" | sed "s|https://github.com|https://x-access-token:${GITHUB_TOKEN}@github.com|")
  else
    AUTH_URL="$CONFIG_REPO"
  fi

  TMP_CLONE=$(mktemp -d)
  git clone --depth 1 "$AUTH_URL" "$TMP_CLONE/repo"

  mkdir -p "$CONFIG_DIR"

  cd "$TMP_CLONE/repo"
  for item in * .*; do
    case "$item" in
      .|..|.git) continue ;;
    esac
    cp -a "$item" "$CONFIG_DIR/"
  done
  cd /
  rm -rf "$TMP_CLONE"

  if [ -f "$CONFIG_DIR/package.json" ]; then
    echo "[entrypoint] Installing config dependencies..."
    npm install --prefix "$CONFIG_DIR" --omit=dev
  fi

  echo "[entrypoint] Config synced."
else
  echo "[entrypoint] No OPENCODE_CONFIG_REPO set, using default config."
  mkdir -p "$CONFIG_DIR"
fi

echo "[entrypoint] Starting opencode serve..."
exec opencode serve --hostname 0.0.0.0 --port 62771
