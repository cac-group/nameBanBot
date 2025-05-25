// debug_patterns.js - Quick debug script
import { createPatternObject, matchesPattern } from '../security.js';

async function debugTest() {
  console.log("=== Debugging Pattern Matching ===\n");
  
  // Test 1: Wildcard patterns work correctly
  console.log("Test 1: Wildcard patterns");
  const pt1 = createPatternObject('*power');
  const pt2 = createPatternObject('max*');
  
  console.log(`Pattern 1: ${pt1.raw} -> Regex: ${pt1.regex}`);
  console.log(`Pattern 2: ${pt2.raw} -> Regex: ${pt2.regex}`);
  
  const test1a = await matchesPattern(pt1.raw, 'testpower');
  const test1b = await matchesPattern(pt1.raw, 'testpowerz');
  const test2a = await matchesPattern(pt2.raw, 'maxwell');
  
  console.log(`'*power' vs 'testpower': ${test1a} (should be true)`);
  console.log(`'*power' vs 'testpowerz': ${test1b} (should be false)`);
  console.log(`'max*' vs 'maxwell': ${test2a} (should be true)`);
  console.log("");
  
  // Test 2: Control characters
  console.log("Test 2: Control characters");
  const pt3 = createPatternObject('/^max.*power$/i');
  const test3a = await matchesPattern(pt3.raw, 'max    power');
  const test3b = await matchesPattern(pt3.raw, 'max\npower');
  
  console.log(`'/^max.*power$/i' vs 'max    power': ${test3a} (should be true)`);
  console.log(`'/^max.*power$/i' vs 'max\\npower': ${test3b} (should be false)`);
  console.log("");
  
  // Test 3: Unicode
  console.log("Test 3: Unicode");
  const pt4 = createPatternObject('solana');
  const test4a = await matchesPattern(pt4.raw, 'Solana SPIN');
  const test4b = await matchesPattern(pt4.raw, 'Sølana');
  
  console.log(`'solana' vs 'Solana SPIN': ${test4a} (should be true)`);
  console.log(`'solana' vs 'Sølana': ${test4b} (should be false)`);
}

debugTest().catch(console.error);