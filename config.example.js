// config.example.js - Template configuration file
import dotenv from 'dotenv';
dotenv.config();

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const BANNED_PATTERNS_DIR = './data/banned_patterns';
export const SETTINGS_FILE = './config/settings.json';
export const HIT_COUNTER_FILE = './data/hit_counters.json';

// List of user IDs explicitly allowed to configure the filters
// Add your Telegram user IDs here
export const WHITELISTED_USER_IDS = [
  // 123456789,  // Example user ID
  // 987654321,  // Another user ID
];

// List of group IDs where the bot is allowed to operate
// Group IDs typically need to be prefixed with '-100'
export const WHITELISTED_GROUP_IDS = [
  // -1001234567890,  // Example group ID
];