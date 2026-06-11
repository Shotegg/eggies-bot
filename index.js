require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder
} = require('discord.js');
const {
  getEvents,
  getEventByKey,
  saveEvents,
  getReminders,
  saveReminders
} = require('./storage');
const { startKeepAlive } = require('./keepAlive');
const { redeemGiftCode } = require('./giftCodes');

const token = process.env.DISCORD_TOKEN;
const reminderChannelId = process.env.REMINDER_CHANNEL_ID || '1501304144139653193';
const leaderIds = (process.env.LEADER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const debugMemberUserIds = new Set();

if (!token) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
startKeepAlive();

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

function toEpochMs(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildIsoFromParts(dayRaw, monthRaw, hourRaw, minuteRaw) {
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);

  if ([day, month, hour, minute].some((v) => Number.isNaN(v))) return null;
  if (day < 1 || day > 31 || month < 1 || month > 12 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const now = new Date();
  let year = now.getUTCFullYear();
  let date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) {
    return null;
  }

  if (date.getTime() < now.getTime()) {
    year += 1;
    date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute) {
      return null;
    }
  }

  return date.toISOString();
}

function formatWhen(value) {
  if (!value) return 'not set';
  const epochMs = toEpochMs(value);
  if (!epochMs) return `invalid date (${value})`;
  const unix = Math.floor(epochMs / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function formatEventLine(event) {
  return `- ${event.title} | next: ${formatWhen(event.nextAt)}`;
}

function formatEventLineForLeader(event) {
  return `- ${event.key} - ${event.title} | next: ${formatWhen(event.nextAt)}`;
}

function buildEventText(event, showKey = true) {
  const repeat = event.repeatHours ? `Every ${event.repeatHours} hours` : 'Not repeating';
  const remind = event.remindMinutesBefore ?? 60;
  return [
    showKey ? `**${event.title}** (${event.key})` : `**${event.title}**`,
    event.description || 'No description',
    `Next: ${formatWhen(event.nextAt)}`,
    `Repeat: ${repeat}`,
    `Reminder offset: ${remind} minutes before`
  ].join('\n');
}

function findSubscription(reminders, userId, eventKey) {
  return reminders.find((r) => r.userId === userId && r.eventKey === eventKey && r.active !== false);
}

function buildReminderActionRow(eventKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`unsub:${eventKey}`).setLabel("Don't remind me").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`info:${eventKey}`).setLabel('Info').setStyle(ButtonStyle.Secondary)
  );
}

function buildSubscribeAllMembersRow(eventKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`allremind:${eventKey}`).setLabel('Subscribe all members').setStyle(ButtonStyle.Primary)
  );
}

function chunkUserIdsForReminder(userIds, suffix) {
  const chunks = [];
  let current = [];
  let currentLength = suffix.length;

  for (const userId of userIds) {
    const mention = `<@${userId}>`;
    const extraLength = mention.length + (current.length > 0 ? 1 : 0);

    if (current.length > 0 && currentLength + extraLength > 1900) {
      chunks.push(current);
      current = [];
      currentLength = suffix.length;
    }

    current.push(userId);
    currentLength += mention.length + (current.length > 1 ? 1 : 0);
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function getOccurrenceToNotify(event, nowMs) {
  const baseMs = toEpochMs(event.nextAt);
  if (!baseMs) return null;

  const remindMinutes = event.remindMinutesBefore ?? 60;
  const remindOffsetMs = remindMinutes * 60 * 1000;
  const repeatHours = Number(event.repeatHours || 0);
  const repeatMs = repeatHours > 0 ? repeatHours * 60 * 60 * 1000 : 0;

  if (repeatMs === 0) {
    const remindAtMs = baseMs - remindOffsetMs;
    if (nowMs >= remindAtMs) return { occurrenceMs: baseMs, remindMinutesBefore: remindMinutes };
    return null;
  }

  const firstRemindMs = baseMs - remindOffsetMs;
  if (nowMs < firstRemindMs) return null;

  const cycles = Math.floor((nowMs - firstRemindMs) / repeatMs);
  const occurrenceMs = baseMs + cycles * repeatMs;
  return { occurrenceMs, remindMinutesBefore: remindMinutes };
}

function isHardcodedLeader(userId) {
  return leaderIds.includes(userId);
}

function isLeader(userId) {
  return isHardcodedLeader(userId) && !debugMemberUserIds.has(userId);
}

function buildHelpContent(userId) {
  return [
    '**Available commands**',
    '`/help` show this message',
    '`/events` list saved events',
    '`/event name:<event title>` show next time + actions',
    isLeader(userId) ? '`/giftcode player_id:<id> code:<code>` redeem a Kingshot gift code' : null,
    isLeader(userId) ? 'Role: Leader' : 'Role: Member'
  ].filter(Boolean).join('\n');
}

function buildDebugRoleRow(userId) {
  const nextRole = isLeader(userId) ? 'Member' : 'Leader';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('debugrole:toggle').setLabel(`View as ${nextRole}`).setStyle(ButtonStyle.Secondary)
  );
}

function buildHelpResponse(userId) {
  const response = {
    content: buildHelpContent(userId),
    flags: MessageFlags.Ephemeral
  };

  if (isHardcodedLeader(userId)) {
    response.components = [buildDebugRoleRow(userId)];
  }

  return response;
}

function buildLeaderRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('leader:add').setLabel('Add').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('leader:remove').setLabel('Remove').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('leader:edit').setLabel('Edit').setStyle(ButtonStyle.Secondary)
  );
}

async function findEventForUser(input, isUserLeader) {
  const normalized = input.trim().toLowerCase();
  const events = await getEvents();
  if (isUserLeader) {
    return events.find((event) => event.key.toLowerCase() === normalized || event.title.toLowerCase() === normalized);
  }
  return events.find((event) => event.title.toLowerCase() === normalized);
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'event') return;
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'name') {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.toLowerCase();
  const events = await getEvents();
  const leader = isLeader(interaction.user.id);
  const matches = events
    .filter((event) => (leader ? event.key.toLowerCase().includes(query) || event.title.toLowerCase().includes(query) : event.title.toLowerCase().includes(query)))
    .slice(0, 25)
    .map((event) => ({ name: leader ? `${event.key} (${event.title})` : event.title, value: leader ? event.key : event.title }));

  await interaction.respond(matches);
}

async function handleChatCommand(interaction) {
  if (interaction.commandName === 'help') {
    await interaction.reply(buildHelpResponse(interaction.user.id));
    return;
  }

  if (interaction.commandName === 'events') {
    const events = await getEvents();
    const leader = isLeader(interaction.user.id);
    const lines = events.length === 0 ? ['No saved events yet.'] : events.map(leader ? formatEventLineForLeader : formatEventLine);

    const response = {
      content: ['**Saved events**', ...lines].join('\n'),
      flags: MessageFlags.Ephemeral
    };

    if (leader) response.components = [buildLeaderRow()];
    await interaction.reply(response);
    return;
  }

  if (interaction.commandName === 'giftcode') {
    if (!isLeader(interaction.user.id)) {
      await interaction.reply({ content: 'Only leaders can use this command.', flags: MessageFlags.Ephemeral });
      return;
    }

    const playerId = interaction.options.getString('player_id', true).trim();
    const code = interaction.options.getString('code', true).trim();

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const result = await redeemGiftCode(playerId, code);
      const player = result.player?.data?.data;
      const playerLine = player
        ? `Player: ${player.nickname || 'Unknown'} (${player.fid}) | State: ${player.kid || 'unknown'} | Town Center: ${player.stove_lv || 'unknown'}`
        : `Player ID: ${playerId}`;
      const raw = result.redeem?.data || result.player?.data;
      const statusLine = result.ok ? 'Status: Redeemed successfully.' : `Status: ${result.message}`;
      const codeLine = raw?.err_code ? `Error code: ${raw.err_code}` : null;

      await interaction.editReply({
        content: [statusLine, playerLine, codeLine].filter(Boolean).join('\n')
      });
    } catch (error) {
      console.error('Gift code redeem failed:', error);
      await interaction.editReply('Gift code request failed due to a network or server error.');
    }
    return;
  }

  if (interaction.commandName === 'event') {
    const input = interaction.options.getString('name', true);
    const leader = isLeader(interaction.user.id);
    const event = await findEventForUser(input, leader);
    if (!event) {
      await interaction.reply({ content: `Event '${input}' not found.`, flags: MessageFlags.Ephemeral });
      return;
    }

    const reminders = await getReminders();
    const subscribed = Boolean(findSubscription(reminders, interaction.user.id, event.key));

    const remindButton = new ButtonBuilder()
      .setCustomId(`remind:${event.key}`)
      .setLabel(subscribed ? "Don't remind me" : 'Remind me')
      .setStyle(subscribed ? ButtonStyle.Danger : ButtonStyle.Primary);

    const infoButton = new ButtonBuilder().setCustomId(`info:${event.key}`).setLabel('Info').setStyle(ButtonStyle.Secondary);
    const row = new ActionRowBuilder().addComponents(remindButton, infoButton);
    if (leader) {
      row.addComponents(
        new ButtonBuilder().setCustomId(`allremind:${event.key}`).setLabel('Subscribe all members').setStyle(ButtonStyle.Primary)
      );
    }

    await interaction.reply({
      content: buildEventText(event, leader),
      components: [row],
      flags: MessageFlags.Ephemeral
    });
  }
}

async function showAddModal(interaction) {
  const modal = new ModalBuilder().setCustomId('modal:add').setTitle('Add Event');
  const keyInput = new TextInputBuilder().setCustomId('key').setLabel('Event key').setStyle(TextInputStyle.Short).setRequired(true);
  const dayInput = new TextInputBuilder().setCustomId('day').setLabel('Day (1-31)').setStyle(TextInputStyle.Short).setRequired(true);
  const monthInput = new TextInputBuilder().setCustomId('month').setLabel('Month (1-12)').setStyle(TextInputStyle.Short).setRequired(true);
  const hourInput = new TextInputBuilder().setCustomId('hour').setLabel('Hour (0-23)').setStyle(TextInputStyle.Short).setRequired(true);
  const minuteInput = new TextInputBuilder().setCustomId('minute').setLabel('Minute (0-59)').setStyle(TextInputStyle.Short).setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(keyInput),
    new ActionRowBuilder().addComponents(dayInput),
    new ActionRowBuilder().addComponents(monthInput),
    new ActionRowBuilder().addComponents(hourInput),
    new ActionRowBuilder().addComponents(minuteInput)
  );
  await interaction.showModal(modal);
}

async function showRemoveModal(interaction) {
  const modal = new ModalBuilder().setCustomId('modal:remove').setTitle('Remove Event');
  const keyInput = new TextInputBuilder().setCustomId('key').setLabel('Event key').setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(keyInput));
  await interaction.showModal(modal);
}

async function showEditFieldSelector(interaction) {
  const select = new StringSelectMenuBuilder()
    .setCustomId('leader:edit_field_select')
    .setPlaceholder('Select a field to edit')
    .addOptions([
      { label: 'Title', value: 'title' },
      { label: 'Description', value: 'description' },
      { label: 'Info', value: 'info' },
      { label: 'Next Time', value: 'nextAt' },
      { label: 'Repeat Hours', value: 'repeatHours' },
      { label: 'Remind Minutes Before', value: 'remindMinutesBefore' }
    ]);

  await interaction.reply({ content: 'Choose which field you want to edit:', components: [new ActionRowBuilder().addComponents(select)], flags: MessageFlags.Ephemeral });
}

async function showEditValueModal(interaction, field) {
  const modal = new ModalBuilder().setCustomId(`modal:edit_value:${field}`).setTitle(`Edit ${field}`);
  const keyInput = new TextInputBuilder().setCustomId('key').setLabel('Event key').setStyle(TextInputStyle.Short).setRequired(true);
  const valueInput = new TextInputBuilder().setCustomId('value').setLabel('New value').setStyle(TextInputStyle.Paragraph).setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(keyInput), new ActionRowBuilder().addComponents(valueInput));
  await interaction.showModal(modal);
}

async function showEditNextAtModal(interaction) {
  const modal = new ModalBuilder().setCustomId('modal:edit_nextAt').setTitle('Edit nextAt');
  const keyInput = new TextInputBuilder().setCustomId('key').setLabel('Event key').setStyle(TextInputStyle.Short).setRequired(true);
  const dayInput = new TextInputBuilder().setCustomId('day').setLabel('Day (1-31)').setStyle(TextInputStyle.Short).setRequired(true);
  const monthInput = new TextInputBuilder().setCustomId('month').setLabel('Month (1-12)').setStyle(TextInputStyle.Short).setRequired(true);
  const hourInput = new TextInputBuilder().setCustomId('hour').setLabel('Hour (0-23)').setStyle(TextInputStyle.Short).setRequired(true);
  const minuteInput = new TextInputBuilder().setCustomId('minute').setLabel('Minute (0-59)').setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(
    new ActionRowBuilder().addComponents(keyInput),
    new ActionRowBuilder().addComponents(dayInput),
    new ActionRowBuilder().addComponents(monthInput),
    new ActionRowBuilder().addComponents(hourInput),
    new ActionRowBuilder().addComponents(minuteInput)
  );
  await interaction.showModal(modal);
}

async function handleLeaderButton(interaction, action) {
  if (!isLeader(interaction.user.id)) {
    await interaction.reply({ content: 'Only leaders can use this action.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === 'add') return showAddModal(interaction);
  if (action === 'remove') return showRemoveModal(interaction);
  if (action === 'edit') return showEditFieldSelector(interaction);
}

async function handleSelectMenu(interaction) {
  if (interaction.customId !== 'leader:edit_field_select') return;
  if (!isLeader(interaction.user.id)) {
    await interaction.reply({ content: 'Only leaders can use this action.', flags: MessageFlags.Ephemeral });
    return;
  }

  const selectedField = interaction.values[0];
  if (selectedField === 'nextAt') return showEditNextAtModal(interaction);
  return showEditValueModal(interaction, selectedField);
}

async function subscribeAllMembersToEvent(interaction, eventKey) {
  if (!isLeader(interaction.user.id)) {
    await interaction.reply({ content: 'Only leaders can use this action.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: 'This action can only be used in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const event = await getEventByKey(eventKey);
  if (!event || !event.nextAt) {
    await interaction.reply({ content: 'Event or event time is missing.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const members = await interaction.guild.members.fetch();
  const memberIds = members
    .filter((member) => !member.user.bot)
    .map((member) => member.user.id);

  const reminders = await getReminders();
  let added = 0;
  let reactivated = 0;

  for (const userId of memberIds) {
    const existing = reminders.find((reminder) => reminder.userId === userId && reminder.eventKey === eventKey);

    if (existing) {
      if (existing.active === false) {
        existing.active = true;
        existing.channelId = reminderChannelId;
        existing.lastNotifiedOccurrenceMs = null;
        reactivated += 1;
      }
      continue;
    }

    reminders.push({
      userId,
      channelId: reminderChannelId,
      eventKey,
      active: true,
      lastNotifiedOccurrenceMs: null
    });
    added += 1;
  }

  if (added > 0 || reactivated > 0) await saveReminders(reminders);

  await interaction.editReply({
    content: `Subscribed ${added} members to '${event.title}'. Reactivated ${reactivated} existing unsubscribed members. Total server members checked: ${memberIds.length}.`
  });
}

async function handleButton(interaction) {
  const [action, eventKey] = interaction.customId.split(':');

  if (action === 'debugrole') {
    if (!isHardcodedLeader(interaction.user.id)) {
      await interaction.reply({ content: 'Only hardcoded leaders can use this debug action.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (debugMemberUserIds.has(interaction.user.id)) {
      debugMemberUserIds.delete(interaction.user.id);
    } else {
      debugMemberUserIds.add(interaction.user.id);
    }

    await interaction.update(buildHelpResponse(interaction.user.id));
    return;
  }

  if (action === 'allremind') return subscribeAllMembersToEvent(interaction, eventKey);

  if (action === 'unsub') {
    const reminders = await getReminders();
    const before = reminders.length;
    const next = reminders.filter((r) => !(r.userId === interaction.user.id && r.eventKey === eventKey && r.active !== false));
    if (before !== next.length) await saveReminders(next);

    await interaction.reply({
      content: before === next.length ? 'You were not subscribed to this event.' : `Unsubscribed from '${eventKey}' reminders.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action === 'leader') return handleLeaderButton(interaction, eventKey);

  const event = await getEventByKey(eventKey);

  if (action === 'info') {
    if (!event) {
      await interaction.reply({ content: 'Event not found.', flags: MessageFlags.Ephemeral });
      return;
    }

    const text = event.info || 'No extra info added for this event yet.';
    await interaction.reply({ content: text.length > 1900 ? text.slice(0, 1900) : text, flags: MessageFlags.Ephemeral });
    return;
  }

  if (action !== 'remind') return;
  if (!event || !event.nextAt) {
    await interaction.reply({ content: 'Event or event time is missing.', flags: MessageFlags.Ephemeral });
    return;
  }

  const reminders = await getReminders();
  const existing = findSubscription(reminders, interaction.user.id, eventKey);
  if (existing) {
    const next = reminders.filter((r) => !(r.userId === interaction.user.id && r.eventKey === eventKey));
    await saveReminders(next);
    await interaction.reply({ content: `You will not be reminded for ${event.title} anymore.`, flags: MessageFlags.Ephemeral });
    return;
  }

  reminders.push({
    userId: interaction.user.id,
    channelId: reminderChannelId,
    eventKey,
    active: true,
    lastNotifiedOccurrenceMs: null
  });
  await saveReminders(reminders);

  await interaction.reply({ content: `Reminder enabled. I will ping you every time for ${event.title}.`, flags: MessageFlags.Ephemeral });
}

async function handleAddModal(interaction) {
  const key = interaction.fields.getTextInputValue('key').trim().toLowerCase();
  const day = interaction.fields.getTextInputValue('day').trim();
  const month = interaction.fields.getTextInputValue('month').trim();
  const hour = interaction.fields.getTextInputValue('hour').trim();
  const minute = interaction.fields.getTextInputValue('minute').trim();

  if (!key) return interaction.reply({ content: 'Key is required.', flags: MessageFlags.Ephemeral });

  const nextAt = buildIsoFromParts(day, month, hour, minute);
  if (!nextAt) return interaction.reply({ content: 'Invalid day/month/hour/minute.', flags: MessageFlags.Ephemeral });

  const events = await getEvents();
  if (events.some((event) => event.key === key)) {
    await interaction.reply({ content: `Event '${key}' already exists.`, flags: MessageFlags.Ephemeral });
    return;
  }

  events.push({ key, title: key, description: '', info: '', nextAt, repeatHours: 0, remindMinutesBefore: 60 });
  await saveEvents(events);
  await interaction.reply({
    content: `Event '${key}' created.`,
    components: [buildSubscribeAllMembersRow(key)],
    flags: MessageFlags.Ephemeral
  });
}

async function handleRemoveModal(interaction) {
  const key = interaction.fields.getTextInputValue('key').trim().toLowerCase();
  const events = await getEvents();
  const next = events.filter((event) => event.key !== key);

  if (next.length === events.length) {
    await interaction.reply({ content: `Event '${key}' not found.`, flags: MessageFlags.Ephemeral });
    return;
  }

  await saveEvents(next);
  await interaction.reply({ content: `Event '${key}' removed.`, flags: MessageFlags.Ephemeral });
}

async function handleEditValueModal(interaction, field) {
  const key = interaction.fields.getTextInputValue('key').trim().toLowerCase();
  const value = interaction.fields.getTextInputValue('value').trim();

  const events = await getEvents();
  const event = events.find((item) => item.key === key);
  if (!event) {
    await interaction.reply({ content: `Event '${key}' not found.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (field === 'repeatHours' || field === 'remindMinutesBefore') {
    const num = Number(value);
    if (Number.isNaN(num)) {
      await interaction.reply({ content: `${field} must be a number.`, flags: MessageFlags.Ephemeral });
      return;
    }
    event[field] = num;
  } else {
    event[field] = value;
  }

  await saveEvents(events);
  await interaction.reply({ content: `Event '${key}' updated (${field}).`, flags: MessageFlags.Ephemeral });
}

async function handleEditNextAtModal(interaction) {
  const key = interaction.fields.getTextInputValue('key').trim().toLowerCase();
  const day = interaction.fields.getTextInputValue('day').trim();
  const month = interaction.fields.getTextInputValue('month').trim();
  const hour = interaction.fields.getTextInputValue('hour').trim();
  const minute = interaction.fields.getTextInputValue('minute').trim();

  const events = await getEvents();
  const event = events.find((item) => item.key === key);
  if (!event) {
    await interaction.reply({ content: `Event '${key}' not found.`, flags: MessageFlags.Ephemeral });
    return;
  }

  const nextAt = buildIsoFromParts(day, month, hour, minute);
  if (!nextAt) {
    await interaction.reply({ content: 'Invalid day/month/hour/minute.', flags: MessageFlags.Ephemeral });
    return;
  }

  event.nextAt = nextAt;
  await saveEvents(events);
  await interaction.reply({ content: `Event '${key}' updated (nextAt).`, flags: MessageFlags.Ephemeral });
}

async function handleModalSubmit(interaction) {
  if (!isLeader(interaction.user.id)) {
    await interaction.reply({ content: 'Only leaders can use this action.', flags: MessageFlags.Ephemeral });
    return;
  }

  const [prefix, action, field] = interaction.customId.split(':');
  if (prefix !== 'modal') return;
  if (action === 'add') return handleAddModal(interaction);
  if (action === 'remove') return handleRemoveModal(interaction);
  if (action === 'edit_nextAt') return handleEditNextAtModal(interaction);
  if (action === 'edit_value' && field) return handleEditValueModal(interaction, field);
}

async function processEventRollovers() {
  const events = await getEvents();
  const now = Date.now();
  let changed = false;

  for (const event of events) {
    const repeatHours = Number(event.repeatHours || 0);
    if (repeatHours <= 0 || !event.nextAt) continue;

    const nextMs = toEpochMs(event.nextAt);
    if (!nextMs || nextMs > now) continue;

    const repeatMs = repeatHours * 60 * 60 * 1000;
    const jumps = Math.floor((now - nextMs) / repeatMs) + 1;
    event.nextAt = new Date(nextMs + jumps * repeatMs).toISOString();
    changed = true;
  }

  if (changed) await saveEvents(events);
}

async function processReminders(botClient) {
  const reminders = await getReminders();
  if (reminders.length === 0) return;

  const now = Date.now();
  let changed = false;
  const batches = new Map();

  for (const reminder of reminders) {
    if (reminder.active === false) continue;

    const event = await getEventByKey(reminder.eventKey);
    if (!event) continue;

    const notify = getOccurrenceToNotify(event, now);
    if (!notify) continue;
    if (reminder.lastNotifiedOccurrenceMs === notify.occurrenceMs) continue;

    const batchKey = `${reminderChannelId}|${reminder.eventKey}|${notify.occurrenceMs}|${notify.remindMinutesBefore}`;
    if (!batches.has(batchKey)) {
      batches.set(batchKey, {
        channelId: reminderChannelId,
        eventKey: reminder.eventKey,
        eventTitle: event.title,
        remindMinutesBefore: notify.remindMinutesBefore,
        userIds: []
      });
    }

    batches.get(batchKey).userIds.push(reminder.userId);
    reminder.lastNotifiedOccurrenceMs = notify.occurrenceMs;
    changed = true;
  }

  for (const batch of batches.values()) {
    try {
      const channel = await botClient.channels.fetch(batch.channelId);
      if (!channel || !channel.isTextBased()) continue;

      const uniqueUserIds = [...new Set(batch.userIds)];
      const suffix = ` **${batch.eventTitle}** in ${batch.remindMinutesBefore} minutes`;
      const userIdChunks = chunkUserIdsForReminder(uniqueUserIds, suffix);

      for (const userIdChunk of userIdChunks) {
        const mentions = userIdChunk.map((id) => `<@${id}>`).join(' ');
        await channel.send({
          content: `${mentions}${suffix}`,
          allowedMentions: { users: userIdChunk },
          components: [buildReminderActionRow(batch.eventKey)]
        });
      }
    } catch (error) {
      console.error('Failed to send batch reminder:', error);
    }
  }

  if (changed) await saveReminders(reminders);
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return handleChatCommand(interaction);
    if (interaction.isButton()) return handleButton(interaction);
    if (interaction.isStringSelectMenu()) return handleSelectMenu(interaction);
    if (interaction.isModalSubmit()) return handleModalSubmit(interaction);
  } catch (error) {
    console.error('Interaction error:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: `Something went wrong: ${error.message || 'unknown error'}`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
});

setInterval(() => {
  processEventRollovers().catch((err) => console.error('Rollover error:', err));
  processReminders(client).catch((err) => console.error('Reminder loop error:', err));
}, 30 * 1000);

processEventRollovers().catch((err) => console.error('Initial rollover error:', err));

client.login(token);
