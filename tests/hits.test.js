import { test } from 'uvu';
import * as assert from 'uvu/assert';

// Suppose you export incrementHitCounter/getHitStatsForGroup from bot.js or a helpers file
import { incrementHitCounter, getHitStatsForGroup } from '../bot.js';

test('incrementHitCounter and getHitStatsForGroup', () => {
  incrementHitCounter(123, 'abc');
  incrementHitCounter(123, 'abc');
  incrementHitCounter(123, 'def');
  const stats = getHitStatsForGroup(123);
  assert.equal(stats, [
    { pattern: 'abc', count: 2 },
    { pattern: 'def', count: 1 }
  ]);
});

test.run();
