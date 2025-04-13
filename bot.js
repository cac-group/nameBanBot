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
      continue;
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
      const isGroupAdmin = user.status === 'administrator' || user.status === 'creator';
      
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

function patternToRegex(patternStr) {
  if (patternStr.startsWith('/') && patternStr.endsWith('/') && patternStr.length > 2) {
    const inner = patternStr.slice(1, -1);
    return new RegExp(inner, 'i');
  }
  
  if (!patternStr.includes('*') && !patternStr.includes('?')) {
    return new RegExp(patternStr, 'i');
  }
  
  const escaped = patternStr.replace(/[-\\/^$+?.()|[\]{}]/g, '\\$&');
  const wildcardRegex = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(wildcardRegex, 'i');
}

function isBanned(username) {
  return bannedPatterns.some(({ regex }) => regex.test(username));
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
    // Validate the action setting
    if (settings.action !== 'ban' && settings.action !== 'kick') {
      settings.action = DEFAULT_ACTION;
    }
    console.log(`Loaded settings: action=${settings.action}`);
  } catch (err) {
    console.log(`No settings file found or error reading. Using defaults: action=${settings.action}`);
    // Create the settings file if it doesn't exist
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

// Action handlers
async function takePunishmentAction(ctx, userId, username, chatId) {
  const isBan = settings.action === 'ban';
  try {
    if (isBan) {
      // Ban the user permanently
      await ctx.banChatMember(userId);
    } else {
      // Kick the user (they can rejoin)
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

// User monitoring
function monitorNewUser(chatId, user) {
  const key = `${chatId}_${user.id}`;
  console.log(`Started monitoring new user: ${user.id} in chat ${chatId}`);
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    try {
      const chatMember = await bot.telegram.getChatMember(chatId, user.id);
      const username = chatMember.user.username?.toLowerCase();
      if (username && isBanned(username)) {
        const isBan = settings.action === 'ban';
        if (isBan) {
          await bot.telegram.banChatMember(chatId, user.id);
        } else {
          await bot.telegram.banChatMember(chatId, user.id, { until_date: Math.floor(Date.now() / 1000) + 35 });
        }
        
        const message = getRandomMessage(user.id, isBan);
        await bot.telegram.sendMessage(chatId, message);
        
        console.log(`${isBan ? 'Banned' : 'Kicked'} user after name change: @${username} in chat ${chatId}`);
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

// Helper to show main menu
async function showMainMenu(ctx) {
  const text = "Filter Management Menu\n\nChoose an action from the buttons below:";
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Add Filter', callback_data: 'menu_addFilter' }],
        [{ text: 'Remove Filter', callback_data: 'menu_removeFilter' }],
        [{ text: 'List Filters', callback_data: 'menu_listFilters' }],
        [{ text: `Action: ${settings.action === 'ban' ? 'BAN' : 'KICK'}`, callback_data: 'menu_toggleAction' }]
      ]
    }
  };
  return await ctx.reply(text, keyboard);
}

// Menu Helpers
async function sendPersistentExplainer(ctx) {
  if (ctx.chat.type !== 'private') return;
  
  try {
    const htmlLines = [
      "Welcome to the Filter Configuration!",
      "",
      "You can use the menu below or direct commands to manage banned username filters.",
      "Filters can be plain text, include wildcards (* and ?) or be defined as a /regex/ literal.",
      "",
      "Examples:",
      "- <code>spam</code> matches any username containing 'spam'",
      "- <code>*bad*</code> matches any username containing 'bad'",
      "- <code>/^bad.*user$/i</code> matches usernames starting with 'bad' and ending with 'user'",
      "",
      `Current action for matched usernames: <b>${settings.action.toUpperCase()}</b>`
    ];
    
    await ctx.reply(htmlLines.join('\n'), { 
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error("Failed to send explainer message:", error);
    try {
      await ctx.reply("Welcome to the Filter Configuration! Use the menu below to manage username filters.");
    } catch (err) {
      console.error("Failed to send simplified explainer:", err);
    }
  }
}

async function showOrEditMenu(ctx, text, extra) {
  if (ctx.chat.type !== 'private') return;
  
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  try {
    if (session.menuMessageId) {
      await ctx.telegram.editMessageText(
        session.chatId,
        session.menuMessageId,
        null,
        text,
        extra
      );
    } else {
      const sent = await ctx.reply(text, extra);
      session.menuMessageId = sent.message_id;
      session.chatId = ctx.chat.id;
    }
  } catch (err) {
    console.error("Error showing/editing menu:", err);
    const sent = await ctx.reply(text, extra);
    session.menuMessageId = sent.message_id;
    session.chatId = ctx.chat.id;
  }
  adminSessions.set(adminId, session);
}

async function deleteMenu(ctx, confirmationMessage) {
  if (ctx.chat.type !== 'private') return;
  
  const adminId = ctx.from.id;
  const session = adminSessions.get(adminId);
  if (session && session.menuMessageId) {
    try {
      await ctx.telegram.deleteMessage(session.chatId, session.menuMessageId);
    } catch (e) {
      console.error("Failed to delete menu message:", e);
    }
    session.menuMessageId = null;
    adminSessions.set(adminId, session);
  }
  if (confirmationMessage) {
    await ctx.reply(confirmationMessage);
  }
}

async function promptForPattern(ctx, actionLabel) {
  if (ctx.chat.type !== 'private') return;
  
  const text =
    `Please enter the pattern to ${actionLabel}.\n\n` +
    "You can use wildcards (* and ?), or /regex/ syntax.\n\n" +
    "Send `/cancel` to abort.";
  
  let session = adminSessions.get(ctx.from.id) || {};
  session.action = actionLabel;
  adminSessions.set(ctx.from.id, session);
  await showOrEditMenu(ctx, text, {});
}

// Debug middleware
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

// Admin cache middleware
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
    const username = user.username?.toLowerCase();
    console.log(`Checking user: ${user.id} (@${username || 'no_username'})`);
    
    if (username && isBanned(username)) {
      await takePunishmentAction(ctx, user.id, username, chatId);
    } else {
      monitorNewUser(chatId, user);
    }
  }
});

// Message handler for banning
bot.on('message', async (ctx, next) => {
  if (!isChatAllowed(ctx)) return next();
  
  const username = ctx.from?.username?.toLowerCase();
  if (username) {
    console.log(`Processing message from: @${username}`);
    if (isBanned(username)) {
      await takePunishmentAction(ctx, ctx.from.id, username, ctx.chat.id);
    } else {
      return next();
    }
  } else {
    console.log('Message from user without username');
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
  
  let reply = `Chat: "${chatTitle}"\n`;
  reply += `ID: ${chatId}\n`;
  reply += `Type: ${chatType}\n`;
  reply += `Bot can operate here: ${isAllowed ? 'Yes' : 'No'}\n`;
  reply += `You can configure bot: ${isAuth ? 'Yes' : 'No'}\n`;
  reply += `Current action: ${settings.action.toUpperCase()}\n\n`;
  
  if (chatType === 'group' || chatType === 'supergroup') {
    reply += `Whitelisted group IDs: ${WHITELISTED_GROUP_IDS.join(', ')}\n`;
    const match = WHITELISTED_GROUP_IDS.includes(chatId);
    reply += `ID match: ${match ? 'Yes' : 'No'}\n`;
    
    if (!match) {
      reply += `\nThis group's ID is not in the whitelist!`;
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
    return ctx.reply(`Current action: ${settings.action.toUpperCase()}\n\nUsage: /setaction <ban|kick>`);
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
  if (ctx.chat.type !== 'private') return;
  if (!(await isAuthorized(ctx))) {
    return ctx.reply('You are not authorized to configure the bot.');
  }
  
  await showMainMenu(ctx);
});

// Help command
bot.command('help', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!(await isAuthorized(ctx))) return;
  
  await sendPersistentExplainer(ctx);
  await showMainMenu(ctx);
});

// Start command
bot.command('start', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!(await isAuthorized(ctx))) {
    return ctx.reply('You are not authorized to configure this bot.');
  }
  
  await sendPersistentExplainer(ctx);
  await showMainMenu(ctx);
});

// Process any text message in private chat (for admin menu)
bot.on('text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (!(await isAuthorized(ctx))) return next();
  
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const input = ctx.message.text.trim();

  // Handle cancel command
  if (input.toLowerCase() === '/cancel') {
    if (session.action) {
      session.action = undefined;
      adminSessions.set(adminId, session);
      await deleteMenu(ctx, "Action cancelled.");
      await showMainMenu(ctx);
    } else {
      await ctx.reply("No action in progress to cancel.");
    }
    return;
  }

  // Handle pattern input if an action is active
  if (session.action) {
    if (session.action === 'Add Filter') {
      try {
        const regex = patternToRegex(input);
        if (bannedPatterns.some(p => p.raw === input)) {
          await ctx.reply(`Pattern "${input}" is already in the filter list.`);
        } else {
          bannedPatterns.push({ raw: input, regex });
          await saveBannedPatterns();
          await ctx.reply(`Filter added: "${input}"`);
        }
      } catch (error) {
        await ctx.reply('Invalid pattern. Please try again.');
      }
    } else if (session.action === 'Remove Filter') {
      const index = bannedPatterns.findIndex(p => p.raw === input);
      if (index !== -1) {
        bannedPatterns.splice(index, 1);
        await saveBannedPatterns();
        await ctx.reply(`Filter removed: "${input}"`);
      } else {
        await ctx.reply(`Filter "${input}" not found.`);
      }
    }
    
    // Clear action and show menu again
    session.action = undefined;
    adminSessions.set(adminId, session);
    await showMainMenu(ctx);
    return;
  }
  
  // If no action and not a command, show the menu
  if (!input.startsWith('/')) {
    await showMainMenu(ctx);
  }
});

// Callback query handler
bot.on('callback_query', async (ctx) => {
  if (ctx.chat?.type !== 'private') {
    return ctx.answerCbQuery('This action is only available in private chat.');
  }
  
  if (!(await isAuthorized(ctx))) {
    return ctx.answerCbQuery('Not authorized.');
  }
  
  const data = ctx.callbackQuery.data;
  
  // Always acknowledge the callback to remove loading indicator
  await ctx.answerCbQuery();
  
  if (data === 'menu_addFilter') {
    const text = "Please enter the pattern to add.\n\nExamples:\n- <code>spam</code> (matches any username containing 'spam')\n- <code>*bad*</code> (wildcards: matches usernames with 'bad')\n- <code>/^evil.*$/i</code> (regex: matches usernames starting with 'evil')";
    
    let session = adminSessions.get(ctx.from.id) || {};
    session.action = 'Add Filter';
    adminSessions.set(ctx.from.id, session);
    
    await ctx.editMessageText(text, { parse_mode: 'HTML' });
  } else if (data === 'menu_removeFilter') {
    // If no patterns exist, just say so
    if (bannedPatterns.length === 0) {
      await ctx.editMessageText("No filter patterns exist to remove. Use 'Add Filter' to create patterns first.");
      return;
    }
    
    const text = "Please enter the pattern to remove.\n\nCurrent patterns:\n" + 
                 bannedPatterns.map(p => `- <code>${p.raw}</code>`).join('\n');
    
    let session = adminSessions.get(ctx.from.id) || {};
    session.action = 'Remove Filter';
    adminSessions.set(ctx.from.id, session);
    
    await ctx.editMessageText(text, { parse_mode: 'HTML' });
  } else if (data === 'menu_listFilters') {
    if (bannedPatterns.length === 0) {
      await ctx.editMessageText("No filter patterns are currently set.", {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Back to Menu', callback_data: 'menu_back' }]
          ]
        }
      });
    } else {
      const list = bannedPatterns.map(p => `- <code>${p.raw}</code>`).join('\n');
      await ctx.editMessageText(`Current filter patterns:\n${list}`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Back to Menu', callback_data: 'menu_back' }]
          ]
        }
      });
    }
  } else if (data === 'menu_toggleAction') {
    // Toggle between ban and kick
    settings.action = settings.action === 'ban' ? 'kick' : 'ban';
    await saveSettings();
    
    // Update menu to show new action
    await showMainMenu(ctx);
    
    // Show a confirmation message
    await ctx.answerCbQuery(`Action changed to: ${settings.action.toUpperCase()}`);
  } else if (data === 'menu_back') {
    // Go back to main menu
    await showMainMenu(ctx);
  }
});

// Direct command handlers
bot.command('addFilter', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (!(await isAuthorized(ctx))) return;
  
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('Usage: /addFilter <pattern>\n\nExamples:\n- /addFilter spam\n- /addFilter *bad*\n- /addFilter /^evil.*$/i');
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
  if (ctx.chat.type !== 'private') return;
  if (!(await isAuthorized(ctx))) return;
  
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    if (bannedPatterns.length === 0) {
      return ctx.reply('No patterns exist to remove.');
    }
    
    const patterns = bannedPatterns.map(p => `- ${p.raw}`).join('\n');
    return ctx.reply(`Usage: /removeFilter <pattern>\n\nCurrent patterns:\n${patterns}`);
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
  if (ctx.chat.type !== 'private') return;
  if (!(await isAuthorized(ctx))) return;
  
  if (bannedPatterns.length === 0) {
    return ctx.reply('No filter patterns are currently set.');
  }
  
  const list = bannedPatterns.map(p => `- ${p.raw}`).join('\n');
  return ctx.reply(`Current filter patterns:\n${list}`);
});

// Graceful shutdown
const cleanup = (signal) => {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  
  Object.values(newJoinMonitors).forEach(interval => {
    clearInterval(interval);
  });
  
  bot.stop(signal);
  
  setTimeout(() => {
    console.log('Forcing exit...');
    process.exit(0);
  }, 1000);
};

process.once('SIGINT', () => cleanup('SIGINT'));
process.once('SIGTERM', () => cleanup('SIGTERM'));
process.once('SIGUSR2', () => cleanup('SIGUSR2'));

// Start the bot
async function startBot() {
  // Load settings first
  await loadSettings();
  
  // Then load patterns
  await loadBannedPatterns();
  
  const launchOptions = {
    allowedUpdates: ['message', 'callback_query', 'chat_member', 'my_chat_member'],
    timeout: 30
  };
  
  bot.launch(launchOptions)
    .then(() => {
      console.log('\n==============================');
      console.log('Ban Bot Started Successfully!');
      console.log('==============================');
      
      console.log('Configuration:');
      console.log(`Bot Token: ${BOT_TOKEN ? '✓ Set' : '✗ Not set'}`);
      console.log(`Banned Patterns File: ${BANNED_PATTERNS_FILE}`);
      console.log(`Whitelisted User IDs (${WHITELISTED_USER_IDS.length}): ${WHITELISTED_USER_IDS.join(', ')}`);
      console.log(`Whitelisted Group IDs (${WHITELISTED_GROUP_IDS.length}): ${WHITELISTED_GROUP_IDS.join(', ')}`);
      console.log(`Loaded ${bannedPatterns.length} banned patterns`);
      console.log(`Current action: ${settings.action.toUpperCase()}`);
      console.log('==============================');
      
      console.log('Bot is running. Press Ctrl+C to stop.');
    })
    .catch(err => console.error('Bot launch error:', err));
}

startBot();
