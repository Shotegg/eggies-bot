const test = require('node:test');
const assert = require('node:assert/strict');
const { getAllianceTags, getPrimaryRoster } = require('../allianceTags');

test('preserves exact case and removes only identical tags', () => {
  assert.deepEqual(getAllianceTags('EGG', ' EPC, PEN, WWF, EPc, EPC '), ['EGG', 'EPC', 'PEN', 'WWF', 'EPc']);
});

test('defaults include the primary alliance and five exact tags', () => {
  assert.deepEqual(getAllianceTags('EGG'), ['EGG', 'EPC', 'PEN', 'WWF', 'EPc']);
});

test('weekly roster comes from the exact primary request, even if response tags differ in case', () => {
  const rosters = [{ allianceTag: 'egg', members: ['primary'] }, { allianceTag: 'EGG', members: ['other'] }];
  assert.deepEqual(getPrimaryRoster('EGG', ['EGG', 'Egg'], rosters).members, ['primary']);
  assert.equal(getPrimaryRoster('egg', ['EGG', 'Egg'], rosters), null);
});
