# Telegram Ban Bot

## Overview

This bot automatically triggers actions against users whose usernames match banned patterns. It monitors:
1. New users joining a group
2. Username changes after joining
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
     ```
     BOT_TOKEN=your_bot_token_here
     BANNED_PATTERNS_FILE=banned_patterns.toml
     DEFAULT_ACTION=ban  # or 'kick'
     SETTINGS_FILE=settings.json
     ```
   - Edit `config.js` with your user IDs and group IDs
   - Create initial `banned_patterns.toml`

3. **Start:**
   ```bash
   yarn start
   ```

## Configuration Files

### config.js
```js
import dotenv from 'dotenv';
dotenv.config();

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const BANNED_PATTERNS_FILE = process.env.BANNED_PATTERNS_FILE || 'banned_patterns.toml';
export const DEFAULT_ACTION = process.env.DEFAULT_ACTION || 'ban';
export const SETTINGS_FILE = process.env.SETTINGS_FILE || 'settings.json';
export const WHITELISTED_USER_IDS = [123456789, 987654321];
export const WHITELISTED_GROUP_IDS = [-1001111111111];
```

### banned_patterns.toml
```toml
patterns = [
  "spam",
  "/^bad.*user$/i",
  "*malicious*"
]
```

## Features

### Patterns

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

## Troubleshooting

- Use `/chatinfo` to verify group IDs and current settings
- For supergroups, IDs must have `-100` prefix in config.js
- Bot requires admin privileges with ban permissions
- Check console logs for detailed operation information
