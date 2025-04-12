# Telegram Ban Bot

## Overview

This bot automatically bans new users—or users who change their username shortly after joining—if their username matches any banned patterns. Patterns are stored in a TOML configuration file, and the bot token along with other environment settings are loaded from a **.env** file. All configuration parameters (such as whitelisted user IDs and allowed group IDs) are centralized in a separate **config.js** file. In groups, the bot only operates in those that are whitelisted, and it allows configuration of filter rules by group administrators or by users whose IDs are explicitly approved.

## Installation

1. **Clone the Repository:**

   ```bash
   git clone https://your-repo-url.git
   cd your-repo-directory
   ```

2. **Install Dependencies:**

   Using Yarn:
   ```bash
   yarn install
   ```
   Or using npm:
   ```bash
   npm install
   ```

3. **Set up the .env File:**

   Create a **.env** file in the project root with at least:
   ```ini
   BOT_TOKEN=your_bot_token_here
   BANNED_PATTERNS_FILE=banned_patterns.toml
   ```

4. **Create or Update the Configuration File:**

   The **config.js** file centralizes parameters like bot token reference, the banned patterns file path, the whitelisted user IDs, and the allowed group IDs. An example **config.js** might look like this:
   ```js
   // config.js
   export const BOT_TOKEN = process.env.BOT_TOKEN;
   export const BANNED_PATTERNS_FILE = process.env.BANNED_PATTERNS_FILE || 'banned_patterns.toml';
   // User IDs explicitly allowed to configure the filter
   export const WHITELISTED_USER_IDS = [123456789, 987654321];
   // Group IDs where the bot is allowed to operate (supergroup IDs are typically negative numbers)
   export const WHITELISTED_GROUP_IDS = [-1001111111111, -1002222222222];
   ```

5. **Create the Banned Patterns File:**

   Create a file named **banned_patterns.toml** in the project root. Example content:
   ```toml
   patterns = [
     "spam",
     "/^bad.*user$/i",
     "*malicious*"
   ]
   ```

6. **Update package.json:**

   Add `"type": "module",` to allow ES modules with the `.js` extension. Also, add a start script:
   ```json
   {
     "type": "module",
     "scripts": {
       "start": "node bot.mjs"
     }
   }
   ```

## Running the Bot

Launch the bot using Node.js (with ES modules enabled):

```bash
node bot.mjs
```

Or using Yarn:
```bash
yarn start
```

## Use

### Automatic Ban Enforcement

- **User Join:**  
  When a user joins a chat, their username is immediately checked. If it matches any banned pattern, the user is banned.

- **Monitoring:**  
  For up to 30 seconds after joining, the bot polls the user every 5 seconds in case the username changes to something that matches a banned pattern.

- **Message Handling:**  
  Any message sent by a user with a banned username results in an immediate ban.

### Pattern Matching Rules

Banned patterns support three modes:

1. **Plain String Match:**  
   - If a pattern does not include wildcards (`*` or `?`), it performs a case-insensitive substring match.  
   - **Example:** `spam` matches any username containing "spam".

2. **Wildcard Matching:**  
   - Use `*` to match any sequence of characters.  
   - Use `?` to match exactly one character.  
   - **Example:** `*bad*` matches any username containing "bad", while `b?d` matches "bad" or "bod" but not "baad".

3. **Regular Expression Matching:**  
   - Enclose the pattern in forward slashes `/` to provide a custom regular expression.  
   - **Example:** `/^bad.*user$/i` matches any username starting with "bad" and ending with "user" (case-insensitive).

### Admin Commands & Management

Authorized users (either by explicit user ID in **config.js** or by being an admin in a whitelisted group) can manage banned patterns through an interactive workflow:

- **Interactive Menu:**  
  Upon any text message (if no action is pending) in a private chat or allowed group, the bot automatically sends an instructional explainer message (if not already sent) and displays a single interactive menu. From this menu, the admin can:
  - **Add Filter:** Prompts for a new banned pattern.
  - **Remove Filter:** Prompts for a pattern to remove.
  - **List Filters:** Displays the current banned patterns.

  The menu message is updated (or deleted) after an action is completed, ensuring no duplicate messages clutter the chat.

- **Direct Commands (Optional):**  
  The following commands are also supported:
  - `/addFilter <pattern>` — Add a banned pattern.
  - `/removeFilter <pattern>` — Remove a banned pattern.
  - `/listFilters` — List all banned patterns.

All changes to the banned patterns are automatically saved back to **banned_patterns.toml**, ensuring persistence across bot restarts.

## Customization

- **Configuration Adjustments:**  
  Update **config.js** to modify:
  - **User Whitelist:** The list of user IDs explicitly allowed to configure filters.
  - **Group Whitelist:** The list of group IDs where the bot is permitted to operate.
  
- **Pattern Persistence:**  
  If you prefer a different file format or persistent storage mechanism, adjust the `loadBannedPatterns()` and `saveBannedPatterns()` functions accordingly.

---
