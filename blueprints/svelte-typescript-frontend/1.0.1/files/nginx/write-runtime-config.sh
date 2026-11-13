#!/bin/sh
# Writes the settings the app reads at startup, from environment variables.
set -eu

api_url="${API_URL:-/api}"
# Only characters that are safe inside JSON and a URL, so the value can't break the file.
case "$api_url" in
  *[!A-Za-z0-9:/._~-]*)
    echo "API_URL contains characters that aren't allowed." >&2
    exit 1
    ;;
esac

mkdir -p /tmp/runtime-config
printf '{"apiUrl":"%s"}\n' "$api_url" > /tmp/runtime-config/config.json
