#!/bin/bash
# Start Arete Widget — double-click to run the app from this folder.
set -e
cd "$(dirname "$0")"

# GUI-launched shells have a minimal PATH; add the usual node locations + nvm.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node was not found on PATH. Install Node.js (or nvm) first."
  read -r -p "Press Enter to close." _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "▸ First run: npm install (also applies the SDK System-ID patch) ..."
  npm install
fi

echo "▸ Starting Arete Widget ..."
npm start
