const test = require('node:test');
const assert = require('node:assert/strict');

const storagePath = require.resolve('../storage');
let saves = 0;
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: {
  getDiscordMemberSnapshot: async () => null,
  saveDiscordMemberSnapshot: async (_id, members) => {
    saves++;
    return { members, fetched_at: new Date().toISOString() };
  }
} };
const { getCurrentMemberSnapshot } = require('../memberSnapshots');

test('concurrent requests share one fetch and subsequent requests use the snapshot', async () => {
  let fetches = 0;
  const guild = { id: 'shared', memberCount: 1, members: { fetch: async () => {
    fetches++;
    return [{ id: 'member', user: { bot: false } }];
  } } };
  const [first, second] = await Promise.all([getCurrentMemberSnapshot(guild), getCurrentMemberSnapshot(guild)]);
  assert.deepEqual(first, second);
  await getCurrentMemberSnapshot(guild);
  assert.equal(fetches, 1);
  assert.equal(saves, 1);
});

test('an incomplete member list is not saved or returned', async () => {
  const guild = { id: 'incomplete', memberCount: 2, members: { fetch: async () => [{ id: 'one', user: { bot: false } }] } };
  await assert.rejects(getCurrentMemberSnapshot(guild), /incomplete/);
  await assert.rejects(getCurrentMemberSnapshot(guild), /recently failed/);
  assert.equal(saves, 1);
});
