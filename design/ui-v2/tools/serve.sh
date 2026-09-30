#!/bin/sh
# Serve the handoff folder so fonts and links load (file:// blocks web fonts).
# Usage: sh design/ui-v2/tools/serve.sh   then open http://localhost:8830/
cd "$(dirname "$0")/.." && exec python3 -m http.server "${PORT:-8830}"
