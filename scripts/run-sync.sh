#!/usr/bin/env bash
set -euo pipefail

# dev サーバー起動 + sync-likes 実行のラッパースクリプト
# Usage: ./scripts/run-sync.sh -u <username> [sync-likes options...]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

PORT=3000
HEALTH_URL="http://localhost:${PORT}/api/stats"
MAX_WAIT=60
STARTED_SERVER=false
SERVER_PID=""

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
  echo "[run-sync] dev サーバーを起動します..."
  npx next dev --port "$PORT" > /dev/null 2>&1 &
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
npx tsx scripts/sync-likes.ts "$@"
echo "[run-sync] 完了"
