#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# На всякий: снять карантин с папки (если скачано из браузера)
xattr -dr com.apple.quarantine "$DIR" 2>/dev/null || true
chmod +x "$DIR"/*.command 2>/dev/null || true

PORT=17871
PIDFILE="$DIR/helper/.ocr_server.pid"
LOGFILE="$DIR/helper/ocr_server.log"

cleanup() {
  if [ -f "$PIDFILE" ]; then
    PID="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$PID" ]; then
      kill "$PID" 2>/dev/null || true
      sleep 0.2
      kill -9 "$PID" 2>/dev/null || true
    fi
    rm -f "$PIDFILE" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Если порт уже занят — освободим (обычно это "зависший" OCR helper)
if command -v lsof >/dev/null 2>&1; then
  OLD_PID="$(lsof -ti tcp:$PORT 2>/dev/null | head -n 1 || true)"
  if [ -n "$OLD_PID" ]; then
    echo "Порт $PORT занят (PID=$OLD_PID). Останавливаю процесс..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 0.5
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
fi

echo "[1/2] Устанавливаю зависимости OCR helper (npm install)..."
cd "$DIR/helper"
npm install
rm -rf "$DIR/helper/node_modules/pdfjs-dist/node_modules/canvas" 2>/dev/null || true

echo "[2/2] Запускаю OCR сервер..."
node ocr_helper_server.js >"$LOGFILE" 2>&1 &
PID=$!
echo "$PID" >"$PIDFILE"

cd "$DIR"
echo "Открываю программу в браузере..."
open "$DIR/vadim-filter-tool.html" >/dev/null 2>&1 || true

echo ""
echo "OCR сервер запущен (PID=$PID) на http://127.0.0.1:$PORT"
echo "Лог: $LOGFILE"
echo ""
echo "Чтобы остановить — нажми Ctrl+C или просто закрой это окно."

# держим окно открытым, чтобы trap корректно отработал
while true; do sleep 1; done
