#!/usr/bin/env bash
set -euo pipefail

# dev サーバー起動 + sync-likes 実行のラッパースクリプト
# Usage: ./scripts/run-sync.sh -u <username> [sync-likes options...]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# .nvmrc の Node バージョンに揃える。
# better-sqlite3 などネイティブモジュールは ABI が Node メジャーに紐づくため、
# install 時と実行時で Node が違うと NODE_MODULE_VERSION 不整合で /api/import が 500 になる (#813)。
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  \. "$HOME/.nvm/nvm.sh" >/dev/null
  if ! nvm use >/dev/null 2>&1; then
    echo "[run-sync] エラー: .nvmrc ($(cat .nvmrc 2>/dev/null)) の Node が未インストールです。'nvm install' を実行してください。" >&2
    exit 1
  fi
fi

PORT=3000
HEALTH_URL="http://localhost:${PORT}/api/stats"
MAX_WAIT=60
STARTED_SERVER=false
SERVER_PID=""
DEV_LOG="/tmp/siftly-next-dev.log"

cleanup() {
  if [ "$STARTED_SERVER" = true ] && [ -n "$SERVER_PID" ]; then
    echo "[run-sync] dev サーバーを停止します (PID: $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ポート3000が使用中か確認
if curl -s -o /dev/null "$HEALTH_URL" 2>/dev/null; then
  echo "[run-sync] dev サーバーは既に起動中です"
else
  echo "[run-sync] dev サーバーを起動します (log: $DEV_LOG)..."
  : > "$DEV_LOG"
  npx next dev --port "$PORT" >> "$DEV_LOG" 2>&1 &
  SERVER_PID=$!
  STARTED_SERVER=true

  # 起動完了をポーリングで待機
  elapsed=0
  while [ $elapsed -lt $MAX_WAIT ]; do
    if curl -s -o /dev/null "$HEALTH_URL" 2>/dev/null; then
      echo "[run-sync] dev サーバーが起動しました (${elapsed}秒)"
      break
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  if [ $elapsed -ge $MAX_WAIT ]; then
    echo "[run-sync] エラー: dev サーバーの起動がタイムアウトしました (${MAX_WAIT}秒)" >&2
    exit 1
  fi
fi

# sync-likes.ts を実行（引数をそのままパススルー）
echo "[run-sync] sync-likes を実行します..."
sync_exit=0
npx tsx scripts/sync-likes.ts "$@" || sync_exit=$?
if [ $sync_exit -ne 0 ] && [ "$STARTED_SERVER" = true ] && [ -f "$DEV_LOG" ]; then
  echo "[run-sync] sync-likes が失敗しました (exit: $sync_exit)。dev サーバーログの末尾 50 行:" >&2
  echo "----- $DEV_LOG -----" >&2
  tail -n 50 "$DEV_LOG" >&2
  echo "--------------------" >&2
fi
[ $sync_exit -eq 0 ] && echo "[run-sync] 完了"
exit $sync_exit
