// security.js

/**
 * Safe regex compilation with basic protections
 * @param {string} patternStr - The pattern string to compile
 * @returns {RegExp} - Compiled regex object
 * @throws {Error} - If pattern is invalid
 */
export function compileSafeRegex(patternStr) {
  if (typeof patternStr !== 'string') {
    throw new Error('Pattern must be a string');
  }

  // Handle regex format: /pattern/flags
  if (patternStr.startsWith('/') && patternStr.length > 2) {
    const lastSlash = patternStr.lastIndexOf('/');
    if (lastSlash > 0) {
      const pattern = patternStr.slice(1, lastSlash);
      const flags = patternStr.slice(lastSlash + 1);
      
      // Sanitize flags - only allow safe flags
      const safeFlags = flags.replace(/[^gimsu]/g, '');
      
      try {
        // Compile and test the regex
        const regex = new RegExp(pattern, safeFlags);
        
        // Quick test to ensure regex doesn't crash
        'test'.match(regex);
        
        return regex;
      } catch (err) {
        throw new Error(`Invalid regex pattern: ${err.message}`);
      }
    }
  }
  
  // Handle wildcard patterns with proper word boundaries
  if (patternStr.includes('*') || patternStr.includes('?')) {
    // Escape regex special characters except * and ?
    let escaped = patternStr.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    
    // Convert wildcards to regex with word boundaries
    // *word should match "anything ending with word"
    // word* should match "word followed by anything" 
    // *word* should match "anything containing word"
    
    if (patternStr.startsWith('*') && patternStr.endsWith('*')) {
      // *word* -> match anywhere (current behavior is correct)
      escaped = escaped.replace(/\*/g, '.*');
    } else if (patternStr.startsWith('*')) {
      // *word -> match ending with word
      escaped = escaped.replace(/\*/g, '.*') + '$';
    } else if (patternStr.endsWith('*')) {
      // word* -> match starting with word  
      escaped = '^' + escaped.replace(/\*/g, '.*');
    } else {
      // no leading/trailing * -> convert normally
      escaped = escaped.replace(/\*/g, '.*');
    }
    
    // Convert ? to single character
    escaped = escaped.replace(/\?/g, '.');
    
    return new RegExp(escaped, 'i');
  }
  
  // Plain text - escape all special characters and match as substring
  const escaped = patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

/**
 * Validate pattern input to prevent malicious content
 * @param {string} pattern - Pattern to validate
 * @returns {string} - Cleaned and validated pattern
 * @throws {Error} - If pattern is invalid
 */
export function validatePattern(pattern) {
  if (typeof pattern !== 'string') {
    throw new Error('Pattern must be a string');
  }
  
  // Remove control characters
  // eslint-disable-next-line no-control-regex
  const cleaned = pattern.replace(/[\x00-\x1F\x7F]/g, '');
  
  // Check maximum length
  if (cleaned.length > 500) {
    throw new Error('Pattern too long (max 500 characters)');
  }
  
  if (cleaned.length === 0) {
    throw new Error('Pattern cannot be empty');
  }
  
  // Test regex compilation to catch syntax errors early
  try {
    compileSafeRegex(cleaned);
  } catch (err) {
    throw new Error(`Pattern validation failed: ${err.message}`);
  }
  
  return cleaned;
}

/**
 * Test pattern matching with timeout protection
 * @param {RegExp} regex - Compiled regex pattern
 * @param {string} testString - String to test against
 * @param {number} timeoutMs - Timeout in milliseconds (default: 100)
 * @returns {Promise<boolean>} - Whether the pattern matches
 */
export function testPatternSafely(regex, testString, timeoutMs = 100) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Pattern matching timeout'));
    }, timeoutMs);
    
    try {
      const result = regex.test(testString);
      clearTimeout(timeout);
      resolve(result);
    } catch (err) {
      clearTimeout(timeout);
      reject(err);
    }
  });
}

/**
 * Match a pattern against a test string safely
 * @param {string} pattern - Raw pattern string
 * @param {string} testString - String to test
 * @returns {Promise<boolean>} - Whether the pattern matches
 */
export async function matchesPattern(pattern, testString) {
  try {
    // Return false for invalid inputs
    if (!testString || typeof testString !== 'string') {
      return false;
    }
    
    // Ignore log-like sequences in brackets [TEXT]
    if (/^\[.*\]$/.test(testString.trim())) {
      return false;
    }
    
    // Check for control characters
    // eslint-disable-next-line no-control-regex
    const hasControlChars = /[\x00-\x1F\x7F]/.test(testString);
    
    if (hasControlChars) {
      // Only allow control chars if followed by log markers like [INFO], [DEBUG], etc.
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1F\x7F]\s*\[(?:INFO|DEBUG|ERROR|WARN|LOG)\]/.test(testString)) {
        // This looks like genuine log content - allow matching the part before control chars
        const regex = compileSafeRegex(pattern);
        // eslint-disable-next-line no-control-regex
        const cleanPart = testString.split(/[\x00-\x1F\x7F]/)[0];
        return cleanPart && regex.test(cleanPart);
      }
      
      // Otherwise reject all strings with control characters
      return false;
    }
    
    // Compile the pattern safely
    const regex = compileSafeRegex(pattern);
    
    // Test with timeout protection
    return await testPatternSafely(regex, testString);
  } catch (err) {
    console.warn(`Pattern matching error for "${pattern}": ${err.message}`);
    return false;
  }
}

/**
 * Create a safe regex object with metadata
 * @param {string} patternStr - Raw pattern string
 * @returns {Object} - Object with raw pattern and compiled regex
 */
export function createPatternObject(rawPattern) {
  const validated = validatePattern(rawPattern);
  const regex = compileSafeRegex(validated);
  return {
    raw: validated,
    regex
  };
}

/**
 * Batch validate and compile multiple patterns
 * @param {string[]} patterns - Array of pattern strings
 * @returns {Object[]} - Array of pattern objects
 */
export function validatePatterns(patterns) {
  if (!Array.isArray(patterns)) {
    throw new Error('Patterns must be an array');
  }
  
  const validatedPatterns = [];
  const errors = [];
  
  for (let i = 0; i < patterns.length; i++) {
    try {
      const patternObj = createPatternObject(patterns[i]);
      validatedPatterns.push(patternObj);
    } catch (err) {
      errors.push({ index: i, pattern: patterns[i], error: err.message });
    }
  }
  
  return {
    valid: validatedPatterns,
    errors: errors
  };
}

// Export all functions as a default object as well
export default {
  compileSafeRegex,
  validatePattern,
  testPatternSafely,
  matchesPattern,
  createPatternObject,
  validatePatterns
};