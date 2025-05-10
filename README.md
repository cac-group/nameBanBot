# Telegram Ban Bot

## Overview

This bot automatically triggers actions against users whose usernames or display names match banned patterns. It monitors:

1. New users joining a group
2. Username/display name changes after joining (monitored for 30 seconds)
3. Messages sent by users

## Installation

1. **Clone and Install:**

   ```bash
   git clone https://github.com/yourusername/telegram-ban-bot.git
   cd telegram-ban-bot
   yarn install
   ```

2. **Configure:**
   - Create `.env` file:

     ```sh
     BOT_TOKEN=your_bot_token_here
     BANNED_PATTERNS_DIR=./banned_patterns
     DEFAULT_ACTION=ban  # or 'kick'
     SETTINGS_FILE=settings.json
     ```

   - Edit `config.js` with your user IDs and group IDs
   - Create the banned_patterns directory: `mkdir -p ./banned_patterns`

3. **Start:**

   ```bash
   yarn start
   ```

## Key Features

### Group-Specific Pattern Management

- Each group now has its own separate set of banned patterns
- Admins can select which group to configure
- Changes only affect the selected group

### Pattern Types

Supports three matching modes:

- **Plain text:** Case-insensitive substring match (e.g., `spam`)
- **Wildcards:** `*` for any sequence, `?` for one character (e.g., `*bad*`)
- **Regex:** Custom regex patterns (e.g., `/^evil.*$/i`)

### Actions

Two configurable actions when a user matches patterns:

- **Ban:** Permanently bans the user from the group
- **Kick:** Removes the user but allows them to rejoin

### User Commands

Available in private chat for authorized users:

- `/start` - Begin configuration and show help
- `/help` - Show usage information
- `/menu` - Display the filter management menu
- `/addFilter <pattern>` - Add a filter pattern
- `/removeFilter <pattern>` - Remove a filter pattern
- `/listFilters` - Show all active filter patterns
- `/setaction <ban|kick>` - Change the action for matched usernames
- `/chatinfo` - Show chat information (works in groups too)

### Authorization

Users can configure the bot if they:

- Are listed in `WHITELISTED_USER_IDS`
- Are admin in any whitelisted group
- Are admin in the current group (for group commands)

## Interactive Admin Menu

The bot provides an interactive menu in private chat that allows admins to:

1. Select which group to configure
2. View, add, and remove patterns for the selected group
3. Toggle between ban/kick actions
4. Check current configuration status

## Troubleshooting

- Use `/chatinfo` to verify group IDs and current settings
- For supergroups, IDs must have `-100` prefix in config.js
- Bot requires admin privileges with ban permissions
- Check console logs for detailed operation information
- Make sure the `banned_patterns` directory exists
