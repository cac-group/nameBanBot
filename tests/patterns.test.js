// tests/patterns.test.js

import { test } from 'uvu';
import * as assert from 'uvu/assert';

// Import the helpers (adapt import path as needed)
import { createPatternObject, matchesPattern } from '../security.js';

test('Simple text pattern matches exact and case-insensitive', async () => {
  const pt = createPatternObject('max power');
  assert.ok(await matchesPattern(pt.raw, 'Max Power'));
  assert.ok(await matchesPattern(pt.raw, 'MAX POWER'));
  assert.not(await matchesPattern(pt.raw, 'maxwell power'));
});

test('Wildcard patterns work correctly', async () => {
  const pt1 = createPatternObject('*power');
  const pt2 = createPatternObject('max*');
  assert.ok(await matchesPattern(pt1.raw, 'testpower'));
  assert.ok(await matchesPattern(pt2.raw, 'maxwell'));
  assert.not(await matchesPattern(pt1.raw, 'testpowerz'));
});

test('Pattern does not match on empty/invalid inputs', async () => {
  const pt = createPatternObject('foo');
  assert.not(await matchesPattern(pt.raw, ''));
  assert.not(await matchesPattern(pt.raw, null));
  assert.not(await matchesPattern(pt.raw, undefined));
});

test('Regex pattern works, is not bypassed by whitespace or log symbols', async () => {
  const pt = createPatternObject('/^max.*power$/i');
  assert.ok(await matchesPattern(pt.raw, 'max    power'));
  assert.ok(await matchesPattern(pt.raw, 'MAXpower'));
  assert.not(await matchesPattern(pt.raw, 'powermax'));
  // Avoid bypass with special log control chars
  assert.not(await matchesPattern(pt.raw, 'max\npower'));
  assert.not(await matchesPattern(pt.raw, 'max\rpower'));
});

test('Malicious/escaped input does not break logic', async () => {
  // Inputs with backslashes or dangerous regex attempts
  const pt = createPatternObject('test*');
  assert.ok(await matchesPattern(pt.raw, 'test\\evil')); // Should be treated as a wildcard, not an escape
  assert.not(await matchesPattern(pt.raw, 'eviltest'));
  // Malicious input string
  assert.not(await matchesPattern(pt.raw, 'badinput*'));
});

test('Rejects dangerous regex patterns (re DoS, log pollution)', async () => {
  // Should throw or fail to validate a catastrophic backtracking regex
  try {
    createPatternObject('/(a+)+$/');
    assert.unreachable('Should throw for dangerous regex');
  } catch (e) {
    assert.match(e.message, /dangerous|timeout|invalid|unsupported/i);
  }
});

test('No match with special log/control characters in input or pattern', async () => {
  const pt = createPatternObject('testuser');
  assert.not(await matchesPattern(pt.raw, 'testuser\ninjection'));
  assert.not(await matchesPattern(pt.raw, 'testuser\r'));
  assert.not(await matchesPattern(pt.raw, 'testuser\0'));
});

test('Does not match on substrings unless pattern allows', async () => {
  const pt = createPatternObject('power');
  assert.ok(await matchesPattern(pt.raw, 'POWER'));
  assert.ok(await matchesPattern(pt.raw, 'superpower'));
  assert.ok(await matchesPattern(pt.raw, 'powerful'));
  assert.not(await matchesPattern(pt.raw, 'pow'));
  // For stricter: use regex ^power$
  const ptStrict = createPatternObject('/^power$/i');
  assert.ok(await matchesPattern(ptStrict.raw, 'power'));
  assert.not(await matchesPattern(ptStrict.raw, 'superpower'));
});

test('Ignores log-like sequences and unusual Unicode in name', async () => {
  const pt = createPatternObject('solana');
  assert.ok(await matchesPattern(pt.raw, 'Solana SPIN'));
  assert.not(await matchesPattern(pt.raw, 'Sølana'));
  assert.not(await matchesPattern(pt.raw, '[SOLANA]'));
  assert.ok(await matchesPattern(pt.raw, 'solana spin\n[INFO] User logged in'));
});

test.run();
