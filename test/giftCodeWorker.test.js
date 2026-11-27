const test = require('node:test');
const assert = require('node:assert/strict');
const storagePath = require.resolve('../storage');
const giftCodesPath = require.resolve('../giftCodes');
const actions = [];
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: {
  getGiftCodeRedemption: async () => null,
  getGiftCodePlayers: async () => [{ playerId: '1' }, { playerId: '2' }],
  upsertGiftCodes: async () => {},
  getActiveGiftCodes: async () => [{ code: 'ACTIVE' }],
  getGiftCodeRedemptionsForCodes: async (codes) => {
    assert.deepEqual(codes, ['ACTIVE']);
    return [{ player_id: '1', code: 'ACTIVE', status: 'success' }];
  },
  deactivateGiftCode: async (code) => actions.push(['deactivate', code]),
  deleteRedemptionsForCodes: async (codes) => actions.push(['deleteRedemptions', codes]),
  saveGiftCodeRedemption: async (record) => actions.push(['record', record])
} };
require.cache[giftCodesPath] = { id: giftCodesPath, filename: giftCodesPath, loaded: true, exports: {
  fetchActiveGiftCodes: async () => [{ code: 'ACTIVE' }, { code: 'INACTIVE' }],
  redeemGiftCode: async () => ({ ok: false, message: 'TIME ERROR.', redeem: { status: 200, data: { err_code: 40007 } } })
} };
const { createGiftCodeWorker } = require('../giftCodeWorker');

test('40007 disables the code and deletes its redemptions', async () => {
  const worker = createGiftCodeWorker({ giftCodeTerminalStatuses: new Set(['expired']) });
  await worker.redeemCodeForPlayer({ playerId: '1', kid: 342 }, 'SAYHIHI');
  assert.deepEqual(actions[0], ['deactivate', 'SAYHIHI']);
  assert.deepEqual(actions[1], ['deleteRedemptions', ['SAYHIHI']]);
});

test('sync displays and counts only active database codes', async (t) => {
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const worker = createGiftCodeWorker({ giftCodeTerminalStatuses: new Set(['success']), giftCodeCleanupAfterDays: 0 });
  const result = await worker.syncGiftCodes();
  assert.deepEqual(result.discoveredCodes, [{ code: 'ACTIVE' }]);
  assert.equal(result.pending, 1);
  assert.equal(result.skipped, 1);
});
