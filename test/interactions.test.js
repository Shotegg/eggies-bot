const test = require('node:test');
const assert = require('node:assert/strict');
const storagePath = require.resolve('../storage');
const savedCodes = [];
require.cache[storagePath] = { id: storagePath, filename: storagePath, loaded: true, exports: { upsertGiftCodes: async (codes) => savedCodes.push(...codes) } };
const { createInteractions } = require('../interactions');
const leaderRoleId = '1493344291358118058';

test('gift-code command uses worker state and settings from the worker module', async () => {
  const handlers = createInteractions({
    leaderRoleId, defaultGiftCodeKingdomId: 342,
    giftCodeRetryDelayMs: 45000, giftCodeFailedRetryCooldownMs: 1800000,
    isGiftCodeWorkerRunning: () => true,
    syncGiftCodes: async () => ({ ok: true, discoveredCodes: [], attempted: [], skipped: 0, pending: 0 })
  });
  let reply;
  await handlers.handleChatCommand({
    commandName: 'giftcode', user: { id: 'leader' },
    options: { getSubcommand: () => 'run', getString: () => null, getInteger: () => null },
    deferReply: async () => {}, editReply: async (value) => { reply = value; }
  });
  assert.match(typeof reply === 'string' ? reply : reply.content, /already running/);
});

test('non-leaders cannot run clear', async () => {
  const handlers = createInteractions({ leaderRoleId });
  let reply;
  await handlers.handleChatCommand({ commandName: 'clear', user: { id: 'member' }, reply: async (value) => { reply = value; } });
  assert.match(reply.content, /Only leaders/);
});

test('manual gift code is saved and queues the worker', async () => {
  let started = false;
  const handlers = createInteractions({ leaderRoleId, defaultGiftCodeKingdomId: 342, startGiftCodeWorker: () => { started = true; } });
  await handlers.handleChatCommand({
    commandName: 'giftcode', user: { id: 'leader' },
    options: { getSubcommand: () => 'run', getString: (name) => name === 'code' ? 'CODE' : null, getInteger: () => null },
    deferReply: async () => {}, editReply: async () => {}
  });
  assert.equal(savedCodes[0].code, 'CODE');
  assert.equal(started, true);
});

test('leader role is recognized in cached and API member representations', async () => {
  const handlers = createInteractions({ leaderRoleId });
  for (const roles of [{ cache: new Map([[leaderRoleId, {}]]) }, [leaderRoleId]]) {
    let reply;
    await handlers.handleChatCommand({ commandName: 'help', user: { id: 'any-user' }, member: { roles }, reply: async (value) => { reply = value; } });
    assert.match(reply.content, /Role: Leader/);
    assert.match(reply.content, /\/clear/);
  }
});

test('leader checks deny missing or unrelated roles and reevaluate on each action', async () => {
  const handlers = createInteractions({ leaderRoleId });
  let reply;
  const interaction = { commandName: 'clear', user: { id: 'same-user' }, member: { roles: [leaderRoleId] }, inGuild: () => false, reply: async (value) => { reply = value; } };
  await handlers.handleChatCommand(interaction);
  assert.match(reply.content, /only be used in the server/);
  interaction.member.roles = ['another-role'];
  await handlers.handleChatCommand(interaction);
  assert.match(reply.content, /Only leaders/);
  interaction.member = null;
  await handlers.handleChatCommand(interaction);
  assert.match(reply.content, /Only leaders/);
});
