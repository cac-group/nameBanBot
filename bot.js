// bot.mjs

import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import toml from 'toml';
import {
  BOT_TOKEN,
  BANNED_PATTERNS_FILE,
  WHITELISTED_USER_IDS,
  WHITELISTED_GROUP_IDS
} from './config.js';

dotenv.config(); // Load env variables

// In-memory Data

/**
 * Each banned pattern is stored as:
 *   { raw: string, regex: RegExp }
 */
let bannedPatterns = [];

/**
 * Store each admin’s session in a Map keyed by their Telegram user ID.  
 * Session object fields:
 *   - chatId: the private chat or group chat id
 *   - menuMessageId: the message ID of the interactive prompt/inline menu
 *   - action: pending action name (e.g. "Add Filter", "Remove Filter")
 *   - explainerSent: boolean indicating the instructional message was sent
 */
const adminSessions = new Map();

/**
 * For monitoring new chat members (keyed by "<chatId>_<userId>")
 */
const newJoinMonitors = {};

// Utility Functions

/**
 * Returns true if the current chat is allowed for the bot.
 * For groups, only those in the whitelist will be allowed.
 */
function isChatAllowed(ctx) {
  const chatType = ctx.chat?.type;
  if (chatType === 'group' || chatType === 'supergroup') {
    return WHITELISTED_GROUP_IDS.includes(ctx.chat.id);
  }
  // For private chats, allow by default.
  return true;
}

/**
 * Returns true if the sender is authorized to configure the bot.
 * In private chats: the sender must have an explicit user id listed.
 * In group chats: the group must be whitelisted, and the sender must be a group admin,
 * or their user id is explicitly whitelisted.
 */
async function isAuthorized(ctx) {
  if (!isChatAllowed(ctx)) return false;
  const chatType = ctx.chat.type;
  if (chatType === 'private') {
    return WHITELISTED_USER_IDS.includes(ctx.from.id);
  } else if (chatType === 'group' || chatType === 'supergroup') {
    try {
      const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
      const isGroupAdmin =
        member.status === 'administrator' || member.status === 'creator';
      return isGroupAdmin || WHITELISTED_USER_IDS.includes(ctx.from.id);
    } catch (e) {
      console.error('Error checking group membership:', e);
      return false;
    }
  }
  return false;
}

/**
 * Converts a user-provided pattern into a RegExp.
 * Patterns may be:
 *   - Plain text (substring match, case-insensitive),
 *   - With wildcards: '*' matches any sequence and '?' matches a single character,
 *   - A /regex/ literal (if wrapped in forward slashes).
 */
function patternToRegex(patternStr) {
  if (
    patternStr.startsWith('/') &&
    patternStr.endsWith('/') &&
    patternStr.length > 2
  ) {
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

/**
 * Returns true if the given username matches any banned pattern.
 */
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
  } catch (err) {
    console.error(
      `Error reading ${BANNED_PATTERNS_FILE}. Starting with an empty list.`,
      err
    );
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

// Newly Joined Monitoring

function monitorNewMember(chatId, member) {
  const key = `${chatId}_${member.id}`;
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    try {
      const chatMember = await bot.telegram.getChatMember(chatId, member.id);
      const username = chatMember.user.username?.toLowerCase();
      if (username && isBanned(username)) {
        await bot.telegram.banChatMember(chatId, member.id);
        console.log(`Banned user after name change: @${username} in chat ${chatId}`);
        clearInterval(interval);
        delete newJoinMonitors[key];
        return;
      }
      if (attempts >= 6) {
        clearInterval(interval);
        delete newJoinMonitors[key];
      }
    } catch {
      clearInterval(interval);
      delete newJoinMonitors[key];
    }
  }, 5000);
  newJoinMonitors[key] = interval;
}

// Menu Helpers

/**
 * Sends a persistent instructional message to the admin.
 * This message is sent once per session and is never edited or deleted.
 */
async function sendPersistentExplainer(ctx) {
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || {};
  if (!session.explainerSent) {
    const textLines = [
      "Welcome to the Filter Configuration!",
      "",
      "Use the interactive menu or direct commands to manage banned username filters.",
      "Filters can be plain text, include wildcards (* and ?), or be defined as a /regex/ literal (e.g., `/^bad.*user$/i`).",
      "",
      "**Direct Commands:**",
      "• `/addFilter <pattern>` — Add a filter",
      "• `/removeFilter <pattern>` — Remove a filter",
      "• `/listFilters` — List all filters",
      "",
      "A single interactive menu message will help you perform actions without clutter. When no further input is required, the menu is deleted."
    ];
    await ctx.reply(textLines.join('\n'), { parse_mode: 'Markdown' });
    session.explainerSent = true;
    adminSessions.set(adminId, session);
  }
}

/**
 * Shows or updates an interactive menu message.
 */
async function showOrEditMenu(ctx, text, extra) {
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  try {
    if (session.menuMessageId) {
      await ctx.telegram.editMessageText(
        session.chat.id,
        session.menuMessageId,
        null,
        text,
        { parse_mode: 'Markdown', ...extra }
      );
    } else {
      const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
      session.menuMessageId = sent.message_id;
    }
  } catch (err) {
    const sent = await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
    session.menuMessageId = sent.message_id;
  }
  adminSessions.set(adminId, session);
}

/**
 * Deletes the interactive menu message (if it exists) and sends a confirmation message.
 */
async function deleteMenu(ctx, confirmationMessage) {
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
    await ctx.reply(confirmationMessage, { parse_mode: 'Markdown' });
  }
}

/**
 * Prompts the admin to enter a pattern (via editing the menu message).
 */
async function promptForPattern(ctx, actionLabel) {
  const text =
    `Please enter the pattern to *${actionLabel}*.\n\n` +
    "You can use wildcards (* and ?), or /regex/ syntax.\n\n" +
    "Send `/cancel` to abort.";
  let session = adminSessions.get(ctx.from.id) || {};
  session.action = actionLabel;
  adminSessions.set(ctx.from.id, session);
  await showOrEditMenu(ctx, text, {}); // Show prompt without inline buttons.
}

// Bot Setup

const bot = new Telegraf(BOT_TOKEN);

// --- Group Behavior: Ban New Members ---
bot.on('new_chat_members', async (ctx) => {
  // Only operate if the chat is allowed.
  if (!isChatAllowed(ctx)) return;
  const chatId = ctx.chat.id;
  const newMembers = ctx.message.new_chat_members;
  for (const member of newMembers) {
    const username = member.username?.toLowerCase();
    if (username && isBanned(username)) {
      try {
        await ctx.banChatMember(member.id);
        console.log(`Banned user immediately: @${username} in chat ${chatId}`);
      } catch (error) {
        console.error(`Failed to ban @${username}:`, error);
      }
    } else {
      monitorNewMember(chatId, member);
    }
  }
});

// --- Group Behavior: Ban by Message ---
bot.on('message', async (ctx, next) => {
  // For group messages, operate only in allowed groups.
  if (!isChatAllowed(ctx)) return next();
  const username = ctx.from?.username?.toLowerCase();
  if (username && isBanned(username)) {
    try {
      await ctx.banChatMember(ctx.from.id);
      console.log(`Banned user (message): @${username} in chat ${ctx.chat.id}`);
    } catch (error) {
      console.error(`Failed to ban @${username}:`, error);
    }
  } else {
    return next();
  }
});

// --- Admin / Filter Configuration Workflow ---
// This handler works for both private and group chats (if the user is authorized).
bot.on('text', async (ctx, next) => {
  if (!(await isAuthorized(ctx))) return next();
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  const input = ctx.message.text.trim();

  // If the explainer has not been sent, send it and then show the main menu.
  if (!session.explainerSent) {
    await sendPersistentExplainer(ctx);
    const text =
      "Filter Management Menu\n\n" +
      "Choose an action from the buttons below:";
    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Add Filter', callback_data: 'menu_addFilter' }],
          [{ text: 'Remove Filter', callback_data: 'menu_removeFilter' }],
          [{ text: 'List Filters', callback_data: 'menu_listFilters' }]
        ]
      }
    };
    await showOrEditMenu(ctx, text, keyboard);
    return;
  }

  // If the admin sends "/cancel", abort any pending action.
  if (input.toLowerCase() === '/cancel') {
    session.action = undefined;
    adminSessions.set(adminId, session);
    await deleteMenu(ctx, "Action cancelled.");
    return;
  }

  // If an action is in progress, treat the text as the pattern input.
  if (session.action) {
    if (session.action === 'Add Filter') {
      try {
        const regex = patternToRegex(input);
        if (bannedPatterns.some(p => p.raw === input)) {
          await deleteMenu(ctx, `Pattern "${input}" is already in the filter list.`);
        } else {
          bannedPatterns.push({ raw: input, regex });
          await saveBannedPatterns();
          await deleteMenu(ctx, `Filter added: "${input}"`);
        }
      } catch {
        await deleteMenu(ctx, 'Invalid pattern. Please try again.');
      }
    } else if (session.action === 'Remove Filter') {
      const index = bannedPatterns.findIndex(p => p.raw === input);
      if (index !== -1) {
        bannedPatterns.splice(index, 1);
        await saveBannedPatterns();
        await deleteMenu(ctx, `Filter removed: "${input}"`);
      } else {
        await deleteMenu(ctx, `Filter "${input}" not found.`);
      }
    }
    // Clear pending action.
    session.action = undefined;
    adminSessions.set(adminId, session);
    return;
  }
  // No pending action: re-show the main interactive menu.
  const text =
    "Filter Management Menu\n\n" +
    "Choose an action from the buttons below:";
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Add Filter', callback_data: 'menu_addFilter' }],
        [{ text: 'Remove Filter', callback_data: 'menu_removeFilter' }],
        [{ text: 'List Filters', callback_data: 'menu_listFilters' }]
      ]
    }
  };
  await showOrEditMenu(ctx, text, keyboard);
});

// --- Inline Button Callbacks ---
bot.on('callback_query', async (ctx) => {
  if (!(await isAuthorized(ctx))) {
    return ctx.answerCbQuery('Not authorized.');
  }
  const data = ctx.callbackQuery.data;
  if (data === 'menu_addFilter') {
    await ctx.answerCbQuery();
    return promptForPattern(ctx, 'Add Filter');
  } else if (data === 'menu_removeFilter') {
    await ctx.answerCbQuery();
    return promptForPattern(ctx, 'Remove Filter');
  } else if (data === 'menu_listFilters') {
    await ctx.answerCbQuery();
    if (bannedPatterns.length === 0) {
      return deleteMenu(ctx, "No filter patterns are currently set.");
    }
    const list = bannedPatterns.map(p => p.raw).join('\n');
    return deleteMenu(ctx, `Current filter patterns:\n${list}`);
  } else {
    await ctx.answerCbQuery();
  }
});

// --- Direct Commands (Optional) ---

bot.command('addFilter', async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('Usage: /addFilter <pattern>');
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
  } catch {
    return ctx.reply('Invalid pattern format.');
  }
});

bot.command('removeFilter', async (ctx) => {
  if (!(await isAuthorized(ctx))) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('Usage: /removeFilter <pattern>');
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
  if (!(await isAuthorized(ctx))) return;
  if (bannedPatterns.length === 0) {
    return ctx.reply('No filter patterns are currently set.');
  }
  const list = bannedPatterns.map(p => p.raw).join('\n');
  return ctx.reply(`Current filter patterns:\n${list}`);
});

// Launch Bot

loadBannedPatterns().then(() => {
  bot.launch()
    .then(() => console.log('Bot started!'))
    .catch(err => console.error('Bot launch error:', err));
});
