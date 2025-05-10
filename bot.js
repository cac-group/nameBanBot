// bot.js

import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import toml from 'toml';
import {
  BOT_TOKEN,
  BANNED_PATTERNS_DIR,
  WHITELISTED_USER_IDS,
  WHITELISTED_GROUP_IDS,
  DEFAULT_ACTION,
  SETTINGS_FILE
} from './config.js';

dotenv.config();

const bot = new Telegraf(BOT_TOKEN);

// In-memory Data
const groupPatterns = new Map(); // Map of groupId -> patterns array
const adminSessions = new Map();
const newJoinMonitors = {};
const knownGroupAdmins = new Set();
let settings = {
  groupActions: {} // stores groupId -> 'ban' or 'kick'
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
 * Checks if the provided username or display name matches any banned pattern for a specific group.
 */
function isBanned(username, firstName, lastName, groupId) {
  // Get patterns for this specific group
  const patterns = groupPatterns.get(groupId) || [];

  // Quick exit if no patterns exist for this group
  if (patterns.length === 0) return false;

  // Helper function to check if a string matches any pattern
  function matchesAnyPattern(str, description) {
    if (!str) return false;

    const cleanStr = str.toLowerCase();
    for (const pattern of patterns) {
      if (pattern.regex.test(cleanStr)) {
        console.log(`Match found in ${description}: "${cleanStr}" matched pattern: ${pattern.raw} for group ${groupId}`);
        return true;
      }
    }
    return false;
  }

  // 1) Check username if present
  if (username && matchesAnyPattern(username, "username")) {
    return true;
  }

  // 2) Check display name variations
  const displayName = [firstName, lastName].filter(Boolean).join(' ');
  if (!displayName) return false;

  // Original display name
  if (matchesAnyPattern(displayName, "display name")) {
    return true;
  }

  // Name with quotes removed
  const noQuotes = displayName.replace(/["'`]/g, '');
  if (noQuotes !== displayName && matchesAnyPattern(noQuotes, "display name (no quotes)")) {
    return true;
  }

  // Name with spaces removed
  const noSpaces = displayName.replace(/\s+/g, '');
  if (noSpaces !== displayName && matchesAnyPattern(noSpaces, "display name (no spaces)")) {
    return true;
  }

  // Name with both quotes and spaces removed
  const normalized = displayName.replace(/["'`\s]/g, '');
  if (normalized !== displayName && normalized !== noQuotes && normalized !== noSpaces) {
    if (matchesAnyPattern(normalized, "normalized name")) {
      return true;
    }
  }

  return false;
}

// Persistence Functions
async function ensureBannedPatternsDirectory() {
  try {
    await fs.mkdir(BANNED_PATTERNS_DIR, { recursive: true });
  } catch (err) {
    console.error(`Error creating directory ${BANNED_PATTERNS_DIR}:`, err);
  }
}

async function getGroupPatternFilePath(groupId) {
  return `${BANNED_PATTERNS_DIR}/patterns_${groupId}.toml`;
}

async function loadGroupPatterns(groupId) {
  try {
    const filePath = await getGroupPatternFilePath(groupId);
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = toml.parse(data);
    if (parsed.patterns && Array.isArray(parsed.patterns)) {
      return parsed.patterns.map(pt => ({
        raw: pt,
        regex: patternToRegex(pt)
      }));
    }
    return [];
  } catch (err) {
    // File doesn't exist or other error - return empty array
    if (err.code !== 'ENOENT') {
      console.error(`Error reading patterns for group ${groupId}:`, err);
    }
    return [];
  }
}

async function saveGroupPatterns(groupId, patterns) {
  const lines = patterns.map(({ raw }) => `  "${raw}"`).join(',\n');
  const content = `patterns = [\n${lines}\n]\n`;
  try {
    const filePath = await getGroupPatternFilePath(groupId);
    await fs.writeFile(filePath, content);
    console.log(`Saved ${patterns.length} patterns for group ${groupId}`);
  } catch (err) {
    console.error(`Error writing patterns for group ${groupId}:`, err);
  }
}

async function loadAllGroupPatterns() {
  await ensureBannedPatternsDirectory();

  for (const groupId of WHITELISTED_GROUP_IDS) {
    const patterns = await loadGroupPatterns(groupId);
    groupPatterns.set(groupId, patterns);
    console.log(`Loaded ${patterns.length} patterns for group ${groupId}`);
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
    
    // Ensure groupActions exists
    if (!settings.groupActions) {
      settings.groupActions = {};
    }
    
    // Migrate from old global action setting if present
    if (loadedSettings.action && Object.keys(settings.groupActions).length === 0) {
      // Apply the old global action to all whitelisted groups
      WHITELISTED_GROUP_IDS.forEach(groupId => {
        settings.groupActions[groupId] = loadedSettings.action;
      });
    }
    
    console.log(`Loaded settings:`, settings.groupActions);
  } catch (err) {
    console.log(`No settings file found or error reading. Using defaults.`);
    // Set default action for all whitelisted groups
    WHITELISTED_GROUP_IDS.forEach(groupId => {
      settings.groupActions[groupId] = DEFAULT_ACTION;
    });
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

// New function to get action for specific group
function getGroupAction(groupId) {
  return settings.groupActions[groupId] || DEFAULT_ACTION;
}

// Violation handling
async function takePunishmentAction(ctx, userId, username, chatId) {
  const action = getGroupAction(chatId);
  const isBan = action === 'ban';
  
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

// Watches new users for a set period of time for name changes
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
      
      if (isBanned(username, firstName, lastName, chatId)) {
        const action = getGroupAction(chatId);
        const isBan = action === 'ban';
        
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
// Show the main admin menu (updates an existing menu message if available)
async function showMainMenu(ctx) {
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };

  // Initialize with default values if not present
  if (!session.selectedGroupId && WHITELISTED_GROUP_IDS.length > 0) {
    session.selectedGroupId = WHITELISTED_GROUP_IDS[0];
  }

  const selectedGroupId = session.selectedGroupId;
  const patterns = groupPatterns.get(selectedGroupId) || [];
  const groupAction = getGroupAction(selectedGroupId);

  const text =
    `Admin Menu:\n` +
    `Selected Group: ${selectedGroupId}\n` +
    `Patterns: ${patterns.length}\n` +
    `Action: ${groupAction.toUpperCase()}\n\n` +
    `Use the buttons below to manage filters.`;

  // Create group selection buttons
  const groupButtons = WHITELISTED_GROUP_IDS.map(groupId => ({
    text: `${groupId === selectedGroupId ? '✅ ' : ''}Group ${groupId} (${getGroupAction(groupId).toUpperCase()})`,
    callback_data: `select_group_${groupId}`
  }));

  // Split group buttons into rows of 2
  const groupRows = [];
  for (let i = 0; i < groupButtons.length; i += 2) {
    groupRows.push(groupButtons.slice(i, i + 2));
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        ...groupRows,
        [{ text: 'Add Filter', callback_data: 'menu_addFilter' }],
        [{ text: 'Remove Filter', callback_data: 'menu_removeFilter' }],
        [{ text: 'List Filters', callback_data: 'menu_listFilters' }],
        [{ text: `Toggle: ${groupAction.toUpperCase()}`, callback_data: 'menu_toggleAction' }]
      ]
    }
  };

  try {
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
        if (!err.description || !err.description.includes("message is not modified")) {
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
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || {};
  const groupId = session.selectedGroupId;

  const promptText =
    `Enter pattern to ${actionLabel} for Group ${groupId}:\n` +
    `You may use wildcards (*, ?) or /regex/ format. Send /cancel to abort.`;

  session.action = actionLabel;
  adminSessions.set(adminId, session);
  await showOrEditMenu(ctx, promptText, { parse_mode: 'HTML' });
}

// --- Admin Command and Callback Handlers ---

// Direct messages in private chat for admin interaction
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
    const groupId = session.selectedGroupId;
    if (!groupId) {
      await ctx.reply("No group selected. Please select a group first.");
      await showMainMenu(ctx);
      return;
    }

    let patterns = groupPatterns.get(groupId) || [];

    if (session.action === 'Add Filter') {
      try {
        const regex = patternToRegex(input);
        if (patterns.some(p => p.raw === input)) {
          await ctx.reply(`Pattern "${input}" is already in the list for Group ${groupId}.`);
        } else {
          patterns.push({ raw: input, regex });
          groupPatterns.set(groupId, patterns);
          await saveGroupPatterns(groupId, patterns);
          await ctx.reply(`Filter "${input}" added to Group ${groupId}.`);
        }
      } catch (e) {
        await ctx.reply(`Invalid pattern.`);
      }
    } else if (session.action === 'Remove Filter') {
      const index = patterns.findIndex(p => p.raw === input);
      if (index !== -1) {
        patterns.splice(index, 1);
        groupPatterns.set(groupId, patterns);
        await saveGroupPatterns(groupId, patterns);
        await ctx.reply(`Filter "${input}" removed from Group ${groupId}.`);
      } else {
        await ctx.reply(`Pattern "${input}" not found in Group ${groupId}.`);
      }
    }

    session.action = undefined;
    adminSessions.set(adminId, session);
    await showMainMenu(ctx);
    return;
  }

  if (!input.startsWith('/')) {
    await showMainMenu(ctx);
  }
});

// Callback handler for inline buttons in admin menu
bot.on('callback_query', async (ctx) => {
  if (ctx.chat?.type !== 'private' || !(await isAuthorized(ctx))) {
    return ctx.answerCbQuery('Not authorized.');
  }

  await ctx.answerCbQuery();
  const data = ctx.callbackQuery.data;
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };

  // Handle group selection
  if (data.startsWith('select_group_')) {
    const groupId = parseInt(data.replace('select_group_', ''));
    if (WHITELISTED_GROUP_IDS.includes(groupId)) {
      session.selectedGroupId = groupId;
      adminSessions.set(adminId, session);
      await ctx.answerCbQuery(`Selected Group: ${groupId}`);
      await showMainMenu(ctx);
      return;
    }
  }

  const groupId = session.selectedGroupId;
  if (!groupId && !data.includes('menu_back')) {
    await ctx.answerCbQuery('No group selected');
    await showMainMenu(ctx);
    return;
  }

  if (data === 'menu_addFilter') {
    await promptForPattern(ctx, 'Add Filter');
  } else if (data === 'menu_removeFilter') {
    const patterns = groupPatterns.get(groupId) || [];
    if (patterns.length === 0) {
      await ctx.editMessageText(`No filters to remove for Group ${groupId}.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_back' }]] }
      });
    } else {
      const list = patterns.map(p => `<code>${p.raw}</code>`).join('\n');
      await showOrEditMenu(ctx, `Current filters for Group ${groupId}:\n${list}\n\nEnter filter to remove:`, { 
        parse_mode: 'HTML', 
        reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_back' }]] } 
      });
      session.action = 'Remove Filter';
      adminSessions.set(adminId, session);
    }
  } else if (data === 'menu_listFilters') {
    const patterns = groupPatterns.get(groupId) || [];
    if (patterns.length === 0) {
      await ctx.editMessageText(`No filters currently set for Group ${groupId}.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_back' }]] }
      });
    } else {
      const list = patterns.map(p => `<code>${p.raw}</code>`).join('\n');
      await ctx.editMessageText(`Current filters for Group ${groupId}:\n${list}`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: 'Back to Menu', callback_data: 'menu_back' }]] }
      });
    }
  } else if (data === 'menu_toggleAction') {
    // Toggle action for the selected group only
    const currentAction = getGroupAction(groupId);
    const newAction = currentAction === 'ban' ? 'kick' : 'ban';
    settings.groupActions[groupId] = newAction;
    await saveSettings();
    await showMainMenu(ctx);
    await ctx.answerCbQuery(`Action now: ${newAction.toUpperCase()} for Group ${groupId}`);
  } else if (data === 'menu_back') {
    await showMainMenu(ctx);
  }
});

// Direct command handlers for /addFilter, /removeFilter, /listFilters
bot.command('addFilter', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;

  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const groupId = session.selectedGroupId;

  if (!groupId) {
    return ctx.reply('No group selected. Use /menu to select a group first.');
  }

  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply(`Usage: /addFilter <pattern>\nExample: /addFilter spam\nCurrent Group: ${groupId}`);
  }

  const pattern = parts.slice(1).join(' ').trim();
  let patterns = groupPatterns.get(groupId) || [];

  try {
    const regex = patternToRegex(pattern);
    if (patterns.some(p => p.raw === pattern)) {
      return ctx.reply(`Pattern "${pattern}" is already in the list for Group ${groupId}.`);
    }
    patterns.push({ raw: pattern, regex });
    groupPatterns.set(groupId, patterns);
    await saveGroupPatterns(groupId, patterns);
    return ctx.reply(`Filter added: "${pattern}" to Group ${groupId}`);
  } catch (error) {
    return ctx.reply('Invalid pattern format.');
  }
});

bot.command('removeFilter', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;

  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const groupId = session.selectedGroupId;

  if (!groupId) {
    return ctx.reply('No group selected. Use /menu to select a group first.');
  }

  let patterns = groupPatterns.get(groupId) || [];

  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    if (patterns.length === 0) {
      return ctx.reply(`No patterns exist to remove for Group ${groupId}.`);
    }
    const patternsList = patterns.map(p => `- ${p.raw}`).join('\n');
    return ctx.reply(`Usage: /removeFilter <pattern>\nCurrent patterns for Group ${groupId}:\n${patternsList}`);
  }

  const pattern = parts.slice(1).join(' ').trim();
  const index = patterns.findIndex(p => p.raw === pattern);

  if (index !== -1) {
    patterns.splice(index, 1);
    groupPatterns.set(groupId, patterns);
    await saveGroupPatterns(groupId, patterns);
    return ctx.reply(`Filter removed: "${pattern}" from Group ${groupId}`);
  } else {
    return ctx.reply(`Filter "${pattern}" not found in Group ${groupId}.`);
  }
});

bot.command('listFilters', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;

  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const groupId = session.selectedGroupId;

  if (!groupId) {
    return ctx.reply('No group selected. Use /menu to select a group first.');
  }

  const patterns = groupPatterns.get(groupId) || [];

  if (patterns.length === 0) {
    return ctx.reply(`No filter patterns are currently set for Group ${groupId}.`);
  }

  const list = patterns.map(p => `- ${p.raw}`).join('\n');
  return ctx.reply(`Current filter patterns for Group ${groupId}:\n${list}`);
});

// Chat info command
bot.command('chatinfo', async (ctx) => {
  const chatId = ctx.chat.id;
  const chatType = ctx.chat.type;
  const chatTitle = ctx.chat.title || 'Private Chat';
  const isAllowed = isChatAllowed(ctx);
  const isAuth = await isAuthorized(ctx);
  const groupAction = getGroupAction(chatId);
  
  let reply = `Chat: "${chatTitle}"\nID: ${chatId}\nType: ${chatType}\nBot allowed: ${isAllowed ? 'Yes' : 'No'}\nCan configure: ${isAuth ? 'Yes' : 'No'}\nCurrent action: ${groupAction.toUpperCase()}\n\n`;

  if (chatType === 'group' || chatType === 'supergroup') {
    reply += `Whitelisted group IDs: ${WHITELISTED_GROUP_IDS.join(', ')}\nID match: ${WHITELISTED_GROUP_IDS.includes(chatId) ? 'Yes' : 'No'}\n`;

    if (WHITELISTED_GROUP_IDS.includes(chatId)) {
      const patterns = groupPatterns.get(chatId) || [];
      reply += `\nThis group has ${patterns.length} banned patterns.`;
    } else {
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
  
  // If in group, check if user is admin of that group
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    if (!WHITELISTED_GROUP_IDS.includes(ctx.chat.id)) {
      return ctx.reply('This command only works in whitelisted groups.');
    }
    
    // Check if user is admin of this specific group
    try {
      const user = await ctx.getChatMember(ctx.from.id);
      if (user.status !== 'administrator' && user.status !== 'creator' && !WHITELISTED_USER_IDS.includes(ctx.from.id)) {
        return ctx.reply('You must be a group admin to change this setting.');
      }
    } catch (e) {
      return ctx.reply('Error checking admin status.');
    }
    
    const groupId = ctx.chat.id;
    const currentAction = getGroupAction(groupId);
    
    if (args.length < 2) {
      return ctx.reply(`Current action for this group: ${currentAction.toUpperCase()}\nUsage: /setaction <ban|kick>`);
    }
    
    const action = args[1].toLowerCase();
    if (action !== 'ban' && action !== 'kick') {
      return ctx.reply('Invalid action. Use "ban" or "kick".');
    }
    
    settings.groupActions[groupId] = action;
    const success = await saveSettings();
    if (success) {
      return ctx.reply(`Action updated to: ${action.toUpperCase()} for this group`);
    } else {
      return ctx.reply('Failed to save settings. Check logs for details.');
    }
  } 
  
  // If in private chat, use selected group from session
  else {
    const adminId = ctx.from.id;
    let session = adminSessions.get(adminId) || {};
    const groupId = session.selectedGroupId;
    
    if (!groupId) {
      return ctx.reply('No group selected. Use /menu to select a group first.');
    }
    
    const currentAction = getGroupAction(groupId);
    
    if (args.length < 2) {
      return ctx.reply(`Current action for Group ${groupId}: ${currentAction.toUpperCase()}\nUsage: /setaction <ban|kick>`);
    }
    
    const action = args[1].toLowerCase();
    if (action !== 'ban' && action !== 'kick') {
      return ctx.reply('Invalid action. Use "ban" or "kick".');
    }
    
    settings.groupActions[groupId] = action;
    const success = await saveSettings();
    if (success) {
      return ctx.reply(`Action updated to: ${action.toUpperCase()} for Group ${groupId}`);
    } else {
      return ctx.reply('Failed to save settings. Check logs for details.');
    }
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

  const helpText = 
    `Telegram Ban Bot Help\n\n` +
    `Admin Commands:\n` +
    `• /menu - Open the interactive configuration menu\n` +
    `• /addFilter <pattern> - Add a filter pattern\n` +
    `• /removeFilter <pattern> - Remove a filter pattern\n` +
    `• /listFilters - List all filter patterns\n` +
    `• /setaction <ban|kick> - Set action for matches\n` +
    `• /chatinfo - Show information about current chat\n` +
    `• /cancel - Cancel current operation\n\n` +

    `Pattern Formats:\n` +
    `• Simple text: "spam"\n` +
    `• Wildcards: "spam*site", "*bad*user*"\n` +
    `• Regex: "/^bad.*user$/i"\n\n` +

    `The bot checks user names when they:\n` +
    `1. Join a group\n` +
    `2. Change their name/username (monitored for 30 sec)\n` +
    `3. Send messages\n\n` +
  
    `Use /menu to configure banned patterns for each group.`;

  await ctx.reply(helpText);
});

bot.command('start', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) {
    return ctx.reply('You are not authorized to configure this bot.');
  }

  await ctx.reply('Welcome to the Telegram Ban Bot! Use /menu to configure or /help for commands.');
  await showMainMenu(ctx);
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

    if (isBanned(username, firstName, lastName, chatId)) {
      await takePunishmentAction(ctx, user.id, displayName || username || user.id, chatId);
    } else {
      monitorNewUser(chatId, user);
    }
  }
});

// Message handler for banning users
bot.on('message', async (ctx, next) => {
  if (!isChatAllowed(ctx)) return next();

  const chatId = ctx.chat.id;
  const username = ctx.from?.username;
  const firstName = ctx.from?.first_name;
  const lastName = ctx.from?.last_name;
  const displayName = [firstName, lastName].filter(Boolean).join(' ');

  console.log(`Processing message from: ${ctx.from.id} (@${username || 'no_username'}) Name: ${displayName}`);

  if (isBanned(username, firstName, lastName, chatId)) {
    await takePunishmentAction(ctx, ctx.from.id, displayName || username || ctx.from.id, chatId);
  } else {
    return next();
  }
});

// Startup and cleanup
async function startup() {
  await ensureBannedPatternsDirectory();
  await loadSettings();
  await loadAllGroupPatterns();

  // Ensure all whitelisted groups have an action setting
  WHITELISTED_GROUP_IDS.forEach(groupId => {
    if (!settings.groupActions[groupId]) {
      settings.groupActions[groupId] = DEFAULT_ACTION;
    }
  });
  await saveSettings();

  bot.launch({
    allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
    timeout: 30
  })
  .then(() => {
    console.log('\n==============================');
    console.log('Bot Started');
    console.log('==============================');
    console.log(`Loaded patterns for ${groupPatterns.size} groups`);
    console.log(`Group actions:`, settings.groupActions);
    console.log('Bot is running. Press Ctrl+C to stop.');
  })
  .catch(err => console.error('Bot launch error:', err));
}

process.once('SIGINT', () => cleanup('SIGINT'));
process.once('SIGTERM', () => cleanup('SIGTERM'));
process.once('SIGUSR2', () => cleanup('SIGUSR2'));

// Start the bot
startup();