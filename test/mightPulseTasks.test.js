const test = require('node:test');
const assert = require('node:assert/strict');
const storagePath = require.resolve('../storage');
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: {} };
const { createMightPulseTasks } = require('../mightPulseTasks');

test('power formatting remains available to Discord interactions', () => {
  const { formatPower } = createMightPulseTasks({});
  assert.equal(formatPower(1250000), '1.25M');
  assert.equal(formatPower(-1200), '1.2K');
});
