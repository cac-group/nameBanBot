// config.js
import dotenv from 'dotenv';
dotenv.config();

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const BANNED_PATTERNS_FILE = process.env.BANNED_PATTERNS_FILE || 'banned_patterns.toml';

// List of user IDs explicitly allowed to configure the filters
export const WHITELISTED_USER_IDS = [1705203106, 1721840238, 5689314455, 951943232, 878263003, 413184612];

// List of group IDs where the bot is allowed to operate.
// Group IDs typically need to be prefixed with '-100'.
export const WHITELISTED_GROUP_IDS = [-1001540576068];
