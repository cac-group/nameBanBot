#!/bin/bash

# Log file for update operations
LOG_FILE="/var/log/banbot-updater.log"
REPO_DIR="/root/repos/nameBanBot"
SERVICE_NAME="namebanbot.service"

# Function to log messages
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Navigate to the repository directory
cd "$REPO_DIR" || {
  log "Failed to change directory to $REPO_DIR. Exiting."
  exit 1
}

log "Starting update check for banBaby bot"

# Save the current HEAD commit hash
OLD_HEAD=$(git rev-parse HEAD)

# Pull the latest changes from the main branch
log "Pulling latest changes from GitHub..."
git fetch origin main
git reset --hard origin/main

# Get the new HEAD commit hash
NEW_HEAD=$(git rev-parse HEAD)

# Check if there were any new commits
if [ "$OLD_HEAD" = "$NEW_HEAD" ]; then
  log "No new changes detected. Exiting."
  exit 0
fi

log "Changes detected. New commits: $(git log --oneline $OLD_HEAD..$NEW_HEAD)"

# Skip git tracking for config.js (but keep the file)
git update-index --skip-worktree config.js
log "Set config.js to skip-worktree to preserve local changes"

# Install or update dependencies
log "Installing dependencies..."
yarn install

# Restart the service
log "Restarting the bot service..."
systemctl restart "$SERVICE_NAME"

log "Update completed successfully"
