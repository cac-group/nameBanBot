# Telegram Ban Bot

## Overview

This bot automatically bans users whose usernames match banned patterns. It monitors:
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

// User IDs allowed to configure the bot
export const WHITELISTED_USER_IDS = [1233456, 789101112];

// Group IDs where the bot operates (supergroup IDs need `-100` prefix)
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

### Ban Actions

- Instantly bans users with matching usernames when they join
- Monitors new users for 30 seconds to catch username changes
- Bans users with matching usernames when they send messages

### User Commands

Available in private chat for authorized users:

- `/start` - Begin configuration and show help
- `/help` - Show usage information
- `/menu` - Display the filter management menu
- `/addFilter <pattern>` - Add a filter pattern
- `/removeFilter <pattern>` - Remove a filter pattern
- `/listFilters` - Show all active filter patterns
- `/chatinfo` - Show chat information (works in groups too)

### Authorization

Users can configure the bot if they:
- Are listed in `WHITELISTED_USER_IDS`
- Are admin in any whitelisted group
- Are admin in the current group (for group commands)

## Troubleshooting

- Use `/chatinfo` to verify group IDs
- For supergroups, IDs must have `-100` prefix in config.js
- Bot requires admin privileges with ban permissions
- Check console logs for detailed operation information
