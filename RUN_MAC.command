#!/bin/bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установи Node.js LTS."
  exit 1
fi
if [ ! -d "helper/node_modules" ]; then
  (cd helper && npm install)
fi
node helper/ocr_helper_server.js
