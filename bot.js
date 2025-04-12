// bot.mjs

import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import toml from 'toml';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const BANNED_PATTERNS_FILE = process.env.BANNED_PATTERNS_FILE || 'banned_patterns.toml';
const WHITELISTED_USER_IDS = [1705203106, 1721840238, 5689314455, 951943232, 878263003];

// In-memory Data

// Each pattern is stored as { raw: string, regex: RegExp }
let bannedPatterns = [];

// Admin session data is stored in this Map (keyed by Telegram user ID).
// Session objects will store:
//   - chatId: the private chat id
//   - menuMessageId: the message id of the interactive menu/prompt
//   - action: pending action (e.g. "Add Filter" or "Remove Filter")
//   - explainerSent: flag indicating the persistent explainer message has been sent
const adminSessions = new Map();

// For new member monitoring (key is "<chatId>_<userId>")
const newJoinMonitors = {};

// Utility Functions

function isAdmin(ctx) {
  return ctx.chat.type === 'private' && WHITELISTED_USER_IDS.includes(ctx.from.id);
}

// Convert a pattern (plain string, wildcard, or /regex/) into a RegExp.
function patternToRegex(patternStr) {
  // If wrapped in /slashes/, treat as a raw regular expression.
  if (patternStr.startsWith('/') && patternStr.endsWith('/') && patternStr.length > 2) {
    const inner = patternStr.slice(1, -1);
    return new RegExp(inner, 'i');
  } else {
    // Without wildcards, do a substring (case-insensitive) match.
    if (!patternStr.includes('*') && !patternStr.includes('?')) {
      return new RegExp(patternStr, 'i');
    }
    // Escape regex special characters (except * and ?), then replace wildcards.
    const escaped = patternStr.replace(/[-\\/^$+?.()|[\]{}]/g, '\\$&');
    const regexStr = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(regexStr, 'i');
  }
}

// Returns true if username matches any banned pattern.
function isBanned(username) {
  return bannedPatterns.some(({ regex }) => regex.test(username));
}

// Persistence Functions

async function loadBannedPatterns() {
  try {
    const data = await fs.readFile(BANNED_PATTERNS_FILE, 'utf-8');
    const parsed = toml.parse(data);
    if (parsed.patterns && Array.isArray(parsed.patterns)) {
      bannedPatterns = parsed.patterns.map((pt) => ({
        raw: pt,
        regex: patternToRegex(pt)
      }));
    }
  } catch (err) {
    console.error(`Error reading ${BANNED_PATTERNS_FILE}, starting empty.`, err);
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
 * Sends a one‑time persistent explainer message to the admin.
 * This message is never edited or deleted.
 */
async function sendPersistentExplainer(ctx) {
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || {};
  if (!session.explainerSent) {
    const text = [
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
      "A single interactive menu message will help you perform actions without chat clutter."
    ].join('\n');
    await ctx.reply(text, { parse_mode: 'Markdown' });
    session.explainerSent = true;
    adminSessions.set(adminId, session);
  }
}

/**
 * Edits (or sends) the interactive menu message.
 * The message id is stored in the admin's session so that it can be updated.
 */
async function showOrEditMenu(ctx, text, extra) {
  const adminId = ctx.from.id;
  let session = adminSessions.get(adminId) || { chatId: ctx.chat.id };
  try {
    if (session.menuMessageId) {
      await ctx.telegram.editMessageText(session.chatId, session.menuMessageId, null, text, {
        parse_mode: 'Markdown',
        ...extra
      });
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
  let session = adminSessions.get(adminId);
  if (session && session.menuMessageId) {
    try {
      await ctx.telegram.deleteMessage(session.chatId, session.menuMessageId);
    } catch (e) {
      console.error("Failed to delete menu message:", e);
    }
    session.menuMessageId = null;
    adminSessions.set(adminId, session);
  }
  await ctx.reply(confirmationMessage, { parse_mode: 'Markdown' });
}

/**
 * Prompts for a pattern by editing the existing menu message.
 * Also sets session.action to reflect the pending action.
 */
async function promptForPattern(ctx, actionLabel) {
  const text =
    `Please enter the pattern to *${actionLabel}*.\n\n` +
    "You can use wildcards (* and ?), or /regex/ syntax.\n\n" +
    "Send `/cancel` to abort.";
  const session = adminSessions.get(ctx.from.id) || {};
  session.action = actionLabel;
  adminSessions.set(ctx.from.id, session);
  await showOrEditMenu(ctx, text, {}); // Show prompt without inline buttons.
}

// Bot Setup

const bot = new Telegraf(BOT_TOKEN);

// === Group: Ban Logic ===
bot.on('new_chat_members', async (ctx) => {
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

bot.on('message', async (ctx, next) => {
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

// === Admin / Filter Workflow ===

// Admin can start filter configuration by typing `/filter`.
bot.command('filter', async (ctx) => {
  if (!isAdmin(ctx)) return;
  await sendPersistentExplainer(ctx);
  // Show the main menu with options.
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

// For convenience: if admin sends any text in private chat and no action is pending, delete any menu.
bot.on('text', async (ctx, next) => {
  if (!isAdmin(ctx)) return next();
  const adminId = ctx.from.id;
  const session = adminSessions.get(adminId) || {};
  const input = ctx.message.text.trim();

  // If the admin sends /cancel, abort current action and delete the menu.
  if (input.toLowerCase() === '/cancel') {
    await deleteMenu(ctx, "Action cancelled.");
    return;
  }

  // If a pending action exists, process the text input.
  if (session.action) {
    const pattern = input;
    if (session.action === 'Add Filter') {
      try {
        const regex = patternToRegex(pattern);
        if (bannedPatterns.some((p) => p.raw === pattern)) {
          await deleteMenu(ctx, `Pattern "${pattern}" is already in the filter list.`);
        } else {
          bannedPatterns.push({ raw: pattern, regex });
          await saveBannedPatterns();
          await deleteMenu(ctx, `Filter added: "${pattern}"`);
        }
      } catch {
        await deleteMenu(ctx, "Invalid pattern. Please try again.");
      }
    } else if (session.action === 'Remove Filter') {
      const index = bannedPatterns.findIndex((p) => p.raw === pattern);
      if (index !== -1) {
        bannedPatterns.splice(index, 1);
        await saveBannedPatterns();
        await deleteMenu(ctx, `Filter removed: "${pattern}"`);
      } else {
        await deleteMenu(ctx, `Filter "${pattern}" not found.`);
      }
    }
    // Clear the pending action.
    session.action = undefined;
    adminSessions.set(adminId, session);
  } else {
    // No pending action – show the menu (if desired, you could also opt to ignore plain text).
    await deleteMenu(ctx, "No action in progress. To start, type `/filter`.");
  }
});

// === Inline Button Callbacks ===
bot.on('callback_query', async (ctx) => {
  if (!isAdmin(ctx)) {
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
      return deleteMenu(ctx, 'No filter patterns are currently set.');
    }
    const list = bannedPatterns.map((p) => p.raw).join('\n');
    return deleteMenu(ctx, `Current filter patterns:\n${list}`);
  } else {
    await ctx.answerCbQuery();
  }
});

// === Direct Commands (Optional) ===

bot.command('addFilter', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('Usage: /addFilter <pattern>');
  }
  const pattern = parts.slice(1).join(' ').trim();
  try {
    const regex = patternToRegex(pattern);
    if (bannedPatterns.some((p) => p.raw === pattern)) {
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
  if (!isAdmin(ctx)) return;
  const parts = ctx.message.text.split(' ');
  if (parts.length < 2) {
    return ctx.reply('Usage: /removeFilter <pattern>');
  }
  const pattern = parts.slice(1).join(' ').trim();
  const index = bannedPatterns.findIndex((p) => p.raw === pattern);
  if (index !== -1) {
    bannedPatterns.splice(index, 1);
    await saveBannedPatterns();
    return ctx.reply(`Filter removed: "${pattern}"`);
  } else {
    return ctx.reply(`Filter "${pattern}" not found.`);
  }
});

bot.command('listFilters', (ctx) => {
  if (!isAdmin(ctx)) return;
  if (bannedPatterns.length === 0) {
    return ctx.reply('No filter patterns are currently set.');
  }
  const list = bannedPatterns.map((p) => p.raw).join('\n');
  return ctx.reply(`Current filter patterns:\n${list}`);
});

// Launch Bot

loadBannedPatterns().then(() => {
  bot.launch()
    .then(() => console.log('Bot started!'))
    .catch((err) => console.error('Bot launch error:', err));
});
