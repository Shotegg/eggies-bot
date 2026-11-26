const test = require('node:test');
const assert = require('node:assert/strict');
const { requestBody } = require('../httpRequest');

test('aborts a request that exceeds the timeout', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  await assert.rejects(requestBody('https://example.test', {}, { timeoutMs: 10 }), /aborted/);
});

test('does not retry a failed POST', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network'); });
  await assert.rejects(requestBody('https://example.test', { method: 'POST' }), /network/);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('returns an error response body for redemption handling', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 400, json: async () => ({ err_code: 40001 }) }));
  const result = await requestBody('https://example.test', { method: 'POST' }, { allowHttpError: true });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.err_code, 40001);
});
