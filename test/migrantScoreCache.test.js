const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMigrantScores } = require('../migrantScoreCache');

test('reuses recent scores including zero and fetches only missing or older scores', async () => {
  let fetchedIds;
  let saved;
  const result = await resolveMigrantScores(['1', '2', '3', '4', '5'], {
    now: () => new Date('2026-11-28T12:00:00Z'),
    readCache: async () => [
      { player_id: '1', score: 100, score_date: '2026-11-21' },
      { player_id: '2', score: 200, score_date: '2026-11-20' },
      { player_id: '3', score: 0, score_date: '2026-11-28' },
      { player_id: '4', score: 300, score_date: '2026-11-29' }
    ],
    fetchScores: async ids => { fetchedIds = ids; return new Map([['2', 250], ['4', 350]]); },
    saveCache: async (scores, date) => { saved = { scores: [...scores], date }; }
  });
  assert.deepEqual(fetchedIds, ['2', '4', '5']);
  assert.deepEqual(saved, { scores: [['2', 250], ['4', 350]], date: '2026-11-28' });
  assert.deepEqual([...result], [['1', 100], ['3', 0], ['2', 250], ['4', 350]]);
  assert.equal(result.has('5'), false);
});

test('does not call MightPulse or write when every score is recent', async () => {
  const scores = await resolveMigrantScores(['1'], {
    now: () => new Date('2026-11-28T23:59:00Z'),
    readCache: async () => [{ player_id: '1', score: 42, score_date: '2026-11-28' }],
    fetchScores: async () => { throw new Error('unexpected API call'); },
    saveCache: async () => { throw new Error('unexpected database write'); }
  });
  assert.equal(scores.get('1'), 42);
});
