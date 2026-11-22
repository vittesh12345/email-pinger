#!/bin/sh
# Start Pinger (macOS / Linux). Installs its dependencies the first time.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Pinger needs Node.js 22.13 or newer. Download it from https://nodejs.org and run this again."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing Pinger (first run only, about a minute)..."
  npm install --omit=dev --no-audit --no-fund || exit 1
fi

exec node bin/pinger.js "$@"
