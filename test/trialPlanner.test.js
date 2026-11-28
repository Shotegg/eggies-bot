const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const { assignLanes } = require('../trialPlanner');

test('trial planner assigns strongest two per lane then cycles one per lane', () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ playerId: String(i + 1), score: 12 - i }));
  const lanes = assignLanes(players.reverse());
  assert.deepEqual(lanes.middle.map(p => p.playerId), ['1', '2', '7', '10']);
  assert.deepEqual(lanes.hard.map(p => p.playerId), ['3', '4', '8', '11']);
  assert.deepEqual(lanes.easy.map(p => p.playerId), ['5', '6', '9', '12']);
});

test('players without scores follow all scored players and are shuffled', () => {
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const lanes = assignLanes([
      { playerId: 'missing1' }, { playerId: 'strong', score: 10 },
      { playerId: 'missing2' }, { playerId: 'zero', score: 0 },
      { playerId: 'missing3' }
    ]);
    assert.deepEqual(lanes.middle.map(p => p.playerId), ['strong', 'zero']);
    assert.deepEqual(lanes.hard.map(p => p.playerId), ['missing2', 'missing3']);
    assert.deepEqual(lanes.easy.map(p => p.playerId), ['missing1']);
  } finally { Math.random = originalRandom; }
});
