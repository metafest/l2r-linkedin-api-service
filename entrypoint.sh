#!/bin/sh
# Copy secret into writable volume when running on Cloud Run (read-only secret mount).
# Run as root so we can chown; then drop to pwuser for the app (Chromium needs non-root).
if [ -n "$CREDENTIALS_SOURCE" ] && [ -r "$CREDENTIALS_SOURCE" ] && [ -n "$CREDENTIALS_PATH" ]; then
  CREDS_DIR="$(dirname "$CREDENTIALS_PATH")"
  mkdir -p "$CREDS_DIR"
  cp "$CREDENTIALS_SOURCE" "$CREDENTIALS_PATH"
  chown -R pwuser:pwuser "$CREDS_DIR"
  chmod 644 "$CREDENTIALS_PATH"
fi
exec runuser -u pwuser -- "$@"
