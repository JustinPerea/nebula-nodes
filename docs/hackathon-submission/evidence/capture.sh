#!/usr/bin/env bash
# Run AFTER the demo session against Daedalus completes.
# Captures the three text-based evidence files into this directory.
# Screenshots must be added manually (see README.md).

set -euo pipefail

cd "$(dirname "$0")"

echo "==> hermes config show"
hermes config show > evidence-config.txt
echo "    saved evidence-config.txt"

echo "==> hermes insights --days 1"
hermes insights --days 1 > evidence-insights.txt
echo "    saved evidence-insights.txt"

echo "==> sqlite3 sessions excerpt"
sqlite3 ~/.hermes/state.db \
  "SELECT id, source, model, billing_provider, datetime(started_at, 'unixepoch') AS started \
   FROM sessions \
   ORDER BY started_at DESC LIMIT 10" \
  > evidence-sessions.txt
echo "    saved evidence-sessions.txt"

echo
echo "Evidence text files captured. Now add screenshots manually:"
echo "  - evidence-config.png       (hermes config show)"
echo "  - evidence-demo-run.png     (Daedalus mid-response with canvas)"
echo "  - evidence-canvas.png       (final canvas after demo prompt)"
