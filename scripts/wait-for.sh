#!/usr/bin/env sh
# Usage: ./wait-for.sh <URL> <TIMEOUT_SECONDS>
# Polls URL with curl until HTTP 200 or timeout expires.

URL="${1:?URL argument required}"
TIMEOUT="${2:-60}"

elapsed=0
until curl -sf --max-time 3 "$URL" > /dev/null 2>&1; do
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    echo "wait-for: timed out after ${TIMEOUT}s waiting for $URL" >&2
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

echo "wait-for: $URL is up (after ${elapsed}s)"
