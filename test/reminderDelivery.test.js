const test = require('node:test');
const assert = require('node:assert/strict');
const { deliverReminders, getOccurrenceToNotify } = require('../reminderDelivery');

test('repeating events select the correct occurrence at reminder boundaries', () => {
  const base = Date.parse('2026-01-01T12:00:00Z');
  const event = { nextAt: new Date(base).toISOString(), repeatHours: 4, remindMinutesBefore: 60 };
  assert.equal(getOccurrenceToNotify(event, base - 3600001), null);
  assert.equal(getOccurrenceToNotify(event, base - 3600000).occurrenceMs, base);
  assert.equal(getOccurrenceToNotify(event, base + 3 * 3600000).occurrenceMs, base + 4 * 3600000);
});

function setup(send, markNotified) {
  const reminders = ['a', 'b'].map((userId) => ({ userId, eventKey: 'war', active: true, lastNotifiedOccurrenceMs: null }));
  return {
    reminders,
    options: {
      client: { channels: { fetch: async () => ({ isTextBased: () => true, send }) } },
      events: [{ key: 'war', title: 'War' }], reminders, channelId: 'channel',
      getOccurrence: () => ({ occurrenceMs: 123, remindMinutesBefore: 60 }),
      chunkUserIds: (ids) => ids.map((id) => [id]),
      buildActionRow: () => ({}), markNotified, logger: { error() {} }
    }
  };
}

test('only successful chunks are recorded and failed chunks retry', async () => {
  const recorded = [];
  let fail = true;
  const { options, reminders } = setup(async (message) => {
    if (message.allowedMentions.users[0] === 'b' && fail) throw new Error('Discord unavailable');
  }, async (event, ids, occurrence) => recorded.push([event, ids, occurrence]));
  await deliverReminders(options);
  assert.deepEqual(recorded, [['war', ['a'], 123]]);
  assert.deepEqual(reminders.map((r) => r.lastNotifiedOccurrenceMs), [123, null]);
  fail = false;
  await deliverReminders(options);
  assert.deepEqual(recorded, [['war', ['a'], 123], ['war', ['b'], 123]]);
});

test('a failed channel fetch or database write does not mark reminders as sent', async () => {
  const { options, reminders } = setup(async () => {}, async () => { throw new Error('database'); });
  options.client.channels.fetch = async () => { throw new Error('Discord'); };
  await deliverReminders(options);
  assert.deepEqual(reminders.map((r) => r.lastNotifiedOccurrenceMs), [null, null]);
  options.client.channels.fetch = async () => ({ isTextBased: () => true, send: async () => {} });
  await deliverReminders(options);
  assert.deepEqual(reminders.map((r) => r.lastNotifiedOccurrenceMs), [null, null]);
});
