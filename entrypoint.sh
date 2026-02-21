#!/bin/sh
# Copy secret into writable volume when running on Cloud Run (read-only secret mount).
if [ -n "$CREDENTIALS_SOURCE" ] && [ -r "$CREDENTIALS_SOURCE" ] && [ -n "$CREDENTIALS_PATH" ]; then
  mkdir -p "$(dirname "$CREDENTIALS_PATH")"
  cp "$CREDENTIALS_SOURCE" "$CREDENTIALS_PATH"
fi
exec "$@"
