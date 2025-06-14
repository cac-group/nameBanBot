// auth.js

import { WHITELISTED_USER_IDS, WHITELISTED_GROUP_IDS } from './config/config.js';

// Authorization cache
const authCache = {
  lastRefresh: 0,
  refreshInterval: 12 * 60 * 60 * 1000, // 12 hours in milliseconds
  authorizedUsers: new Map(), // userId -> { isGlobal: boolean, managedGroups: Set<groupId> }
  refreshInProgress: false
};

// Will be set by initializeAuth()
let botInstance = null;

/**
 * Initialize the auth system with bot instance
 * @param {Telegraf} bot - Bot instance
 */
export function initializeAuth(bot) {
  botInstance = bot;
  console.log(`[AUTH] Authorization system initialized`);
}

/**
 * Refresh the authorization cache by fetching all group admins
 */
export async function refreshAuthCache() {
  if (!botInstance) {
    console.error(`[AUTH_CACHE] Bot instance not initialized`);
    return;
  }

  if (authCache.refreshInProgress) {
    console.log(`[AUTH_CACHE] Refresh already in progress, skipping`);
    return;
  }

  authCache.refreshInProgress = true;
  console.log(`[AUTH_CACHE] Starting authorization cache refresh...`);
  
  try {
    const newAuthorizedUsers = new Map();
    
    // Add global admins first
    for (const userId of WHITELISTED_USER_IDS) {
      newAuthorizedUsers.set(userId, {
        isGlobal: true,
        managedGroups: new Set(WHITELISTED_GROUP_IDS),
        lastVerified: Date.now()
      });
      console.log(`[AUTH_CACHE] Added global admin: ${userId}`);
    }
    
    // Fetch group admins for each whitelisted group
    for (const groupId of WHITELISTED_GROUP_IDS) {
      try {
        console.log(`[AUTH_CACHE] Fetching admins for group ${groupId}...`);
        const admins = await botInstance.telegram.getChatAdministrators(groupId);
        
        for (const admin of admins) {
          const userId = admin.user.id;
          
          // Skip bot accounts
          if (admin.user.is_bot) continue;
          
          // Get or create user entry
          let userAuth = newAuthorizedUsers.get(userId);
          if (!userAuth) {
            userAuth = {
              isGlobal: WHITELISTED_USER_IDS.includes(userId),
              managedGroups: new Set(),
              lastVerified: Date.now()
            };
            newAuthorizedUsers.set(userId, userAuth);
          }
          
          // Add this group to their managed groups
          userAuth.managedGroups.add(groupId);
          
          console.log(`[AUTH_CACHE] User ${userId} (@${admin.user.username || 'no_username'}) can manage group ${groupId}`);
        }
        
        console.log(`[AUTH_CACHE] Found ${admins.length} admins in group ${groupId}`);
      } catch (error) {
        console.error(`[AUTH_CACHE] Error fetching admins for group ${groupId}:`, error.message);
        // Continue with other groups
      }
    }
    
    // Update the cache
    authCache.authorizedUsers = newAuthorizedUsers;
    authCache.lastRefresh = Date.now();
    
    console.log(`[AUTH_CACHE] Cache refresh complete. ${newAuthorizedUsers.size} authorized users cached.`);
    
    // Log summary
    let globalAdmins = 0;
    let groupAdmins = 0;
    for (const [userId, userAuth] of newAuthorizedUsers) {
      if (userAuth.isGlobal) {
        globalAdmins++;
      } else {
        groupAdmins++;
      }
    }
    console.log(`[AUTH_CACHE] Summary: ${globalAdmins} global admins, ${groupAdmins} group admins`);
    
  } catch (error) {
    console.error(`[AUTH_CACHE] Error during cache refresh:`, error);
  } finally {
    authCache.refreshInProgress = false;
  }
}

/**
 * Check if cache needs refresh and refresh if necessary
 */
async function ensureAuthCacheValid() {
  const now = Date.now();
  const timeSinceRefresh = now - authCache.lastRefresh;
  
  if (timeSinceRefresh > authCache.refreshInterval || authCache.authorizedUsers.size === 0) {
    console.log(`[AUTH_CACHE] Cache expired or empty (${Math.round(timeSinceRefresh / 1000 / 60)} minutes old). Refreshing...`);
    await refreshAuthCache();
  }
}

/**
 * Get user authorization info from cache
 * @param {number} userId - User ID
 * @returns {Object|null} User auth info or null
 */
export function getUserAuthInfo(userId) {
  return authCache.authorizedUsers.get(userId) || null;
}

/**
 * Unified authorization check
 * @param {Context} ctx - Telegraf context
 * @param {Map} adminSessions - Admin sessions map (passed from bot.js)
 * @returns {Promise<boolean>} Whether user is authorized
 */
export async function isAuthorized(ctx, adminSessions = null) {
  const userId = ctx.from?.id;
  const chatType = ctx.chat?.type;
  const chatId = ctx.chat?.id;

  if (!userId) {
    console.log(`[AUTH] No user ID in context - denied`);
    return false;
  }

  console.log(`[AUTH] Checking authorization for user ${userId} in ${chatType} chat ${chatId}`);

  // Ensure cache is valid
  await ensureAuthCacheValid();

  // Get user auth info from cache
  const userAuth = getUserAuthInfo(userId);
  
  if (!userAuth) {
    console.log(`[AUTH] User ${userId} not found in authorization cache - denied`);
    return false;
  }

  // Handle different chat types
  if (chatType === 'private') {
    // Private chats: any authorized user can use
    console.log(`[AUTH] User ${userId} authorized for private chat (${userAuth.isGlobal ? 'global admin' : 'group admin'})`);
    
    // Update session if provided
    if (adminSessions) {
      let session = adminSessions.get(userId) || { chatId: ctx.chat.id };
      session.isGlobalAdmin = userAuth.isGlobal;
      
      // Set a default selected group if they have any
      if (!session.selectedGroupId && userAuth.managedGroups.size > 0) {
        session.selectedGroupId = Array.from(userAuth.managedGroups)[0];
      }
      
      adminSessions.set(userId, session);
    }
    
    return true;
    
  } else if (chatType === 'group' || chatType === 'supergroup') {
    // Group chats: check if group is whitelisted first
    if (!WHITELISTED_GROUP_IDS.includes(chatId)) {
      console.log(`[AUTH] Group ${chatId} not whitelisted - denied`);
      return false;
    }
    
    // Check if user can manage this specific group
    if (userAuth.isGlobal || userAuth.managedGroups.has(chatId)) {
      console.log(`[AUTH] User ${userId} authorized for group ${chatId} (${userAuth.isGlobal ? 'global admin' : 'group admin'})`);
      
      // Update session if provided
      if (adminSessions) {
        let session = adminSessions.get(userId) || { chatId: ctx.chat.id };
        session.isGlobalAdmin = userAuth.isGlobal;
        session.authorizedGroupId = chatId;
        adminSessions.set(userId, session);
      }
      
      return true;
    } else {
      console.log(`[AUTH] User ${userId} cannot manage group ${chatId} - denied`);
      return false;
    }
  }

  console.log(`[AUTH] Unknown chat type ${chatType} - denied`);
  return false;
}

/**
 * Check if user can manage a specific group
 * @param {number} userId - User ID
 * @param {number} groupId - Group ID
 * @returns {boolean} Whether user can manage the group
 */
export function canManageGroup(userId, groupId) {
  const userAuth = getUserAuthInfo(userId);
  
  if (!userAuth) {
    console.log(`[AUTH] User ${userId} cannot manage group ${groupId} - not authorized`);
    return false;
  }
  
  const canManage = userAuth.isGlobal || userAuth.managedGroups.has(groupId);
  console.log(`[AUTH] User ${userId} ${canManage ? 'can' : 'cannot'} manage group ${groupId} (${userAuth.isGlobal ? 'global admin' : 'group admin'})`);
  return canManage;
}

/**
 * Get list of groups a user can manage
 * @param {number} userId - User ID
 * @returns {number[]} Array of group IDs
 */
export function getManagedGroups(userId) {
  const userAuth = getUserAuthInfo(userId);
  
  if (!userAuth) {
    return [];
  }
  
  if (userAuth.isGlobal) {
    return [...WHITELISTED_GROUP_IDS];
  }
  
  return [...userAuth.managedGroups];
}

/**
 * Force refresh authorization cache (for testing or manual refresh)
 */
export async function forceRefreshAuthCache() {
  authCache.lastRefresh = 0; // Force refresh
  await refreshAuthCache();
}

/**
 * Get authorization cache stats
 * @returns {Object} Cache statistics
 */
export function getAuthCacheStats() {
  const now = Date.now();
  const ageMinutes = Math.round((now - authCache.lastRefresh) / 1000 / 60);
  
  let globalAdmins = 0;
  let groupAdmins = 0;
  const groupStats = new Map();
  
  for (const [userId, userAuth] of authCache.authorizedUsers) {
    if (userAuth.isGlobal) {
      globalAdmins++;
    } else {
      groupAdmins++;
    }
    
    for (const groupId of userAuth.managedGroups) {
      groupStats.set(groupId, (groupStats.get(groupId) || 0) + 1);
    }
  }
  
  return {
    totalUsers: authCache.authorizedUsers.size,
    globalAdmins,
    groupAdmins,
    cacheAgeMinutes: ageMinutes,
    refreshInProgress: authCache.refreshInProgress,
    groupStats: Object.fromEntries(groupStats),
    lastRefresh: authCache.lastRefresh,
    nextRefreshIn: Math.max(0, Math.round((authCache.refreshInterval - (now - authCache.lastRefresh)) / 1000 / 60))
  };
}

/**
 * Start periodic cache refresh
 */
export function startPeriodicRefresh() {
  console.log(`[AUTH] Starting periodic refresh (every ${authCache.refreshInterval / 1000 / 60 / 60} hours)`);
  
  setInterval(async () => {
    console.log(`[AUTH_CACHE] Periodic refresh triggered`);
    await refreshAuthCache();
  }, authCache.refreshInterval);
}

/**
 * Initialize auth system and perform initial cache load
 * @param {Telegraf} bot - Bot instance
 */
export async function setupAuth(bot) {
  initializeAuth(bot);
  console.log(`[AUTH] Performing initial authorization cache load...`);
  await refreshAuthCache();
  startPeriodicRefresh();
  console.log(`[AUTH] Authorization system fully initialized`);
}

// Export auth cache info for debugging
export { authCache };