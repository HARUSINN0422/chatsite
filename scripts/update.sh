#!/usr/bin/env bash
set -euo pipefail
APP_DIR="${APP_DIR:-/home/pi/chatsite}"
BRANCH="${BRANCH:-main}"
cd "$APP_DIR"
git -c safe.directory="$APP_DIR" fetch --quiet origin "$BRANCH"
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
if [ "$LOCAL" = "$REMOTE" ]; then exit 0; fi
echo "Updating ChatSite: $LOCAL -> $REMOTE"
git -c safe.directory="$APP_DIR" merge --ff-only "origin/$BRANCH"
npm install --omit=dev
systemctl restart chatsite.service
echo "ChatSite updated to $(git rev-parse --short HEAD)"
