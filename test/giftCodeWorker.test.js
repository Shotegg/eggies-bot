const test = require('node:test');
const assert = require('node:assert/strict');
const storagePath = require.resolve('../storage');
const giftCodesPath = require.resolve('../giftCodes');
const actions = [];
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: {
  getGiftCodeRedemption: async () => null,
  deactivateGiftCode: async (code) => actions.push(['deactivate', code]),
  deleteRedemptionsForCodes: async (codes) => actions.push(['deleteRedemptions', codes]),
  saveGiftCodeRedemption: async (record) => actions.push(['record', record])
} };
require.cache[giftCodesPath] = { id: giftCodesPath, filename: giftCodesPath, loaded: true, exports: {
  redeemGiftCode: async () => ({ ok: false, message: 'TIME ERROR.', redeem: { status: 200, data: { err_code: 40007 } } })
} };
const { createGiftCodeWorker } = require('../giftCodeWorker');

test('40007 disables the code and deletes its redemptions', async () => {
  const worker = createGiftCodeWorker({ giftCodeTerminalStatuses: new Set(['expired']) });
  await worker.redeemCodeForPlayer({ playerId: '1', kid: 342 }, 'SAYHIHI');
  assert.deepEqual(actions[0], ['deactivate', 'SAYHIHI']);
  assert.deepEqual(actions[1], ['deleteRedemptions', ['SAYHIHI']]);
});
