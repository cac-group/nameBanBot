# Telegram Ban Bot

Automated user filtering bot for Telegram groups that monitors usernames and display names against configurable patterns.

## Features

- **Group-specific pattern management** - Each group maintains separate filter lists
- **Real-time monitoring** - Checks users on join, name changes (30s window), and messages
- **Pattern types** - Text, wildcards (`*`, `?`), and regex patterns
- **Flexible actions** - Ban (permanent) or kick (temporary) per group
- **Hit tracking** - Statistics on pattern matches
- **Admin interface** - DM menu system for pattern management
- **Pattern sharing** - Browse and copy patterns between groups

## Installation

```bash
git clone <repository-url>
cd telegram-ban-bot
yarn install
```

## Configuration

1. **Environment file** - Copy and configure:
   ```bash
   cp example.env .env
   ```

2. **Bot token** - Add your Telegram bot token to `.env`:
   ```bash
   BOT_TOKEN=your_bot_token_here
   ```

3. **Configuration file** - Copy and configure:
   ```bash
   cp config.example.js config.js
   ```

4. **User/Group IDs** - Edit `config.js`:
   ```javascript
   export const WHITELISTED_USER_IDS = [123456789]; // Global admins
   export const WHITELISTED_GROUP_IDS = [-1001234567890]; // Monitored groups
   ```

5. **Create directories**:
   ```bash
   mkdir -p config data/banned_patterns
   ```

## Usage

```bash
yarn start
```

## Commands

### Private Chat (Authorized Users)
- `/start` - Initialize bot and show welcome
- `/menu` - Interactive configuration interface
- `/addFilter <pattern>` - Add pattern to selected group
- `/removeFilter <pattern>` - Remove pattern from selected group
- `/listFilters` - Show all patterns for selected group
- `/setaction <ban|kick>` - Set action for selected group
- `/testpattern <pattern> <text>` - Test pattern matching
- `/hits [pattern]` - Show hit statistics
- `/help` - Command reference

### Any Chat
- `/chatinfo` - Display chat ID and configuration status

## Pattern Formats

| Type | Format | Example | Matches |
|------|--------|---------|---------|
| Text | `pattern` | `spam` | "SPAM", "spammer", "123spam" |
| Wildcard | `*pattern*` | `*bot*` | "testbot", "bot_user", "mybot123" |
| Wildcard | `pattern*` | `evil*` | "evil", "eviluser", "evil123" |
| Wildcard | `test?` | `test?` | "test1", "testa", "tests" |
| Regex | `/pattern/flags` | `/^bad.*$/i` | Lines starting with "bad" (case-insensitive) |

## Authorization Levels

1. **Global Admins** - Users in `WHITELISTED_USER_IDS`
   - Manage all whitelisted groups
   - Full configuration access

2. **Group Admins** - Telegram group administrators
   - Manage only their own groups
   - Group must be in `WHITELISTED_GROUP_IDS`

## File Structure

```
.
├── bot.js              # Main bot logic
├── security.js         # Pattern validation and matching
├── config.js           # User/group configuration and paths
├── config/
│   ├── settings.json   # Runtime settings (auto-generated)
│   └── hit_counters.json   # Statistics (auto-generated)
├── data/
│   └── banned_patterns/    # Pattern storage (auto-generated)
│       └── patterns_<groupId>.toml
└── tests/              # Test suite
```

## Security Features

- Pattern validation with length limits (500 chars)
- Regex timeout protection (100ms)
- Control character filtering
- Dangerous regex detection
- Safe compilation with error handling

## Monitoring Triggers

The bot checks users when they:
1. Join a group (immediate check)
2. Change username/display name (monitored for 30 seconds)
3. Send messages (ongoing check)

## Pattern Management

### Interactive Menu
Access via `/menu` in private chat:
- Select target group
- Add/remove patterns
- Toggle ban/kick actions
- Browse patterns from other groups
- Copy patterns between groups

### Direct Commands
Use specific commands for scripting or quick changes:
```bash
/addFilter *scam*
/setaction kick
/listFilters
```

## Testing

```bash
yarn test
```

## Deployment

### Environment Variables
Optional environment variable overrides:
- `BOT_TOKEN` - Telegram bot token (required)
- `BANNED_PATTERNS_DIR` - Pattern storage directory (default: `./data/banned_patterns`)
- `SETTINGS_FILE` - Settings file path (default: `./config/settings.json`)

### Systemd Service
Example service file:
```ini
[Unit]
Description=Telegram Ban Bot
After=network.target

[Service]
Type=simple
User=telegram
WorkingDirectory=/path/to/bot
ExecStart=/usr/bin/node bot.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

## Troubleshooting

- **Group ID verification** - Use `/chatinfo` to confirm group IDs
- **Supergroup IDs** - Must include `-100` prefix in config
- **Bot permissions** - Requires admin privileges with ban permissions
- **Pattern testing** - Use `/testpattern` to verify regex/wildcard behavior
- **Logs** - Console output shows detailed operation information

## Updates

Use the included update script for production deployments:
```bash
./update.sh
```

Script performs:
- Git pull from main branch
- Dependency updates
- Service restart
- Preserves local configuration