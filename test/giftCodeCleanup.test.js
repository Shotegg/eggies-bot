const test = require('node:test');
const assert = require('node:assert/strict');
const supabasePath = require.resolve('@supabase/supabase-js');
const codes = [
  { code: 'OLD', active: false, expires_at: null },
  { code: 'EXPIRED', active: true, expires_at: '2020-01-01T00:00:00Z' },
  { code: 'LIVE', active: true, expires_at: null }
];
let redemptions = ['OLD', 'EXPIRED', 'LIVE'];
const client = { from(table) {
  const filters = [];
  let update = null;
  let action = '';
  let start = 0;
  let end = Infinity;
  const query = {
    update(value) { action = 'update'; update = value; return this; },
    delete() { action = 'delete'; return this; },
    select() { action = 'select'; return this; },
    eq(key, value) { filters.push((row) => row[key] === value); return this; },
    not(key) { filters.push((row) => row[key] != null); return this; },
    lte(key, value) { filters.push((row) => row[key] <= value); return this; },
    order() { return this; },
    range(a, b) { start = a; end = b; return this; },
    in(key, values) { filters.push((row) => values.includes(row[key])); return this; },
    then(resolve) {
      if (table === 'gift_codes' && action === 'update') {
        codes.filter((row) => filters.every((filter) => filter(row))).forEach((row) => Object.assign(row, update));
        return Promise.resolve({ error: null }).then(resolve);
      }
      if (table === 'gift_codes' && action === 'select') {
        return Promise.resolve({ data: codes.filter((row) => filters.every((filter) => filter(row))).slice(start, end + 1), error: null }).then(resolve);
      }
      if (table === 'gift_code_redemptions' && action === 'delete') {
        redemptions = redemptions.filter((code) => !filters.every((filter) => filter({ code })));
        return Promise.resolve({ error: null }).then(resolve);
      }
      throw new Error('Unexpected query');
    }
  };
  return query;
} };
require.cache[supabasePath] = { id: supabasePath, filename: supabasePath, loaded: true, exports: { createClient: () => client } };
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test';
const { cleanupInactiveGiftCodeRedemptions } = require('../storage');

test('cleanup deletes redemptions for inactive and expired codes and retains active ones', async () => {
  assert.equal(await cleanupInactiveGiftCodeRedemptions(), 2);
  assert.deepEqual(redemptions, ['LIVE']);
  assert.equal(codes.find((code) => code.code === 'EXPIRED').active, false);
  assert.equal(codes.find((code) => code.code === 'LIVE').active, true);
});
