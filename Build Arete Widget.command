#!/bin/bash
# Build Arete Widget — produces a macOS .dmg in release/.
set -e
cd "$(dirname "$0")"

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
  echo "▸ npm install first (build tools live in devDependencies) ..."
  npm install
fi

echo "▸ Building Arete-Widget .dmg (this takes a few minutes) ..."
npm run dist
echo "✅ Done — opening release/ ..."
open release || true
