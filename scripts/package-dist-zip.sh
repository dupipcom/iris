#!/usr/bin/env bash
#
# Package the compiled bot code (dist/) into dist.zip so the desktop app's
# "Refresh Code" feature can pull it from a GitHub release.
#
# Usage: npm run dist:zip
# Then attach the resulting dist.zip to the GitHub release for this version.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d dist ]; then
  echo "❌ dist/ not found — run 'npm run build' first." >&2
  exit 1
fi
npm run build
rm -f dist.zip
zip -rq dist.zip dist

echo "✅ Created dist.zip ($(du -h dist.zip | cut -f1))."
echo "   Attach it to the GitHub release (dupipcom/iris) so the desktop app"
echo "   can offer the 'Refresh Code' update. The asset name must be exactly"
echo "   'dist.zip'."
