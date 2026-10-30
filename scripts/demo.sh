#!/usr/bin/env bash
# Start everything the demo needs, voice the book ahead, and stop both servers on Ctrl-C.
#   scripts/demo.sh           start, voice the book and fillers for every saved voice in the background
#   scripts/demo.sh --wait    also wait until all of it is voiced before printing the links
set -euo pipefail
cd "$(dirname "$0")/.."
LOGS="${TMPDIR:-/tmp}/storyshaper"
mkdir -p "$LOGS"

python3 -m src.server > "$LOGS/story.log" 2>&1 &
STORY=$!
trap 'kill -TERM $STORY 2>/dev/null; wait $STORY 2>/dev/null; echo; echo "Stopped."' EXIT INT TERM

echo "Starting app and voice service (models load on first use; logs in $LOGS)…"
for i in $(seq 1 180); do
  curl -sf -o /dev/null -H "Host: 127.0.0.1:8100" http://127.0.0.1:8100/api/voices &&
    curl -sf -o /dev/null http://127.0.0.1:8000/api/config && break
  kill -0 $STORY 2>/dev/null || { echo "Story server stopped:"; tail -5 "$LOGS/story.log"; exit 1; }
  sleep 1
done

python3 -m narration.warm "$@"
cat <<MSG

Ready.
  Add a parent's voice   http://127.0.0.1:8000/prototype/voice.html
  StoryShaper            http://127.0.0.1:8000/
Press Ctrl-C to stop.
MSG
wait
