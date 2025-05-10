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

// Import security functions
import {
  validatePattern,
  createPatternObject,
  matchesPattern
} from './security.js';

dotenv.config();

const bot = new Telegraf(BOT_TOKEN);

// In-memory Data
const groupPatterns = new Map(); // Map of groupId -> patterns array
const adminSessions = new Map();
const newJoinMonitors = {};
const knownGroupAdmins = new Set();
let settings = {
  groupActions: {} // Per-group actions
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
  const chatType = ctx.chat?.type;
  if (chatType === 'group' || chatType === 'supergroup') {
    const isAllowed = WHITELISTED_GROUP_IDS.includes(ctx.chat.id);
    console.log(`[CHAT_CHECK] Group ${ctx.chat.id} (${chatType}) - Allowed: ${isAllowed}`);
    return isAllowed;
  }
  console.log(`[CHAT_CHECK] Non-group chat (${chatType}) - Always allowed`);
  return true;
}

function getRandomMessage(userId, isBan = true) {
  const messageArray = isBan ? banMessages : kickMessages;
  const randomIndex = Math.floor(Math.random() * messageArray.length);
  const message = messageArray[randomIndex].replace('{userId}', userId);
  console.log(`[MESSAGE] Generated ${isBan ? 'ban' : 'kick'} message for user ${userId}: "${message}"`);
  return message;
}

function getGroupAction(groupId) {
  const action = settings.groupActions[groupId] || DEFAULT_ACTION;
  console.log(`[ACTION] Group ${groupId} action: ${action.toUpperCase()}`);
  return action;
}

async function checkAndCacheGroupAdmin(userId, bot) {
  console.log(`[ADMIN_CHECK] Checking admin status for user ${userId}`);
  
  if (WHITELISTED_USER_IDS.includes(userId)) {
    console.log(`[ADMIN_CHECK] User ${userId} is in whitelist - granted admin`);
    return true;
  }
  
  for (const groupId of WHITELISTED_GROUP_IDS) {
    try {
      const user = await bot.telegram.getChatMember(groupId, userId);
      if (user.status === 'administrator' || user.status === 'creator') {
        knownGroupAdmins.add(userId);
        console.log(`[ADMIN_CHECK] User ${userId} is admin in group ${groupId} - cached`);
        return true;
      }
    } catch (error) {
      console.log(`[ADMIN_CHECK] User ${userId} not found in group ${groupId}`);
    }
  }
  
  console.log(`[ADMIN_CHECK] User ${userId} is not an admin in any group`);
  return false;
}

async function isAuthorized(ctx) {
  console.log(`[AUTH] Checking authorization for user ${ctx.from.id} in ${ctx.chat.type} chat`);
  
  if (!isChatAllowed(ctx)) {
    console.log(`[AUTH] Chat not allowed - denied`);
    return false;
  }
  
  const userId = ctx.from.id;
  if (WHITELISTED_USER_IDS.includes(userId) || knownGroupAdmins.has(userId)) {
    console.log(`[AUTH] User ${userId} authorized via whitelist/cache`);
    return true;
  }
  
  if (ctx.chat.type === 'private') {
    const result = await checkAndCacheGroupAdmin(userId, bot);
    console.log(`[AUTH] Private chat admin check result: ${result}`);
    return result;
  } else if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    try {
      const user = await ctx.getChatMember(userId);
      const isGroupAdmin = (user.status === 'administrator' || user.status === 'creator');
      if (isGroupAdmin) {
        knownGroupAdmins.add(userId);
        console.log(`[AUTH] User ${userId} is admin in group ${ctx.chat.id} - authorized`);
        return true;
      }
      console.log(`[AUTH] User ${userId} is not admin in group ${ctx.chat.id} - denied`);
      return false;
    } catch (e) {
      console.error(`[AUTH] Error checking group membership: ${e.message}`);
      return false;
    }
  }
  
  console.log(`[AUTH] Authorization denied for user ${userId}`);
  return false;
}

// Pattern matching using security module
async function isBanned(username, firstName, lastName, groupId) {
  console.log(`[BAN_CHECK] Checking user: @${username || 'no_username'}, Name: ${[firstName, lastName].filter(Boolean).join(' ')}, Group: ${groupId}`);
  
  const patterns = groupPatterns.get(groupId) || [];
  
  // Quick exit if no patterns
  if (patterns.length === 0) {
    console.log(`[BAN_CHECK] No patterns configured for group ${groupId} - not banned`);
    return false;
  }
  
  console.log(`[BAN_CHECK] Testing against ${patterns.length} patterns`);
  
  // Test each pattern safely
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    console.log(`[BAN_CHECK] Testing pattern ${i + 1}/${patterns.length}: "${pattern.raw}"`);
    
    try {
      // Test username
      if (username) {
        const usernameMatch = await matchesPattern(pattern.raw, username.toLowerCase());
        if (usernameMatch) {
          console.log(`[BAN_CHECK] ✅ BANNED - Username "${username}" matched pattern "${pattern.raw}"`);
          return true;
        }
      }
      
      // Test display name variations
      const displayName = [firstName, lastName].filter(Boolean).join(' ');
      if (displayName) {
        const variations = [
          displayName,
          displayName.replace(/["'`]/g, ''),
          displayName.replace(/\s+/g, ''),
          displayName.replace(/["'`\s]/g, '')
        ];
        
        for (const variation of variations) {
          const nameMatch = await matchesPattern(pattern.raw, variation.toLowerCase());
          if (nameMatch) {
            console.log(`[BAN_CHECK] ✅ BANNED - Display name "${variation}" matched pattern "${pattern.raw}"`);
            return true;
          }
        }
      }
    } catch (err) {
      console.error(`[BAN_CHECK] Error testing pattern "${pattern.raw}": ${err.message}`);
      continue;
    }
  }
  
  console.log(`[BAN_CHECK] User not banned - no pattern matches`);
  return false;
}

// Persistence Functions
async function ensureBannedPatternsDirectory() {
  console.log(`[INIT] Creating patterns directory: ${BANNED_PATTERNS_DIR}`);
  try {
    await fs.mkdir(BANNED_PATTERNS_DIR, { recursive: true });
    console.log(`[INIT] Patterns directory ready`);
  } catch (err) {
    console.error(`[INIT] Error creating directory ${BANNED_PATTERNS_DIR}:`, err);
  }
}

async function getGroupPatternFilePath(groupId) {
  const path = `${BANNED_PATTERNS_DIR}/patterns_${groupId}.toml`;
  console.log(`[FILE] Pattern file path for group ${groupId}: ${path}`);
  return path;
}

async function loadGroupPatterns(groupId) {
  console.log(`[LOAD] Loading patterns for group ${groupId}`);
  
  try {
    const filePath = await getGroupPatternFilePath(groupId);
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = toml.parse(data);
    
    if (!parsed.patterns || !Array.isArray(parsed.patterns)) {
      console.log(`[LOAD] No patterns array found in file for group ${groupId}`);
      return [];
    }
    
    console.log(`[LOAD] Found ${parsed.patterns.length} patterns in file`);
    
    const validatedPatterns = [];
    for (let i = 0; i < parsed.patterns.length; i++) {
      const pt = parsed.patterns[i];
      try {
        // Use security module to validate and create pattern objects
        const patternObj = createPatternObject(pt);
        validatedPatterns.push(patternObj);
        console.log(`[LOAD] ✅ Pattern ${i + 1}: "${pt}" - validated`);
        
        // Safety limit
        if (validatedPatterns.length >= 100) {
          console.warn(`[LOAD] Reached maximum patterns (100) for group ${groupId}`);
          break;
        }
      } catch (err) {
        console.warn(`[LOAD] ❌ Pattern ${i + 1}: "${pt}" - skipped: ${err.message}`);
      }
    }
    
    console.log(`[LOAD] Loaded ${validatedPatterns.length} valid patterns for group ${groupId}`);
    return validatedPatterns;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[LOAD] Error reading patterns for group ${groupId}:`, err);
    } else {
      console.log(`[LOAD] No pattern file exists for group ${groupId}`);
    }
    return [];
  }
}

async function saveGroupPatterns(groupId, patterns) {
  console.log(`[SAVE] Saving ${patterns.length} patterns for group ${groupId}`);
  
  const lines = patterns.map(({ raw }) => `  "${raw}"`).join(',\n');
  const content = `patterns = [\n${lines}\n]\n`;
  
  try {
    const filePath = await getGroupPatternFilePath(groupId);
    await fs.writeFile(filePath, content);
    console.log(`[SAVE] ✅ Successfully saved patterns to ${filePath}`);
  } catch (err) {
    console.error(`[SAVE] ❌ Error writing patterns for group ${groupId}:`, err);
  }
}

async function loadAllGroupPatterns() {
  console.log(`[INIT] Loading patterns for all whitelisted groups`);
  await ensureBannedPatternsDirectory();

  for (const groupId of WHITELISTED_GROUP_IDS) {
    const patterns = await loadGroupPatterns(groupId);
    groupPatterns.set(groupId, patterns);
    console.log(`[INIT] Group ${groupId}: loaded ${patterns.length} patterns`);
  }
  
  console.log(`[INIT] Pattern loading complete - ${groupPatterns.size} groups configured`);
}

async function loadSettings() {
  console.log(`[SETTINGS] Loading settings from ${SETTINGS_FILE}`);
  
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
      console.log(`[SETTINGS] Created empty groupActions object`);
    }
    
    // Migrate from old global action setting if present
    if (loadedSettings.action && Object.keys(settings.groupActions).length === 0) {
      console.log(`[SETTINGS] Migrating old global action: ${loadedSettings.action}`);
      WHITELISTED_GROUP_IDS.forEach(groupId => {
        settings.groupActions[groupId] = loadedSettings.action;
      });
    }
    
    console.log(`[SETTINGS] Loaded settings:`, settings.groupActions);
  } catch (err) {
    console.log(`[SETTINGS] No settings file found or error reading - using defaults`);
    // Set default action for all whitelisted groups
    settings.groupActions = {};
    WHITELISTED_GROUP_IDS.forEach(groupId => {
      settings.groupActions[groupId] = DEFAULT_ACTION;
      console.log(`[SETTINGS] Default action for group ${groupId}: ${DEFAULT_ACTION}`);
    });
    try {
      await saveSettings();
    } catch (saveErr) {
      console.error(`[SETTINGS] Failed to create initial settings file:`, saveErr);
    }
  }
}

async function saveSettings() {
  console.log(`[SETTINGS] Saving settings to ${SETTINGS_FILE}`);
  
  try {
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    console.log(`[SETTINGS] ✅ Settings saved successfully`);
    return true;
  } catch (err) {
    console.error(`[SETTINGS] ❌ Error writing settings:`, err);
    return false;
  }
}

// Action Handlers
async function takePunishmentAction(ctx, userId, username, chatId) {
  const action = getGroupAction(chatId);
  const isBan = action === 'ban';
  
  console.log(`[PUNISH] Taking ${action.toUpperCase()} action against user ${userId} (@${username}) in chat ${chatId}`);
  
  try {
    if (isBan) {
      await ctx.banChatMember(userId);
    } else {
      await ctx.banChatMember(userId, { until_date: Math.floor(Date.now() / 1000) + 35 });
    }
    const message = getRandomMessage(userId, isBan);
    await ctx.reply(message);
    console.log(`[PUNISH] ✅ ${isBan ? 'Banned' : 'Kicked'} user ${userId} successfully`);
    return true;
  } catch (error) {
    console.error(`[PUNISH] ❌ Failed to ${isBan ? 'ban' : 'kick'} user ${userId}:`, error);
    return false;
  }
}

// User Monitoring
function monitorNewUser(chatId, user) {
  const key = `${chatId}_${user.id}`;
  console.log(`[MONITOR] Starting name change monitoring for user ${user.id} in chat ${chatId}`);
  
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    console.log(`[MONITOR] Check ${attempts}/6 for user ${user.id}`);
    
    try {
      const chatMember = await bot.telegram.getChatMember(chatId, user.id);
      const username = chatMember.user.username;
      const firstName = chatMember.user.first_name;
      const lastName = chatMember.user.last_name;
      const displayName = [firstName, lastName].filter(Boolean).join(' ');
      
      console.log(`[MONITOR] Current name: @${username || 'no_username'}, Display: ${displayName}`);
      
      if (await isBanned(username, firstName, lastName, chatId)) {
        const action = getGroupAction(chatId);
        const isBan = action === 'ban';
        
        console.log(`[MONITOR] 🚫 User ${user.id} matched pattern - taking action: ${action.toUpperCase()}`);
        
        if (isBan) {
          await bot.telegram.banChatMember(chatId, user.id);
        } else {
          await bot.telegram.banChatMember(chatId, user.id, { until_date: Math.floor(Date.now() / 1000) + 35 });
        }
        const message = getRandomMessage(user.id, isBan);
        await bot.telegram.sendMessage(chatId, message);
        
        clearInterval(interval);
        delete newJoinMonitors[key];
        console.log(`[MONITOR] Monitoring stopped - user ${user.id} was ${action}ned`);
        return;
      }
      
      if (attempts >= 6) {
        console.log(`[MONITOR] Monitoring completed for user ${user.id} - no violations`);
        clearInterval(interval);
        delete newJoinMonitors[key];
      }
    } catch (error) {
      console.error(`[MONITOR] Error checking user ${user.id}:`, error);
      clearInterval(interval);
      delete newJoinMonitors[key];
    }
  }, 5000);
  
  newJoinMonitors[key] = interval;
}

// --- Admin Menu Functions ---
// Show the main admin menu (updates an existing menu message if available)
async function showMainMenu(ctx) {
  console.log(`[MENU] Showing main menu for admin ${ctx.from.id}`);
  
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };

  // Initialize with default values if not present
  if (!session.selectedGroupId && WHITELISTED_GROUP_IDS.length > 0) {
    session.selectedGroupId = WHITELISTED_GROUP_IDS[0];
    console.log(`[MENU] Auto-selected first group: ${session.selectedGroupId}`);
  }

  const selectedGroupId = session.selectedGroupId;
  const patterns = groupPatterns.get(selectedGroupId) || [];
  const groupAction = getGroupAction(selectedGroupId);

  const text =
    `🛡️ <b>Admin Menu</b>\n` +
    `📍 Selected Group: ${selectedGroupId}\n` +
    `📋 Patterns: ${patterns.length}\n` +
    `⚔️ Action: ${groupAction.toUpperCase()}\n\n` +
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
        [
          { text: '➕ Add Filter', callback_data: 'menu_addFilter' },
          { text: '➖ Remove Filter', callback_data: 'menu_removeFilter' }
        ],
        [
          { text: '📋 List Filters', callback_data: 'menu_listFilters' },
          { text: `⚔️ Toggle: ${groupAction.toUpperCase()}`, callback_data: 'menu_toggleAction' }
        ],
        [{ text: '❓ Pattern Help', callback_data: 'menu_patternHelp' }]
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
          { parse_mode: 'HTML', ...keyboard }
        );
        console.log(`[MENU] Updated existing menu message`);
      } catch (err) {
        // If the message content is unchanged, ignore the error
        if (!err.description || !err.description.includes("message is not modified")) {
          throw err;
        }
      }
    } else {
      const message = await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
      session.menuMessageId = message.message_id;
      session.chatId = ctx.chat.id;
      adminSessions.set(adminId, session);
      console.log(`[MENU] Created new menu message ${message.message_id}`);
    }
  } catch (e) {
    console.error(`[MENU] Error showing main menu:`, e);
  }
}

// Show or edit a menu-like message (used for prompts)
async function showOrEditMenu(ctx, text, extra) {
  if (ctx.chat.type !== 'private') return;
  
  console.log(`[MENU] Showing/editing prompt for admin ${ctx.from.id}`);
  
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
      console.log(`[MENU] Updated prompt message`);
    } else {
      const msg = await ctx.reply(text, extra);
      session.menuMessageId = msg.message_id;
      session.chatId = ctx.chat.id;
      adminSessions.set(adminId, session);
      console.log(`[MENU] Created new prompt message ${msg.message_id}`);
    }
  } catch (e) {
    console.error(`[MENU] Error showing/editing prompt:`, e);
  }
}

// Delete the current admin menu message and optionally send a confirmation
async function deleteMenu(ctx, confirmationMessage) {
  if (ctx.chat.type !== 'private') return;
  
  console.log(`[MENU] Deleting menu for admin ${ctx.from.id}`);
  
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId);
  if (session && session.menuMessageId) {
    try {
      await ctx.telegram.deleteMessage(session.chatId, session.menuMessageId);
      console.log(`[MENU] Deleted menu message ${session.menuMessageId}`);
    } catch (e) {
      console.error(`[MENU] Error deleting menu:`, e);
    }
    session.menuMessageId = null;
    adminSessions.set(adminId, session);
  }
  if (confirmationMessage) {
    await ctx.reply(confirmationMessage);
    console.log(`[MENU] Sent confirmation: "${confirmationMessage}"`);
  }
}

// Prompt the admin for a pattern, setting the session action accordingly
async function promptForPattern(ctx, actionLabel) {
  if (ctx.chat.type !== 'private') return;
  
  console.log(`[MENU] Prompting for pattern: ${actionLabel}`);
  
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || {};
  const groupId = session.selectedGroupId;

  const promptText = 
    `✨ <b>Add Pattern for Group ${groupId}</b> ✨\n\n` +
    
    `<b>📝 Pattern Types:</b>\n\n` +
    
    `<b>1. Simple Text</b> - Case-insensitive match\n` +
    `   • <code>spam</code> matches "SPAM", "Spam", "spam"\n\n` +
    
    `<b>2. Wildcards</b>\n` +
    `   • <code>*</code> = any characters\n` +
    `   • <code>?</code> = single character\n` +
    `   • <code>spam*</code> matches "spam123", "spammer", etc.\n` +
    `   • <code>*bot*</code> matches "testbot", "bot_user", etc.\n` +
    `   • <code>test?</code> matches "test1", "testa", etc.\n\n` +
    
    `<b>3. Regular Expressions</b> - Advanced patterns\n` +
    `   • Format: <code>/pattern/flags</code>\n` +
    `   • <code>/^spam.*$/i</code> starts with "spam"\n` +
    `   • <code>/\\d{5,}/</code> 5+ digits in a row\n` +
    `   • <code>/ch[!1i]ld/i</code> "child", "ch!ld", "ch1ld"\n\n` +
    
    `<b>💡 Examples:</b>\n` +
    `• <code>ranger</code> - blocks "ranger"\n` +
    `• <code>*porn*</code> - blocks anything with "porn"\n` +
    `• <code>/❤.*ch.ld.*p.rn/i</code> - blocks heart+variations\n\n` +
    
    `Send your pattern or /cancel to abort.`;

  session.action = actionLabel;
  adminSessions.set(adminId, session);
  await showOrEditMenu(ctx, promptText, { 
    parse_mode: 'HTML',
    reply_markup: { 
      inline_keyboard: [[{ text: 'Cancel', callback_data: 'menu_back' }]] 
    } 
  });
}

// --- Admin Command and Callback Handlers ---

// Direct messages in private chat for admin interaction
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return next();
  
  console.log(`[ADMIN_TEXT] Received text from admin ${ctx.from.id}: "${ctx.message.text}"`);
  
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const input = ctx.message.text.trim();

  if (input.toLowerCase() === '/cancel') {
    console.log(`[ADMIN_TEXT] Admin ${adminId} cancelled current action`);
    session.action = undefined;
    adminSessions.set(adminId, session);
    await deleteMenu(ctx, "Action cancelled.");
    await showMainMenu(ctx);
    return;
  }

  if (session.action) {
    const groupId = session.selectedGroupId;
    if (!groupId) {
      console.log(`[ADMIN_TEXT] No group selected for admin ${adminId}`);
      await ctx.reply("No group selected. Please select a group first.");
      await showMainMenu(ctx);
      return;
    }

    let patterns = groupPatterns.get(groupId) || [];

    if (session.action === 'Add Filter') {
      console.log(`[ADMIN_TEXT] Adding filter for group ${groupId}: "${input}"`);
      try {
        // Use security module to validate and create pattern
        const patternObj = createPatternObject(input);
        
        if (patterns.some(p => p.raw === patternObj.raw)) {
          console.log(`[ADMIN_TEXT] Pattern already exists: "${patternObj.raw}"`);
          await ctx.reply(`Pattern "${patternObj.raw}" is already in the list for Group ${groupId}.`);
        } else if (patterns.length >= 100) {
          console.log(`[ADMIN_TEXT] Maximum patterns reached for group ${groupId}`);
          await ctx.reply(`Maximum patterns (100) reached for Group ${groupId}.`);
        } else {
          patterns.push(patternObj);
          groupPatterns.set(groupId, patterns);
          await saveGroupPatterns(groupId, patterns);
          console.log(`[ADMIN_TEXT] ✅ Added pattern "${patternObj.raw}" to group ${groupId}`);
          await ctx.reply(`Filter "${patternObj.raw}" added to Group ${groupId}.`);
        }
      } catch (e) {
        console.log(`[ADMIN_TEXT] ❌ Invalid pattern: ${e.message}`);
        await ctx.reply(`Invalid pattern: ${e.message}`);
      }
    } else if (session.action === 'Remove Filter') {
      console.log(`[ADMIN_TEXT] Removing filter for group ${groupId}: "${input}"`);
      const index = patterns.findIndex(p => p.raw === input);
      if (index !== -1) {
        patterns.splice(index, 1);
        groupPatterns.set(groupId, patterns);
        await saveGroupPatterns(groupId, patterns);
        console.log(`[ADMIN_TEXT] ✅ Removed pattern "${input}" from group ${groupId}`);
        await ctx.reply(`Filter "${input}" removed from Group ${groupId}.`);
      } else {
        console.log(`[ADMIN_TEXT] Pattern not found: "${input}"`);
        await ctx.reply(`Pattern "${input}" not found in Group ${groupId}.`);
      }
    }

    session.action = undefined;
    adminSessions.set(adminId, session);
    await showMainMenu(ctx);
    return;
  }

  if (!input.startsWith('/')) {
    console.log(`[ADMIN_TEXT] Non-command text - showing main menu`);
    await showMainMenu(ctx);
  }
});

// Callback handler for inline buttons in admin menu
bot.on('callback_query', async (ctx) => {
  if (ctx.chat?.type !== 'private' || !(await isAuthorized(ctx))) {
    return ctx.answerCbQuery('Not authorized.');
  }

  console.log(`[CALLBACK] Admin ${ctx.from.id} pressed: ${ctx.callbackQuery.data}`);
  
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
      console.log(`[CALLBACK] Admin ${adminId} selected group: ${groupId}`);
      await ctx.answerCbQuery(`Selected Group: ${groupId}`);
      await showMainMenu(ctx);
      return;
    }
  }

  const groupId = session.selectedGroupId;
  if (!groupId && !data.includes('menu_back')) {
    console.log(`[CALLBACK] No group selected for callback: ${data}`);
    await ctx.answerCbQuery('No group selected');
    await showMainMenu(ctx);
    return;
  }

  if (data === 'menu_addFilter') {
    console.log(`[CALLBACK] Admin ${adminId} wants to add filter for group ${groupId}`);
    await promptForPattern(ctx, 'Add Filter');
  } else if (data === 'menu_removeFilter') {
    console.log(`[CALLBACK] Admin ${adminId} wants to remove filter from group ${groupId}`);
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
    console.log(`[CALLBACK] Admin ${adminId} listing filters for group ${groupId}`);
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
    console.log(`[CALLBACK] Admin ${adminId} toggled action for group ${groupId}: ${currentAction} -> ${newAction}`);
    await showMainMenu(ctx);
    await ctx.answerCbQuery(`Action now: ${newAction.toUpperCase()} for Group ${groupId}`);
  } else if (data === 'menu_patternHelp') {
    console.log(`[CALLBACK] Admin ${adminId} requested pattern help`);
    const helpText = 
      `✨ <b>Pattern Types Guide</b> ✨\n\n` +
      
      `<b>🔤 Simple Text</b>\n` +
      `Case-insensitive match\n` +
      `Example: <code>spam</code>\n` +
      `Matches: "SPAM", "Spam", "spam123", etc.\n\n` +
      
      `<b>⭐ Wildcards</b>\n` +
      `• <code>*</code> = zero or more characters\n` +
      `• <code>?</code> = exactly one character\n\n` +
      `Examples:\n` +
      `• <code>spam*</code> → "spam", "spammer", "spam123"\n` +
      `• <code>*bot</code> → "mybot", "testbot", "123bot"\n` +
      `• <code>*bad*</code> → "baduser", "this_is_bad"\n` +
      `• <code>test?</code> → "test1", "testa", "tests"\n\n` +
      
      `<b>🔧 Regular Expressions</b>\n` +
      `Format: <code>/pattern/flags</code>\n\n` +
      `Useful flags:\n` +
      `• <code>i</code> = case-insensitive\n` +
      `• <code>g</code> = global match\n\n` +
      `Examples:\n` +
      `• <code>/^spam/i</code> → starts with "spam"\n` +
      `• <code>/user$/i</code> → ends with "user"\n` +
      `• <code>/\\d{5,}/</code> → 5+ digits\n` +
      `• <code>/ch[!1i]ld/i</code> → "child", "ch!ld", "ch1ld"\n` +
      `• <code>/❤.*p.rn/i</code> → heart + porn variations\n\n` +
      
      `<b>💡 Tips:</b>\n` +
      `• Test patterns with /testpattern\n` +
      `• Start simple, then get complex\n` +
      `• Patterns are checked against usernames AND display names`;

    await ctx.editMessageText(helpText, {
      parse_mode: 'HTML',
      reply_markup: { 
        inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]] 
      }
    });
  } else if (data === 'menu_back') {
    console.log(`[CALLBACK] Admin ${adminId} returning to main menu`);
    await showMainMenu(ctx);
  }
});

// Direct command handlers for /addFilter, /removeFilter, /listFilters
bot.command('addFilter', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;

  console.log(`[COMMAND] /addFilter from admin ${ctx.from.id}: "${ctx.message.text}"`);
  
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const groupId = session.selectedGroupId;

  if (!groupId) {
    console.log(`[COMMAND] No group selected for addFilter`);
    return ctx.reply('No group selected. Use /menu to select a group first.');
  }

  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    console.log(`[COMMAND] addFilter usage help requested`);
    return ctx.reply(
      `<b>Usage: /addFilter &lt;pattern&gt;</b>\n\n` +
      
      `<b>Examples:</b>\n` +
      `<code>/addFilter spam</code>\n` +
      `<code>/addFilter *bitcoin*</code>\n` +
      `<code>/addFilter /^evil.*user$/i</code>\n\n` +
      
      `Current Group: ${groupId}\n` +
      `Use /menu for more help and examples.`,
      { parse_mode: 'HTML' }
    );
  }

  const pattern = parts.slice(1).join(' ').trim();
  
  try {
    // Use security module to validate and create pattern
    const patternObj = createPatternObject(pattern);
    
    let patterns = groupPatterns.get(groupId) || [];
    
    // Check for duplicates
    if (patterns.some(p => p.raw === patternObj.raw)) {
      console.log(`[COMMAND] Pattern already exists: "${patternObj.raw}"`);
      return ctx.reply(`Pattern "${patternObj.raw}" already exists.`);
    }
    
    // Check pattern limit
    if (patterns.length >= 100) {
      console.log(`[COMMAND] Maximum patterns reached for group ${groupId}`);
      return ctx.reply(`Maximum patterns reached (100 per group).`);
    }
    
    // Add the pattern
    patterns.push(patternObj);
    groupPatterns.set(groupId, patterns);
    
    // Save to file
    await saveGroupPatterns(groupId, patterns);
    
    console.log(`[COMMAND] ✅ Added pattern "${patternObj.raw}" to group ${groupId}`);
    return ctx.reply(`✅ Added filter: "${patternObj.raw}"`);
  } catch (error) {
    console.error(`[COMMAND] addFilter error:`, error);
    return ctx.reply(`❌ Error: ${error.message}`);
  }
});

bot.command('removeFilter', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;

  console.log(`[COMMAND] /removeFilter from admin ${ctx.from.id}: "${ctx.message.text}"`);
  
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const groupId = session.selectedGroupId;

  if (!groupId) {
    console.log(`[COMMAND] No group selected for removeFilter`);
    return ctx.reply('No group selected. Use /menu to select a group first.');
  }

  let patterns = groupPatterns.get(groupId) || [];

  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    if (patterns.length === 0) {
      console.log(`[COMMAND] No patterns to remove for group ${groupId}`);
      return ctx.reply(`No patterns exist to remove for Group ${groupId}.`);
    }
    console.log(`[COMMAND] removeFilter usage help requested`);
    const patternsList = patterns.map(p => `- ${p.raw}`).join('\n');
    return ctx.reply(`Usage: /removeFilter <pattern>\nCurrent patterns for Group ${groupId}:\n${patternsList}`);
  }

  const pattern = parts.slice(1).join(' ').trim();
  const index = patterns.findIndex(p => p.raw === pattern);

  if (index !== -1) {
    patterns.splice(index, 1);
    groupPatterns.set(groupId, patterns);
    await saveGroupPatterns(groupId, patterns);
    console.log(`[COMMAND] ✅ Removed pattern "${pattern}" from group ${groupId}`);
    return ctx.reply(`Filter removed: "${pattern}" from Group ${groupId}`);
  } else {
    console.log(`[COMMAND] Pattern not found: "${pattern}" in group ${groupId}`);
    return ctx.reply(`Filter "${pattern}" not found in Group ${groupId}.`);
  }
});

bot.command('listFilters', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;

  console.log(`[COMMAND] /listFilters from admin ${ctx.from.id}`);
  
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const groupId = session.selectedGroupId;

  if (!groupId) {
    console.log(`[COMMAND] No group selected for listFilters`);
    return ctx.reply('No group selected. Use /menu to select a group first.');
  }

  const patterns = groupPatterns.get(groupId) || [];

  if (patterns.length === 0) {
    console.log(`[COMMAND] No patterns for group ${groupId}`);
    return ctx.reply(`No filter patterns are currently set for Group ${groupId}.`);
  }

  console.log(`[COMMAND] Listing ${patterns.length} patterns for group ${groupId}`);
  const list = patterns.map(p => `- ${p.raw}`).join('\n');
  return ctx.reply(`Current filter patterns for Group ${groupId}:\n${list}`);
});

// Chat info command
bot.command('chatinfo', async (ctx) => {
  console.log(`[COMMAND] /chatinfo from user ${ctx.from.id} in chat ${ctx.chat.id}`);
  
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
    console.log(`[COMMAND] Sent chatinfo for ${chatId}`);
  } catch (error) {
    console.error(`[COMMAND] Failed to send chatinfo:`, error);
  }
});

// Set action command
bot.command('setaction', async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  
  console.log(`[COMMAND] /setaction from user ${ctx.from.id}: "${ctx.message.text}"`);
  
  const args = ctx.message.text.split(' ');
  
  // If in group, check if user is admin of that group
  if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
    console.log(`[COMMAND] setaction in group ${ctx.chat.id}`);
    
    if (!WHITELISTED_GROUP_IDS.includes(ctx.chat.id)) {
      console.log(`[COMMAND] Group ${ctx.chat.id} not whitelisted`);
      return ctx.reply('This command only works in whitelisted groups.');
    }
    
    // Check if user is admin of this specific group
    try {
      const user = await ctx.getChatMember(ctx.from.id);
      if (user.status !== 'administrator' && user.status !== 'creator' && !WHITELISTED_USER_IDS.includes(ctx.from.id)) {
        console.log(`[COMMAND] User ${ctx.from.id} not admin in group ${ctx.chat.id}`);
        return ctx.reply('You must be a group admin to change this setting.');
      }
    } catch (e) {
      console.error(`[COMMAND] Error checking admin status:`, e);
      return ctx.reply('Error checking admin status.');
    }
    
    const groupId = ctx.chat.id;
    const currentAction = getGroupAction(groupId);
    
    if (args.length < 2) {
      console.log(`[COMMAND] setaction usage help for group ${groupId}`);
      return ctx.reply(`Current action for this group: ${currentAction.toUpperCase()}\nUsage: /setaction <ban|kick>`);
    }
    
    const action = args[1].toLowerCase();
    if (action !== 'ban' && action !== 'kick') {
      console.log(`[COMMAND] Invalid action: ${action}`);
      return ctx.reply('Invalid action. Use "ban" or "kick".');
    }
    
    settings.groupActions[groupId] = action;
    const success = await saveSettings();
    if (success) {
      console.log(`[COMMAND] ✅ Action updated for group ${groupId}: ${action.toUpperCase()}`);
      return ctx.reply(`Action updated to: ${action.toUpperCase()} for this group`);
    } else {
      console.log(`[COMMAND] ❌ Failed to save settings for group ${groupId}`);
      return ctx.reply('Failed to save settings. Check logs for details.');
    }
  } 
  
  // If in private chat, use selected group from session
  else {
    console.log(`[COMMAND] setaction in private chat`);
    const adminId = ctx.from.id;
    let session = adminSessions.get(adminId) || {};
    const groupId = session.selectedGroupId;
    
    if (!groupId) {
      console.log(`[COMMAND] No group selected for private setaction`);
      return ctx.reply('No group selected. Use /menu to select a group first.');
    }
    
    const currentAction = getGroupAction(groupId);
    
    if (args.length < 2) {
      console.log(`[COMMAND] setaction usage help for group ${groupId}`);
      return ctx.reply(`Current action for Group ${groupId}: ${currentAction.toUpperCase()}\nUsage: /setaction <ban|kick>`);
    }
    
    const action = args[1].toLowerCase();
    if (action !== 'ban' && action !== 'kick') {
      console.log(`[COMMAND] Invalid action: ${action}`);
      return ctx.reply('Invalid action. Use "ban" or "kick".');
    }
    
    settings.groupActions[groupId] = action;
    const success = await saveSettings();
    if (success) {
      console.log(`[COMMAND] ✅ Action updated for group ${groupId}: ${action.toUpperCase()}`);
      return ctx.reply(`Action updated to: ${action.toUpperCase()} for Group ${groupId}`);
    } else {
      console.log(`[COMMAND] ❌ Failed to save settings for group ${groupId}`);
      return ctx.reply('Failed to save settings. Check logs for details.');
    }
  }
});

// Test pattern command using security functions
bot.command('testpattern', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;
  
  console.log(`[COMMAND] /testpattern from admin ${ctx.from.id}: "${ctx.message.text}"`);
  
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    console.log(`[COMMAND] testpattern usage help requested`);
    return ctx.reply('Usage: /testpattern <pattern> <test-string>');
  }
  
  const pattern = parts[1];
  const testString = parts.slice(2).join(' ');
  
  try {
    // Use security module to test the pattern
    const result = await matchesPattern(pattern, testString);
    console.log(`[COMMAND] Pattern test: "${pattern}" ${result ? 'matches' : 'does not match'} "${testString}"`);
    return ctx.reply(`Pattern "${pattern}" ${result ? 'matches' : 'does not match'} "${testString}"`);
  } catch (err) {
    console.error(`[COMMAND] testpattern error:`, err);
    return ctx.reply(`Error testing pattern: ${err.message}`);
  }
});

// Command to show menu directly
bot.command('menu', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) {
    console.log(`[COMMAND] /menu denied for user ${ctx.from.id}`);
    return ctx.reply('You are not authorized to configure the bot.');
  }
  
  console.log(`[COMMAND] /menu from admin ${ctx.from.id}`);
  await showMainMenu(ctx);
});

// Help and Start commands
bot.command('help', async (ctx) => {
  if (ctx.chat.type !== 'private' || !(await isAuthorized(ctx))) return;

  console.log(`[COMMAND] /help from admin ${ctx.from.id}`);
  
  const helpText = 
    `Telegram Ban Bot Help\n\n` +
    `Admin Commands:\n` +
    `• /menu - Open the interactive configuration menu\n` +
    `• /addFilter <pattern> - Add a filter pattern\n` +
    `• /removeFilter <pattern> - Remove a filter pattern\n` +
    `• /listFilters - List all filter patterns\n` +
    `• /setaction <ban|kick> - Set action for matches\n` +
    `• /chatinfo - Show information about current chat\n` +
    `• /testpattern <pattern> <string> - Test a pattern\n` +
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
    console.log(`[COMMAND] /start denied for user ${ctx.from.id}`);
    return ctx.reply('You are not authorized to configure this bot.');
  }

  console.log(`[COMMAND] /start from admin ${ctx.from.id}`);
  
  const welcomeText = 
    `🛡️ <b>Welcome to the Telegram Ban Bot!</b>\n\n` +
    
    `This bot helps protect your groups by automatically removing users whose names match specific patterns.\n\n` +
    
    `<b>Quick Start:</b>\n` +
    `1. Use /menu to configure patterns\n` +
    `2. Select your group\n` +
    `3. Add patterns (text, wildcards, or regex)\n` +
    `4. Choose ban or kick action\n\n` +
    
    `<b>Pattern Examples:</b>\n` +
    `• <code>spam</code> - blocks exact text\n` +
    `• <code>*bot*</code> - blocks anything with "bot"\n` +
    `• <code>/^evil/i</code> - blocks names starting with "evil"\n\n` +
    
    `Ready to get started?`;

  await ctx.reply(welcomeText, { parse_mode: 'HTML' });
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
  
  console.log(`[UPDATE] [${now}] type=${updateType}, chat=${chatId} (${chatType}), from=${fromId} (@${username})`);

  if (ctx.message?.new_chat_members) {
    const newUsers = ctx.message.new_chat_members;
    console.log(`[UPDATE] New users: ${newUsers.map(u => `${u.id} (@${u.username || 'no_username'})`).join(', ')}`);
  }

  if (ctx.updateType === 'message' && ctx.message?.text) {
    console.log(`[UPDATE] Message: "${ctx.message.text.substring(0, 50)}${ctx.message.text.length > 50 ? '...' : ''}"`);
  }

  return next();
});

bot.use(async (ctx, next) => {
  if (ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup') {
    if (WHITELISTED_GROUP_IDS.includes(ctx.chat.id)) {
      try {
        const userId = ctx.from?.id;
        if (userId && !WHITELISTED_USER_IDS.includes(userId) && !knownGroupAdmins.has(userId)) {
          console.log(`[MIDDLEWARE] Checking admin status for user ${userId} in background`);
          checkAndCacheGroupAdmin(userId, bot).catch(err => {
            console.error(`[MIDDLEWARE] Error checking admin status: ${err.message}`);
          });
        }
      } catch (error) {
        console.error(`[MIDDLEWARE] Error in admin cache middleware: ${error.message}`);
      }
    }
  }
  return next();
});

// New users handler
bot.on('new_chat_members', async (ctx) => {
  console.log(`[EVENT] New chat members event in chat ${ctx.chat.id}`);
  
  if (!isChatAllowed(ctx)) {
    console.log(`[EVENT] Group ${ctx.chat.id} not allowed - skipping`);
    return;
  }

  const chatId = ctx.chat.id;
  const newUsers = ctx.message.new_chat_members;
  console.log(`[EVENT] Processing ${newUsers.length} new users in chat ${chatId}`);

  for (const user of newUsers) {
    const username = user.username;
    const firstName = user.first_name;
    const lastName = user.last_name;
    const displayName = [firstName, lastName].filter(Boolean).join(' ');
    console.log(`[EVENT] Checking new user: ${user.id} (@${username || 'no_username'}) Name: ${displayName}`);

    if (await isBanned(username, firstName, lastName, chatId)) {
      console.log(`[EVENT] 🚫 New user ${user.id} is banned - taking action`);
      await takePunishmentAction(ctx, user.id, displayName || username || user.id, chatId);
    } else {
      console.log(`[EVENT] New user ${user.id} passed initial check - starting monitoring`);
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

  console.log(`[MESSAGE] User ${ctx.from.id} (@${username || 'no_username'}) sending message in chat ${chatId}`);

  if (await isBanned(username, firstName, lastName, chatId)) {
    console.log(`[MESSAGE] 🚫 User ${ctx.from.id} is banned - taking action`);
    await takePunishmentAction(ctx, ctx.from.id, displayName || username || ctx.from.id, chatId);
  } else {
    console.log(`[MESSAGE] User ${ctx.from.id} passed check - allowing message`);
    return next();
  }
});

// Startup and cleanup
async function startup() {
  console.log(`[STARTUP] Starting bot initialization...`);
  
  await ensureBannedPatternsDirectory();
  await loadSettings();
  await loadAllGroupPatterns();

  // Ensure all whitelisted groups have an action setting
  WHITELISTED_GROUP_IDS.forEach(groupId => {
    if (!settings.groupActions[groupId]) {
      settings.groupActions[groupId] = DEFAULT_ACTION;
      console.log(`[STARTUP] Set default action for group ${groupId}: ${DEFAULT_ACTION}`);
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
    console.log(`✅ Security module active`);
    console.log(`✅ Pattern validation enabled`);
    console.log(`✅ Regex timeout protection enabled`);
    console.log(`✅ Comprehensive logging enabled`);
    console.log('Bot is running. Press Ctrl+C to stop.');
    console.log('==============================\n');
  })
  .catch(err => {
    console.error(`[STARTUP] Bot launch error:`, err);
    process.exit(1);
  });
}

const cleanup = (signal) => {
  console.log(`\n[CLEANUP] Received ${signal}. Shutting down gracefully...`);
  Object.values(newJoinMonitors).forEach(interval => clearInterval(interval));
  bot.stop(signal);
  setTimeout(() => {
    console.log('[CLEANUP] Forcing exit...');
    process.exit(0);
  }, 1000);
};

process.once('SIGINT', () => cleanup('SIGINT'));
process.once('SIGTERM', () => cleanup('SIGTERM'));
process.once('SIGUSR2', () => cleanup('SIGUSR2'));

// Start the bot
console.log(`[INIT] Starting Telegram Ban Bot...`);
startup();