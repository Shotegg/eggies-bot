const test = require('node:test');
const assert = require('node:assert/strict');
const { redeemWithRateLimitRetry, normalizeGiftCodeRedemption } = require('../giftCodeRateLimit');

const rateLimited = { ok: false, redeem: { status: 200, data: { err_code: 40013 } } };
const success = { ok: true, redeem: { status: 200, data: { code: 0 } } };
const quiet = { warn() {} };

test('previously misclassified 40007 records are treated as expired', () => {
  const old = { status: 'town_center_too_low', err_code: '40007', message: 'TIME ERROR.' };
  assert.equal(normalizeGiftCodeRedemption(old).status, 'expired');
  assert.equal(normalizeGiftCodeRedemption({ ...old, err_code: '40008' }).status, 'town_center_too_low');
});

test('40007 is returned immediately without retry', async () => {
  const options = { wait: async () => {}, logger: quiet };
  let calls = 0;
  const timeError = { ok: false, message: 'TIME ERROR.', redeem: { status: 200, data: { err_code: 40007 } } };
  const result = await redeemWithRateLimitRetry(async () => ++calls === 1 ? timeError : success, 'p', 'c', 342, options);
  assert.equal(calls, 1);
  assert.equal(result.result, timeError);
});

test('retries the same player and code after five seconds and returns success', async () => {
  const calls = [];
  const waits = [];
  const result = await redeemWithRateLimitRetry(async (...args) => {
    calls.push(args);
    return calls.length === 1 ? rateLimited : success;
  }, 'player', 'code', 342, { wait: async (ms) => waits.push(ms), logger: quiet });
  assert.deepEqual(calls, [['player', 'code', 342], ['player', 'code', 342]]);
  assert.deepEqual(waits, [5000]);
  assert.equal(result.result, success);
  assert.equal(result.rateLimitExhausted, false);
});

test('stops after three retries if the rate limit persists', async () => {
  let calls = 0;
  const waits = [];
  const result = await redeemWithRateLimitRetry(async () => { calls++; return rateLimited; }, 'p', 'c', 342,
    { wait: async (ms) => waits.push(ms), logger: quiet });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [5000, 5000, 5000]);
  assert.equal(result.rateLimitExhausted, true);
});

test('retries HTTP 429 but does not retry other API errors or ambiguous network failures', async () => {
  let calls = 0;
  const wait = async () => {};
  const options = { wait, logger: quiet };
  const result = await redeemWithRateLimitRetry(async () => ++calls === 1 ? { ok: false, redeem: { status: 429, data: {} } } : success, 'p', 'c', 342, options);
  assert.equal(result.result, success);
  assert.equal(calls, 2);
  calls = 0;
  const rejected = { ok: false, redeem: { status: 200, data: { err_code: 40006 } } };
  assert.equal((await redeemWithRateLimitRetry(async () => { calls++; return rejected; }, 'p', 'c', 342, options)).result, rejected);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(redeemWithRateLimitRetry(async () => { calls++; throw new Error('timeout'); }, 'p', 'c', 342, options), /timeout/);
  assert.equal(calls, 1);
});
