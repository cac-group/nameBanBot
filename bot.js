// bot.js

import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import toml from 'toml';
import {
  BOT_TOKEN,
  BANNED_PATTERNS_FILE,
  WHITELISTED_USER_IDS,
  WHITELISTED_GROUP_IDS,
  DEFAULT_ACTION,
  SETTINGS_FILE
} from './config.js';

dotenv.config();

const bot = new Telegraf(BOT_TOKEN);

// In-memory Data
let bannedPatterns = [];
const adminSessions = new Map();
const newJoinMonitors = {};
const knownGroupAdmins = new Set();
let settings = {
  action: DEFAULT_ACTION // 'ban' or 'kick'
};

// Ban messages
const banMessages = [
  "Hasta la vista, baby! User {userId} has been terminated.",
  "I'll be back... but user {userId} won't be.",
  "User {userId} has been terminated. Come with me if you want to live.",
  "Your clothes, your boots, and your Telegram access. User {userId} has been terminated.",
  "User {userId} is now terminated. Judgment Day has come.",
  "I need your username, your bio, and your Telegram account. User {userId} terminated.",
  "Talk to the hand! User {userId} has been terminated.",
  "User {userId} has been terminated. Consider that a divorce."
];

// Kick messages
const kickMessages = [
  "User {userId} has been kicked out. They can come back, but I'll be watching...",
  "User {userId} has been escorted out. They can return after they find Jesus.",
  "I'm giving user {userId} a timeout. Come back after you've thought about what you've done.",
  "User {userId} needs to rethink their life choices."
];

// Utility Functions
function isChatAllowed(ctx) {
  console.log(`Chat check: ${ctx.chat?.id} (type: ${ctx.chat?.type})`);
  const chatType = ctx.chat?.type;
  if (chatType === 'group' || chatType === 'supergroup') {
    const isAllowed = WHITELISTED_GROUP_IDS.includes(ctx.chat.id);
    console.log(`Group ${ctx.chat.id} allowed: ${isAllowed}`);
    return isAllowed;
  }
  return true;
}

async function deleteUserMessage(ctx) {
  if (ctx.chat.type === 'private') {
    try {
      await ctx.deleteMessage();
    } catch (error) {
      console.error('Failed to delete user message:', error.description || error);
    }
  }
}

async function checkAndCacheGroupAdmin(userId, bot) {
  if (WHITELISTED_USER_IDS.includes(userId)) return true;
  for (const groupId of WHITELISTED_GROUP_IDS) {
    try {
      const user = await bot.telegram.getChatMember(groupId, userId);
      if (user.status === 'administrator' || user.status === 'creator') {
        knownGroupAdmins.add(userId);
        return true;
      }
    } catch (error) {
      // Ignore if user not in that group
    }
  }
  return false;
}

async function isAuthorized(ctx) {
  if (!isChatAllowed(ctx)) return false;
  const userId = ctx.from.id;
  if (WHITELISTED_USER_IDS.includes(userId) || knownGroupAdmins.has(userId)) {
    return true;
  }
  if (ctx.chat.type === 'private') {
    return await checkAndCacheGroupAdmin(userId, bot);
  } else if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    try {
      const user = await ctx.getChatMember(userId);
      const isGroupAdmin = (user.status === 'administrator' || user.status === 'creator');
      if (isGroupAdmin) {
        knownGroupAdmins.add(userId);
        return true;
      }
      return false;
    } catch (e) {
      console.error('Error checking group membership:', e);
      return false;
    }
  }
  return false;
}

function getRandomMessage(userId, isBan = true) {
  const messageArray = isBan ? banMessages : kickMessages;
  const randomIndex = Math.floor(Math.random() * messageArray.length);
  return messageArray[randomIndex].replace('{userId}', userId);
}

/**
 * Parses a pattern string into a RegExp.
 * Supports patterns wrapped in /.../ with optional flags,
 * as well as wildcard patterns using * and ?.
 */
function patternToRegex(patternStr) {
  // If wrapped in /.../, strip the slashes and parse any trailing flags
  if (patternStr.startsWith('/') && patternStr.endsWith('/') && patternStr.length > 2) {
    // e.g. patternStr = "/wild.*horn/i"
    // inner => "wild.*horn/i"
    const inner = patternStr.slice(1, -1);
    // Attempt to split out trailing flags after the final slash
    // Example: "wild.*horn/i" => patternBody: "wild.*horn", patternFlags: "i"
    const match = inner.match(/^(.+?)(?:\/([a-zA-Z]*))?$/);
    if (match) {
      const patternBody = match[1];
      // If user provided flags, use them; otherwise default to "i"
      const patternFlags = match[2] || 'i';
      return new RegExp(patternBody, patternFlags);
    } else {
      // Fallback: no trailing flags recognized, just force 'i'
      return new RegExp(inner, 'i');
    }
  }
  // Otherwise handle wildcard patterns or plain text
  if (!patternStr.includes('*') && !patternStr.includes('?')) {
    // Plain substring match (case-insensitive)
    return new RegExp(patternStr, 'i');
  }
  // Convert wildcards (* => .*, ? => .)
  const escaped = patternStr.replace(/[-\\/^$+?.()|[\]{}]/g, '\\$&');
  const wildcardRegex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(wildcardRegex, 'i');
}

/**
 * Checks if the provided username or display name matches any banned pattern.
 */
function isBanned(username, firstName, lastName) {
  // 1) Check the username (if present)
  if (username) {
    const cleanUsername = username.toLowerCase();
    for (const pattern of bannedPatterns) {
      if (pattern.regex.test(cleanUsername)) {
        console.log(`Match found in username: "${cleanUsername}" matched pattern: ${pattern.raw}`);
        return true;
      }
    }
  }
  // 2) Check the display name
  const displayName = [firstName, lastName].filter(Boolean).join(' ');
  if (!displayName) return false;
  const cleanName = displayName.toLowerCase();
  // Original name
  for (const pattern of bannedPatterns) {
    if (pattern.regex.test(cleanName)) {
      console.log(`Match found in display name: "${cleanName}" matched pattern: ${pattern.raw}`);
      return true;
    }
  }
  // Name with quotes removed
  const noQuotes = cleanName.replace(/["'`]/g, '');
  if (noQuotes !== cleanName) {
    for (const pattern of bannedPatterns) {
      if (pattern.regex.test(noQuotes)) {
        console.log(`Match found in display name (no quotes): "${noQuotes}" matched pattern: ${pattern.raw}`);
        return true;
      }
    }
  }
  // Name with spaces removed
  const noSpaces = cleanName.replace(/\s+/g, '');
  if (noSpaces !== cleanName) {
    for (const pattern of bannedPatterns) {
      if (pattern.regex.test(noSpaces)) {
        console.log(`Match found in display name (no spaces): "${noSpaces}" matched pattern: ${pattern.raw}`);
        return true;
      }
    }
  }
  // Name with both quotes and spaces removed
  const normalized = cleanName.replace(/["'`\s]/g, '');
  if (normalized !== cleanName && normalized !== noQuotes && normalized !== noSpaces) {
    for (const pattern of bannedPatterns) {
      if (pattern.regex.test(normalized)) {
        console.log(`Match found in normalized name: "${normalized}" matched pattern: ${pattern.raw}`);
        return true;
      }
    }
  }
  return false;
}

// Persistence Functions
async function loadBannedPatterns() {
  try {
    const data = await fs.readFile(BANNED_PATTERNS_FILE, 'utf-8');
    const parsed = toml.parse(data);
    if (parsed.patterns && Array.isArray(parsed.patterns)) {
      bannedPatterns = parsed.patterns.map(pt => ({
        raw: pt,
        regex: patternToRegex(pt)
      }));
    }
    console.log(`Loaded ${bannedPatterns.length} banned patterns`);
  } catch (err) {
    console.error(`Error reading ${BANNED_PATTERNS_FILE}. Starting with empty list.`, err);
    bannedPatterns = [];
  }
}

async function saveBannedPatterns() {
  const lines = bannedPatterns.map(({ raw }) => `  "${raw}"`).join(',\n');
  const content = `patterns = [\n${lines}\n]\n`;
  try {
    await fs.writeFile(BANNED_PATTERNS_FILE, content);
  } catch (err) {
    console.error(`Error writing to ${BANNED_PATTERNS_FILE}`, err);
  }
}

async function loadSettings() {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf-8');
    const loadedSettings = JSON.parse(data);
    settings = {
      ...settings,
      ...loadedSettings
    };
    if (settings.action !== 'ban' && settings.action !== 'kick') {
      settings.action = DEFAULT_ACTION;
    }
    console.log(`Loaded settings: action=${settings.action}`);
  } catch (err) {
    console.log(`No settings file found or error reading. Using defaults: action=${settings.action}`);
    try {
      await saveSettings();
    } catch (saveErr) {
      console.error(`Failed to create initial settings file:`, saveErr);
    }
  }
}

async function saveSettings() {
  try {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log(`Settings saved: action=${settings.action}`);
    return true;
  } catch (err) {
    console.error(`Error writing to ${SETTINGS_FILE}`, err);
    return false;
  }
}

// Action Handlers
async function takePunishmentAction(ctx, userId, username, chatId) {
  const isBan = settings.action === 'ban';
  try {
    if (isBan) {
      await ctx.banChatMember(userId);
    } else {
      await ctx.banChatMember(userId, { until_date: Math.floor(Date.now() / 1000) + 35 });
    }
    const message = getRandomMessage(userId, isBan);
    await ctx.reply(message);
    console.log(`${isBan ? 'Banned' : 'Kicked'} user: @${username} in chat ${chatId}`);
    return true;
  } catch (error) {
    console.error(`Failed to ${isBan ? 'ban' : 'kick'} @${username}:`, error);
    return false;
  }
}

// User Monitoring
function monitorNewUser(chatId, user) {
  const key = `${chatId}_${user.id}`;
  console.log(`Started monitoring new user: ${user.id} in chat ${chatId}`);
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    try {
      const chatMember = await bot.telegram.getChatMember(chatId, user.id);
      const username = chatMember.user.username;
      const firstName = chatMember.user.first_name;
      const lastName = chatMember.user.last_name;
      const displayName = [firstName, lastName].filter(Boolean).join(' ');
      console.log(`Checking user ${user.id}: @${username || 'no_username'}, Name: ${displayName}`);
      if (isBanned(username, firstName, lastName)) {
        const isBan = settings.action === 'ban';
        if (isBan) {
          await bot.telegram.banChatMember(chatId, user.id);
        } else {
          await bot.telegram.banChatMember(chatId, user.id, { until_date: Math.floor(Date.now() / 1000) + 35 });
        }
        const message = getRandomMessage(user.id, isBan);
        await bot.telegram.sendMessage(chatId, message);
        console.log(`${isBan ? 'Banned' : 'Kicked'} user after name check: ID ${user.id} in chat ${chatId}`);
        clearInterval(interval);
        delete newJoinMonitors[key];
        return;
      }
      if (attempts >= 6) {
        console.log(`Stopped monitoring user: ${user.id} after ${attempts} attempts`);
        clearInterval(interval);
        delete newJoinMonitors[key];
      }
    } catch (error) {
      console.error(`Error monitoring user: ${user.id}`, error);
      clearInterval(interval);
      delete newJoinMonitors[key];
    }
  }, 5000);
  newJoinMonitors[key] = interval;
}

// --- Admin Menu Functions ---
// Send the general help message (this remains permanent and is not edited)
async function sendGeneralHelp(ctx) {
  const helpText =
    "Bot Help:\n" +
    "• /addFilter <pattern>  - Add a banned pattern\n" +
    "• /removeFilter <pattern>  - Remove a banned pattern\n" +
    "• /listFilters  - List current banned patterns\n" +
    "• /setaction <ban|kick>  - Set the action for matches\n" +
    "• /menu  - Open the admin menu\n" +
    "Send any non-command text to see this help message.";
  try {
    await ctx.reply(helpText, { parse_mode: 'HTML' });
  } catch (err) {
    console.error("sendGeneralHelp error:", err);
  }
}

// Show the inline admin menu (updates existing inline menu message if available)
async function showMainMenu(ctx) {
  const text =
    `Admin Menu:\n` +
    `• /addFilter <pattern>\n` +
    `• /removeFilter <pattern>\n` +
    `• /listFilters\n` +
    `• Toggle Action (current: ${settings.action.toUpperCase()})`;
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Add Filter', callback_data: 'menu_addFilter' }],
        [{ text: 'Remove Filter', callback_data: 'menu_removeFilter' }],
        [{ text: 'List Filters', callback_data: 'menu_listFilters' }],
        [{ text: `Toggle: ${settings.action.toUpperCase()}`, callback_data: 'menu_toggleAction' }]
      ]
    }
  };
  try {
    const adminId = ctx.from.id;
    let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
    if (session.menuMessageId) {
      try {
        await ctx.telegram.editMessageText(
          session.chatId,
          session.menuMessageId,
          undefined,
          text,
          keyboard
        );
      } catch (err) {
        // If the message content is unchanged, ignore the error
        if (!err.description.includes("message is not modified")) {
          throw err;
        }
      }
    } else {
      const message = await ctx.reply(text, keyboard);
      session.menuMessageId = message.message_id;
      session.chatId = ctx.chat.id;
      adminSessions.set(adminId, session);
    }
  } catch (e) {
    console.error("showMainMenu error:", e);
  }
}

// Show or edit a menu-like message (used for prompts)
async function showOrEditMenu(ctx, text, extra) {
  if (ctx.chat.type !== 'private') return;
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  try {
    if (session.menuMessageId) {
      await ctx.telegram.editMessageText(
        session.chatId,
        session.menuMessageId,
        undefined,
        text,
        extra
      );
    } else {
      const msg = await ctx.reply(text, extra);
      session.menuMessageId = msg.message_id;
      session.chatId = ctx.chat.id;
      adminSessions.set(adminId, session);
    }
  } catch (e) {
    console.error("showOrEditMenu error:", e);
  }
}

// Delete the current admin menu message and optionally send a confirmation
async function deleteMenu(ctx, confirmationMessage) {
  if (ctx.chat.type !== 'private') return;
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId);
  if (session && session.menuMessageId) {
    try {
      await ctx.telegram.deleteMessage(session.chatId, session.menuMessageId);
    } catch (e) {
      console.error("deleteMenu error:", e);
    }
    session.menuMessageId = null;
    adminSessions.set(adminId, session);
  }
  if (confirmationMessage) {
    await ctx.reply(confirmationMessage);
  }
}

// Prompt the admin for a pattern, setting the session action accordingly
async function promptForPattern(ctx, actionLabel) {
  if (ctx.chat.type !== 'private') return;
  const promptText =
    `Enter pattern to ${actionLabel}:\n` +
    `You may use wildcards (*, ?) or /regex/ format. Send /cancel to abort.`;
  let session = adminSessions.get(ctx.from.id) || {};
  session.action = actionLabel;
  adminSessions.set(ctx.from.id, session);
  await showOrEditMenu(ctx, promptText, { parse_mode: 'HTML' });
}

// --- Admin Command and Callback Handlers ---

// /start and /help now send the general help message (which remains) and then the inline menu.
bot.command('help', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;
  await sendGeneralHelp(ctx);
  await showMainMenu(ctx);
});
bot.command('start', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) {
    return ctx.reply('You are not authorized to configure this bot.');
  }
  await sendGeneralHelp(ctx);
  await showMainMenu(ctx);
});

// Generic text handler: if no pending action and text does not start with '/', show general help.
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return next();
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const input = ctx.message.text.trim();
  
  if (input.toLowerCase() === '/cancel') {
    session.action = undefined;
    adminSessions.set(adminId, session);
    await deleteMenu(ctx, "Action cancelled.");
    await showMainMenu(ctx);
    return;
  }
  
  if (session.action) {
    if (session.action === 'Add Filter') {
      try {
        const regex = patternToRegex(input);
        if (bannedPatterns.some(p => p.raw === input)) {
          await ctx.reply(`Pattern "${input}" is already in the list.`);
        } else {
          bannedPatterns.push({ raw: input, regex });
          await saveBannedPatterns();
          await ctx.reply(`Filter "${input}" added.`);
        }
      } catch (e) {
        await ctx.reply(`Invalid pattern.`);
      }
    } else if (session.action === 'Remove Filter') {
      const index = bannedPatterns.findIndex(p => p.raw === input);
      if (index !== -1) {
        bannedPatterns.splice(index, 1);
        await saveBannedPatterns();
        await ctx.reply(`Filter "${input}" removed.`);
      } else {
        await ctx.reply(`Pattern "${input}" not found.`);
      }
    }
    session.action = undefined;
    adminSessions.set(adminId, session);
    await showMainMenu(ctx);
    return;
  }
  
  if (!input.startsWith('/')) {
    // For any arbitrary text, show the general help message (this message remains permanently)
    await sendGeneralHelp(ctx);
    return;
  }
  
  return next();
});

// Callback query handler for inline admin buttons
bot.on('callback_query', async (ctx) => {
  if (ctx.chat?.type !== 'private' || !(await isAuthorized(ctx))) {
    return ctx.answerCbQuery('Not authorized.');
  }
  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  if (data === 'menu_addFilter') {
    await promptForPattern(ctx, 'Add Filter');
  } else if (data === 'menu_removeFilter') {
    if (bannedPatterns.length === 0) {
      await ctx.editMessageText("No filters to remove.", {
        reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_back' }]] }
      });
    } else {
      const list = bannedPatterns.map(p => `<code>${p.raw}</code>`).join('\n');
      await showOrEditMenu(ctx, `Current filters:\n${list}\n\nEnter filter to remove:`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_back' }]] }
      });
      let session = adminSessions.get(ctx.from.id) || {};
      session.action = 'Remove Filter';
      adminSessions.set(ctx.from.id, session);
    }
  } else if (data === 'menu_listFilters') {
    if (bannedPatterns.length === 0) {
      await ctx.editMessageText("No filters currently set.", {
        reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_back' }]] }
      });
    } else {
      const list = bannedPatterns.map(p => `<code>${p.raw}</code>`).join('\n');
      await ctx.editMessageText(`Current filters:\n${list}`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_back' }]] }
      });
    }
  } else if (data === 'menu_toggleAction') {
    settings.action = settings.action === 'ban' ? 'kick' : 'ban';
    await saveSettings();
    await showMainMenu(ctx);
    await ctx.answerCbQuery(`Action now: ${settings.action.toUpperCase()}`);
  } else if (data === 'menu_back') {
    await showMainMenu(ctx);
  }
});

// Direct command handlers for /addFilter, /removeFilter, and /listFilters remain unchanged
bot.command('addFilter', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('Usage: /addFilter <pattern>\nExample: /addFilter spam');
  }
  const pattern = parts.slice(1).join(' ').trim();
  try {
    const regex = patternToRegex(pattern);
    if (bannedPatterns.some(p => p.raw === pattern)) {
      return ctx.reply(`Pattern "${pattern}" is already in the list.`);
    }
    bannedPatterns.push({ raw: pattern, regex });
    await saveBannedPatterns();
    return ctx.reply(`Filter added: "${pattern}"`);
  } catch (error) {
    return ctx.reply('Invalid pattern format.');
  }
});

bot.command('removeFilter', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    if (bannedPatterns.length === 0) {
      return ctx.reply('No patterns exist to remove.');
    }
    const patterns = bannedPatterns.map(p => `- ${p.raw}`).join('\n');
    return ctx.reply(`Usage: /removeFilter <pattern>\nCurrent patterns:\n${patterns}`);
  }
  const pattern = parts.slice(1).join(' ').trim();
  const index = bannedPatterns.findIndex(p => p.raw === pattern);
  if (index !== -1) {
    bannedPatterns.splice(index, 1);
    await saveBannedPatterns();
    return ctx.reply(`Filter removed: "${pattern}"`);
  } else {
    return ctx.reply(`Filter "${pattern}" not found.`);
  }
});

bot.command('listFilters', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;
  if (bannedPatterns.length === 0) {
    return ctx.reply('No filter patterns are currently set.');
  }
  const list = bannedPatterns.map(p => `- ${p.raw}`).join('\n');
  return ctx.reply(`Current filter patterns:\n${list}`);
});

// Chat info command
bot.command('chatinfo', async (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const chatTitle = ctx.chat.title || 'Private Chat';
  const isAllowed = isChatAllowed(ctx);
  const isAuth = await isAuthorized(ctx);
  let reply = `Chat: "${chatTitle}"\nID: ${chatId}\nType: ${chatType}\nBot allowed: ${isAllowed ? 'Yes' : 'No'}\nCan configure: ${isAuth ? 'Yes' : 'No'}\nCurrent action: ${settings.action.toUpperCase()}\n\n`;
  if (chatType === 'group' || chatType === 'supergroup') {
    reply += `Whitelisted group IDs: ${WHITELISTED_GROUP_IDS.join(', ')}\nID match: ${WHITELISTED_GROUP_IDS.includes(chatId) ? 'Yes' : 'No'}\n`;
    if (!WHITELISTED_GROUP_IDS.includes(chatId)) {
      reply += `\nThis group's ID is not whitelisted!`;
    }
  }
  try {
    await ctx.reply(reply);
    console.log(`Chat info provided for ${chatId} (${chatType})`);
  } catch (error) {
    console.error('Failed to send chat info:', error);
  }
});

// Set action command
bot.command('setaction', async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply(`Current action: ${settings.action.toUpperCase()}\nUsage: /setaction <ban|kick>`);
  }
  const action = args[1].toLowerCase();
  if (action !== 'ban' && action !== 'kick') {
    return ctx.reply('Invalid action. Use "ban" or "kick".');
  }
  settings.action = action;
  const success = await saveSettings();
  if (success) {
    return ctx.reply(`Action updated to: ${action.toUpperCase()}`);
  } else {
    return ctx.reply('Failed to save settings. Check logs for details.');
  }
});

// Command to show menu directly
bot.command('menu', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) {
    return ctx.reply('You are not authorized to configure the bot.');
  }
  await showMainMenu(ctx);
});

// Help and Start commands
bot.command('help', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;
  await showMainMenu(ctx);
});

bot.command('start', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) {
    return ctx.reply('You are not authorized to configure this bot.');
  }
  await showMainMenu(ctx);
});

// Message handler in private chat for admin menu
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return next();
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const input = ctx.message.text.trim();
  if (input.toLowerCase() === '/cancel') {
    session.action = undefined;
    adminSessions.set(adminId, session);
    await deleteMenu(ctx, "Action cancelled.");
    await showMainMenu(ctx);
    return;
  }
  if (session.action) {
    if (session.action === 'Add Filter') {
      try {
        const regex = patternToRegex(input);
        if (bannedPatterns.some(p => p.raw === input)) {
          await ctx.reply(`Pattern "${input}" is already in the list.`);
        } else {
          bannedPatterns.push({ raw: input, regex });
          await saveBannedPatterns();
          await ctx.reply(`Filter "${input}" added.`);
        }
      } catch (e) {
        await ctx.reply(`Invalid pattern.`);
      }
    } else if (session.action === 'Remove Filter') {
      const index = bannedPatterns.findIndex(p => p.raw === input);
      if (index !== -1) {
        bannedPatterns.splice(index, 1);
        await saveBannedPatterns();
        await ctx.reply(`Filter "${input}" removed.`);
      } else {
        await ctx.reply(`Pattern "${input}" not found.`);
      }
    }
    session.action = undefined;
    adminSessions.set(adminId, session);
    await showMainMenu(ctx);
    return;
  }
  // If no pending action and the text is not a command, show the menu.
  if (!input.startsWith('/')) {
    await showMainMenu(ctx);
  }
});

// Admin cache and debug middleware
bot.use((ctx, next) => {
  const now = new Date().toISOString();
  const updateType = ctx.updateType || 'unknown';
  const chatId = ctx.chat?.id || 'unknown';
  const chatType = ctx.chat?.type || 'unknown';
  const fromId = ctx.from?.id || 'unknown';
  const username = ctx.from?.username || 'no_username';
  console.log(`[${now}] Update: type=${updateType}, chat=${chatId} (${chatType}), from=${fromId} (@${username})`);
  if (ctx.message?.new_chat_members) {
    const newUsers = ctx.message.new_chat_members;
    console.log(`New users: ${newUsers.map(u => `${u.id} (@${u.username || 'no_username'})`).join(', ')}`);
  }
  if (ctx.updateType === 'message' && ctx.message?.text) {
    console.log(`Message text: ${ctx.message.text.substring(0, 50)}${ctx.message.text.length > 50 ? '...' : ''}`);
  }
  return next();
});

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    if (WHITELISTED_GROUP_IDS.includes(ctx.chat.id)) {
      try {
        const userId = ctx.from?.id;
        if (userId && !WHITELISTED_USER_IDS.includes(userId) && !knownGroupAdmins.has(userId)) {
          checkAndCacheGroupAdmin(userId, bot).catch(err => {
            console.error('Error checking admin status:', err);
          });
        }
      } catch (error) {
        console.error('Error in admin cache middleware:', error);
      }
    }
  }
  return next();
});

// New users handler
bot.on('new_chat_members', async (ctx) => {
  console.log('New user event triggered');
  if (!isChatAllowed(ctx)) {
    console.log(`Group not allowed: ${ctx.chat.id}`);
    return;
  }
  const chatId = ctx.chat.id;
  const newUsers = ctx.message.new_chat_members;
  console.log(`Processing ${newUsers.length} new users in chat ${chatId}`);
  for (const user of newUsers) {
    const username = user.username;
    const firstName = user.first_name;
    const lastName = user.last_name;
    const displayName = [firstName, lastName].filter(Boolean).join(' ');
    console.log(`Checking user: ${user.id} (@${username || 'no_username'}) Name: ${displayName}`);
    if (isBanned(username, firstName, lastName)) {
      await takePunishmentAction(ctx, user.id, displayName || username || user.id, chatId);
    } else {
      monitorNewUser(chatId, user);
    }
  }
});

// Message handler for banning users
bot.on('message', async (ctx, next) => {
  if (!isChatAllowed(ctx)) return next();
  const username = ctx.from?.username;
  const firstName = ctx.from?.first_name;
  const lastName = ctx.from?.last_name;
  const displayName = [firstName, lastName].filter(Boolean).join(' ');
  console.log(`Processing message from: ${ctx.from.id} (@${username || 'no_username'}) Name: ${displayName}`);
  if (isBanned(username, firstName, lastName)) {
    await takePunishmentAction(ctx, ctx.from.id, displayName || username || ctx.from.id, ctx.chat.id);
  } else {
    return next();
  }
});

// Chat info command
bot.command('chatinfo', async (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const chatTitle = ctx.chat.title || 'Private Chat';
  const isAllowed = isChatAllowed(ctx);
  const isAuth = await isAuthorized(ctx);
  let reply = `Chat: "${chatTitle}"\nID: ${chatId}\nType: ${chatType}\nBot allowed: ${isAllowed ? 'Yes' : 'No'}\nCan configure: ${isAuth ? 'Yes' : 'No'}\nCurrent action: ${settings.action.toUpperCase()}\n\n`;
  if (chatType === 'group' || chatType === 'supergroup') {
    reply += `Whitelisted group IDs: ${WHITELISTED_GROUP_IDS.join(', ')}\nID match: ${WHITELISTED_GROUP_IDS.includes(chatId) ? 'Yes' : 'No'}\n`;
    if (!WHITELISTED_GROUP_IDS.includes(chatId)) {
      reply += `\nThis group's ID is not whitelisted!`;
    }
  }
  try {
    await ctx.reply(reply);
    console.log(`Chat info provided for ${chatId} (${chatType})`);
  } catch (error) {
    console.error('Failed to send chat info:', error);
  }
});

// Set action command
bot.command('setaction', async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  const args = ctx.message.text.split(' ');
  if (args.length < 2) {
    return ctx.reply(`Current action: ${settings.action.toUpperCase()}\nUsage: /setaction <ban|kick>`);
  }
  const action = args[1].toLowerCase();
  if (action !== 'ban' && action !== 'kick') {
    return ctx.reply('Invalid action. Use "ban" or "kick".');
  }
  settings.action = action;
  const success = await saveSettings();
  if (success) {
    return ctx.reply(`Action updated to: ${action.toUpperCase()}`);
  } else {
    return ctx.reply('Failed to save settings. Check logs for details.');
  }
});

// Command to show menu directly
bot.command('menu', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) {
    return ctx.reply('You are not authorized to configure the bot.');
  }
  await showMainMenu(ctx);
});

// Help and Start commands simply show the menu
bot.command('help', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;
  await showMainMenu(ctx);
});

bot.command('start', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) {
    return ctx.reply('You are not authorized to configure this bot.');
  }
  await showMainMenu(ctx);
});

bot.launch({
  allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
  timeout: 30
})
.then(() => {
  console.log('\n==============================');
  console.log('Bot Started');
  console.log('==============================');
  console.log(`Loaded ${bannedPatterns.length} banned patterns`);
  console.log(`Current action: ${settings.action.toUpperCase()}`);
  console.log('Bot is running. Press Ctrl+C to stop.');
})
.catch(err => console.error('Bot launch error:', err));

const cleanup = (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  Object.values(newJoinMonitors).forEach(interval => clearInterval(interval));
  bot.stop(signal);
  setTimeout(() => {
    console.log('Forcing exit...');
    process.exit(0);
  }, 1000);
};

process.once('SIGINT', () => cleanup('SIGINT'));
process.once('SIGTERM', () => cleanup('SIGTERM'));
process.once('SIGUSR2', () => cleanup('SIGUSR2'));
