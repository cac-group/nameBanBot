# Telegram Ban Bot

## Overview

This bot automatically bans new users (or users who change their username shortly after joining) if their username matches any of the banned patterns. Banned patterns are stored in a TOML configuration file, and the bot token plus other environment settings are loaded from a **.env** file.

## Installation

1. **Clone the Repository:**

   ```bash
   git clone https://your-repo-url.git
   cd your-repo-directory
   ```

2. **Install Dependencies:**

   If you are using Yarn:
   ```bash
   yarn install
   ```
   Or with npm:
   ```bash
   npm install
   ```

3. **Set up the .env File:**

   Create a **.env** file in the project root with at least:
   ```ini
   BOT_TOKEN=your_bot_token_here
   BANNED_PATTERNS_FILE=banned_patterns.toml
   ```

4. **Create the Banned Patterns File:**

   Create a file named **banned_patterns.toml** in the project root. Example content:
   ```toml
   patterns = [
     "spam",
     "/^bad.*user$/i",
     "*malicious*"
   ]
   ```
5. **Add to `package.json`:**

  Add `"type": "module",` to enable using `.js` file extension.
  Add `"scripts": {"start": "node bot.js"},` to enable the quick `yarn start` command


## Running the Bot

Launch the bot using Node.js (with ESM support):

```bash
node bot.js
```

Or with Yarn:
```bash
yarn start
```

## Features & How It Works

### Automatic Ban Enforcement

- **User Join:** When a user joins a chat, their username is immediately checked. If it matches any banned pattern, the user is banned.
- **Monitoring:** For up to 30 seconds after joining, the bot polls the user every 5 seconds in case their username is changed to something that matches a banned pattern.
- **Message Handling:** Any message sent by a user with a banned username will result in a ban.

### Pattern Matching Rules

Banned patterns support three modes:

1. **Plain String Match:**
   - If a pattern does not include wildcards (`*` or `?`), it performs a case-insensitive substring match.
   - **Example:** `spam` will match any username containing "spam".

2. **Wildcard Matching:**
   - Use `*` to match any sequence of characters.
   - Use `?` to match exactly one character.
   - **Example:** `*bad*` matches any username containing "bad", whereas `b?d` would match "bad" or "bod" but not "baad".

3. **Regular Expression Matching:**
   - To provide a regular expression directly, enclose the pattern in forward slashes `/`.
   - **Example:** `/^bad.*user$/i` will match any username that starts with "bad" and ends with "user" (case-insensitive).

### Admin Commands & Management

Admins (as defined by the `WHITELISTED_USER_IDS` in the code) can manage the banned patterns via direct messages (DM) with the bot. The primary methods include:

- **Inline Menu:**
  - When an admin sends `/filter` in a private chat, they receive a menu with three options:
    - **Add Ban:** Prompts to send a new banned pattern.
    - **Remove Ban:** Prompts to send a pattern to remove.
    - **List Bans:** Displays the current list of banned patterns.

- **Direct Commands:**
  - `/addFilter <pattern>` — Add a pattern.
  - `/removeFilter <pattern>` — Remove a pattern.
  - `/listFilters` — List all banned patterns.

Any changes to the banned patterns are automatically saved back to **banned_patterns.toml** to ensure persistence across bot restarts.

## Customization

- **Whitelist Adjustment:**  
  Modify the `WHITELISTED_USER_IDS` array in `bot.mjs` to add or remove admin user IDs.

- **Pattern Persistence:**  
  If you prefer a different file format or database for pattern storage, update the functions `loadBannedPatterns()` and `saveBannedPatterns()` accordingly.

## Notes

- The current implementation uses in-memory storage with file persistence via TOML. For a production environment, consider a more robust persistent storage solution.
- Ensure proper handling of errors and rate limits as needed.
- The initial admin menu message remains persistent to prevent mobile app issues when the only message is deleted.

---
