#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

PORT="${OCR_PORT:-17871}"
PIDFILE="helper/.ocr_helper_pid"

echo "[1/2] Останавливаю OCR helper по PIDFILE/порту..."

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "- kill PID=$PID"
    kill "$PID" 2>/dev/null || true
    sleep 0.5
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE" || true
fi

PID_PORT="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null || true)"
if [ -n "$PID_PORT" ]; then
  echo "- kill PID=$PID_PORT (порт $PORT)"
  kill "$PID_PORT" 2>/dev/null || true
  sleep 0.5
  kill -9 "$PID_PORT" 2>/dev/null || true
fi

echo "[2/2] Готово."