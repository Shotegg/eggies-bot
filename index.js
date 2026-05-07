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
  getEventDetailsByKey,
  saveEvents,
  getReminders,
  saveReminders
} = require('./storage');

const token = process.env.DISCORD_TOKEN;
const leaderIds = (process.env.LEADER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!token) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

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

  if ([day, month, hour, minute].some((v) => Number.isNaN(v))) {
    return null;
  }

  if (day < 1 || day > 31 || month < 1 || month > 12 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  const now = new Date();
  let year = now.getUTCFullYear();
  let date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  if (
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute
  ) {
    return null;
  }

  if (date.getTime() < now.getTime()) {
    year += 1;
    date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    if (
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      date.getUTCHours() !== hour ||
      date.getUTCMinutes() !== minute
    ) {
      return null;
    }
  }

  return date.toISOString();
}

function formatWhen(value) {
  if (!value) {
    return 'not set';
  }

  const epochMs = toEpochMs(value);
  if (!epochMs) {
    return `invalid date (${value})`;
  }

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
  const repeat = event.repeatHours
    ? `Every ${event.repeatHours} hours`
    : 'Not repeating';
  const remind = event.remindMinutesBefore ?? 60;
  return [
    showKey ? `**${event.title}** (${event.key})` : `**${event.title}**`,
    event.description || 'No description',
    `Next: ${formatWhen(event.nextAt)}`,
    `Repeat: ${repeat}`,
    `Reminder offset: ${remind} minutes before`
  ].join('\n');
}

function findEventForUser(input, isUserLeader) {
  const normalized = input.trim().toLowerCase();
  const events = getEvents();
  if (isUserLeader) {
    return events.find(
      (event) =>
        event.key.toLowerCase() === normalized ||
        event.title.toLowerCase() === normalized
    );
  }
  return events.find((event) => event.title.toLowerCase() === normalized);
}

function splitText(text, maxLen = 1900) {
  if (!text) {
    return [];
  }
  if (text.length <= maxLen) {
    return [text];
  }

  const parts = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let idx = remaining.lastIndexOf('\n', maxLen);
    if (idx < 1) {
      idx = maxLen;
    }
    parts.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  if (remaining.length > 0) {
    parts.push(remaining);
  }
  return parts;
}

function resolveInfoPayload(event, userLocale = 'en-US') {
  const details = getEventDetailsByKey(event.key);
  const baseLocale = (userLocale || 'en').split('-')[0].toLowerCase();
  const localeCandidates = [baseLocale, 'en', 'el'];

  if (details && details.locales) {
    const defaultLocale = details.defaultLocale || Object.keys(details.locales)[0];
    const pickedLocale = localeCandidates.find((loc) => details.locales[loc]) || defaultLocale;
    const entry = details.locales[pickedLocale];
    if (entry) {
      return {
        text: entry.text || '',
        images: Array.isArray(entry.images) ? entry.images : [],
        locale: pickedLocale,
        source: 'event-details.json'
      };
    }
  }

  return {
    text: event.info || '',
    images: [],
    locale: 'fallback',
    source: 'events.json'
  };
}

function isLeader(userId) {
  return leaderIds.includes(userId);
}

function findSubscription(reminders, userId, eventKey) {
  return reminders.find(
    (reminder) =>
      reminder.userId === userId &&
      reminder.eventKey === eventKey &&
      reminder.active !== false
  );
}

function getOccurrenceToNotify(event, nowMs) {
  const baseMs = toEpochMs(event.nextAt);
  if (!baseMs) {
    return null;
  }

  const remindMinutes = event.remindMinutesBefore ?? 60;
  const remindOffsetMs = remindMinutes * 60 * 1000;
  const repeatHours = Number(event.repeatHours || 0);
  const repeatMs = repeatHours > 0 ? repeatHours * 60 * 60 * 1000 : 0;

  if (repeatMs === 0) {
    const remindAtMs = baseMs - remindOffsetMs;
    if (nowMs >= remindAtMs) {
      return { occurrenceMs: baseMs, remindMinutesBefore: remindMinutes };
    }
    return null;
  }

  const firstRemindMs = baseMs - remindOffsetMs;
  if (nowMs < firstRemindMs) {
    return null;
  }

  const cycles = Math.floor((nowMs - firstRemindMs) / repeatMs);
  const occurrenceMs = baseMs + cycles * repeatMs;
  return { occurrenceMs, remindMinutesBefore: remindMinutes };
}

function normalizeReminders(reminders) {
  let changed = false;
  const normalized = reminders.map((reminder) => {
    const copy = { ...reminder };
    if (typeof copy.active !== 'boolean') {
      copy.active = copy.sent === true ? false : true;
      changed = true;
    }
    if (typeof copy.lastNotifiedOccurrenceMs !== 'number' && copy.lastNotifiedOccurrenceMs !== null) {
      copy.lastNotifiedOccurrenceMs = null;
      changed = true;
    }
    return copy;
  });
  return { normalized, changed };
}

function buildLeaderRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('leader:add').setLabel('Add').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('leader:remove').setLabel('Remove').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('leader:edit').setLabel('Edit').setStyle(ButtonStyle.Secondary)
  );
}

async function handleAutocomplete(interaction) {
  if (interaction.commandName !== 'event') {
    return;
  }

  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'name') {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.toLowerCase();
  const events = getEvents();
  const leader = isLeader(interaction.user.id);
  const matches = events
    .filter((event) =>
      leader
        ? (event.key.toLowerCase().includes(query) || event.title.toLowerCase().includes(query))
        : event.title.toLowerCase().includes(query)
    )
    .slice(0, 25)
    .map((event) => ({
      name: leader ? `${event.key} (${event.title})` : event.title,
      value: leader ? event.key : event.title
    }));

  await interaction.respond(matches);
}

async function handleChatCommand(interaction) {
  if (interaction.commandName === 'help') {
    await interaction.reply({
      content: [
        '**Available commands**',
        '`/help` show this message',
        '`/events` list saved events',
        '`/event name:<event_key>` show next time + repeat + actions',
        isLeader(interaction.user.id)
          ? 'Role: Leader (you can manage events from /events buttons)'
          : 'Role: Member'
      ].join('\n'),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.commandName === 'events') {
    const events = getEvents();
    const leader = isLeader(interaction.user.id);
    const lines = events.length === 0
      ? ['No saved events yet.']
      : events.map(leader ? formatEventLineForLeader : formatEventLine);

    const response = {
      content: ['**Saved events**', ...lines].join('\n'),
      flags: MessageFlags.Ephemeral
    };

    if (isLeader(interaction.user.id)) {
      response.components = [buildLeaderRow()];
    }

    await interaction.reply(response);
    return;
  }

  if (interaction.commandName === 'event') {
    const input = interaction.options.getString('name', true);
    const leader = isLeader(interaction.user.id);
    const event = findEventForUser(input, leader);
    if (!event) {
      await interaction.reply({
        content: `Event '${input}' not found.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const { normalized: reminders, changed: migrated } = normalizeReminders(getReminders());
    const subscribed = Boolean(
      findSubscription(reminders, interaction.user.id, event.key)
    );

    const remindButton = new ButtonBuilder()
      .setCustomId(`remind:${event.key}`)
      .setLabel(subscribed ? "Don't remind me" : 'Remind me')
      .setStyle(subscribed ? ButtonStyle.Danger : ButtonStyle.Primary);
    const infoButton = new ButtonBuilder()
      .setCustomId(`info:${event.key}`)
      .setLabel('Info')
      .setStyle(ButtonStyle.Secondary);

    const row = new ActionRowBuilder().addComponents(remindButton, infoButton);

    await interaction.reply({
      content: buildEventText(event, leader),
      components: [row],
      flags: MessageFlags.Ephemeral
    });
  }
}

async function showAddModal(interaction) {
  const modal = new ModalBuilder().setCustomId('modal:add').setTitle('Add Event');

  const keyInput = new TextInputBuilder()
    .setCustomId('key')
    .setLabel('Event key')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const dayInput = new TextInputBuilder()
    .setCustomId('day')
    .setLabel('Day (1-31)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const monthInput = new TextInputBuilder()
    .setCustomId('month')
    .setLabel('Month (1-12)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const hourInput = new TextInputBuilder()
    .setCustomId('hour')
    .setLabel('Hour (0-23)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const minuteInput = new TextInputBuilder()
    .setCustomId('minute')
    .setLabel('Minute (0-59)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

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

  const keyInput = new TextInputBuilder()
    .setCustomId('key')
    .setLabel('Event key')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

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

  const row = new ActionRowBuilder().addComponents(select);

  await interaction.reply({
    content: 'Choose which field you want to edit:',
    components: [row],
    flags: MessageFlags.Ephemeral
  });
}

async function showEditValueModal(interaction, field) {
  const modal = new ModalBuilder().setCustomId(`modal:edit_value:${field}`).setTitle(`Edit ${field}`);

  const keyInput = new TextInputBuilder()
    .setCustomId('key')
    .setLabel('Event key')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const valueInput = new TextInputBuilder()
    .setCustomId('value')
    .setLabel('New value')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(keyInput),
    new ActionRowBuilder().addComponents(valueInput)
  );

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
    await interaction.reply({
      content: 'Only leaders can use this action.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action === 'add') {
    await showAddModal(interaction);
    return;
  }

  if (action === 'remove') {
    await showRemoveModal(interaction);
    return;
  }

  if (action === 'edit') {
    await showEditFieldSelector(interaction);
  }
}

async function handleSelectMenu(interaction) {
  if (interaction.customId !== 'leader:edit_field_select') {
    return;
  }

  if (!isLeader(interaction.user.id)) {
    await interaction.reply({ content: 'Only leaders can use this action.', flags: MessageFlags.Ephemeral });
    return;
  }

  const selectedField = interaction.values[0];
  if (selectedField === 'nextAt') {
    await showEditNextAtModal(interaction);
    return;
  }

  await showEditValueModal(interaction, selectedField);
}

async function handleButton(interaction) {
  const [action, eventKey] = interaction.customId.split(':');

  if (action === 'unsub') {
    const { normalized: reminders, changed: migrated } = normalizeReminders(getReminders());
    const before = reminders.length;
    const next = reminders.filter(
      (reminder) =>
        !(
          reminder.userId === interaction.user.id &&
          reminder.eventKey === eventKey &&
          reminder.active !== false
        )
    );
    if (migrated || before !== next.length) {
      saveReminders(next);
    }

    await interaction.reply({
      content:
        before === next.length
          ? 'You were not subscribed to this event.'
          : `Unsubscribed from '${eventKey}' reminders.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (action === 'leader') {
    await handleLeaderButton(interaction, eventKey);
    return;
  }

  const event = getEventByKey(eventKey);

  if (action === 'info') {
    if (!event) {
      await interaction.reply({
        content: 'Event not found.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const payload = resolveInfoPayload(event, interaction.locale);
    const textParts = splitText(payload.text);

    if (textParts.length === 0 && payload.images.length === 0) {
      await interaction.reply({
        content: 'No extra info added for this event yet.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    await interaction.reply({
      content: textParts[0] || `Info locale: ${payload.locale} (${payload.source})`,
      flags: MessageFlags.Ephemeral
    });

    for (let i = 1; i < textParts.length; i += 1) {
      await interaction.followUp({
        content: textParts[i],
        flags: MessageFlags.Ephemeral
      });
    }

    for (const imageUrl of payload.images) {
      await interaction.followUp({
        content: imageUrl,
        flags: MessageFlags.Ephemeral
      });
    }
    return;
  }

  if (action !== 'remind') {
    return;
  }

  if (!event || !event.nextAt) {
    await interaction.reply({
      content: 'Event or event time is missing.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const { normalized: reminders } = normalizeReminders(getReminders());
  const existing = findSubscription(reminders, interaction.user.id, eventKey);
  if (existing) {
    const next = reminders.filter((reminder) => reminder !== existing);
    saveReminders(next);
    await interaction.reply({
      content: `You will not be reminded for ${event.title} anymore.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  reminders.push({
    userId: interaction.user.id,
    channelId: interaction.channelId,
    eventKey,
    active: true,
    lastNotifiedOccurrenceMs: null
  });
  saveReminders(reminders);

  await interaction.reply({
    content: `Reminder enabled. I will ping you every time for ${event.title}.`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleAddModal(interaction) {
  const key = interaction.fields.getTextInputValue('key').trim().toLowerCase();
  const day = interaction.fields.getTextInputValue('day').trim();
  const month = interaction.fields.getTextInputValue('month').trim();
  const hour = interaction.fields.getTextInputValue('hour').trim();
  const minute = interaction.fields.getTextInputValue('minute').trim();

  if (!key) {
    await interaction.reply({ content: 'Key is required.', flags: MessageFlags.Ephemeral });
    return;
  }

  const nextAt = buildIsoFromParts(day, month, hour, minute);
  if (!nextAt) {
    await interaction.reply({ content: 'Invalid day/month/hour/minute.', flags: MessageFlags.Ephemeral });
    return;
  }

  const events = getEvents();
  if (events.some((event) => event.key === key)) {
    await interaction.reply({ content: `Event '${key}' already exists.`, flags: MessageFlags.Ephemeral });
    return;
  }

  events.push({
    key,
    title: key,
    description: '',
    info: '',
    nextAt,
    repeatHours: 0,
    remindMinutesBefore: 60
  });
  saveEvents(events);

  await interaction.reply({
    content: `Event '${key}' created. Default values: title='${key}', repeatHours=0, remindMinutesBefore=60.`,
    flags: MessageFlags.Ephemeral
  });
}

async function handleRemoveModal(interaction) {
  const key = interaction.fields.getTextInputValue('key').trim().toLowerCase();
  const events = getEvents();
  const next = events.filter((event) => event.key !== key);

  if (next.length === events.length) {
    await interaction.reply({ content: `Event '${key}' not found.`, flags: MessageFlags.Ephemeral });
    return;
  }

  saveEvents(next);
  await interaction.reply({ content: `Event '${key}' removed.`, flags: MessageFlags.Ephemeral });
}

async function handleEditValueModal(interaction, field) {
  const key = interaction.fields.getTextInputValue('key').trim().toLowerCase();
  const value = interaction.fields.getTextInputValue('value').trim();

  const events = getEvents();
  const event = events.find((item) => item.key === key);
  if (!event) {
    await interaction.reply({ content: `Event '${key}' not found.`, flags: MessageFlags.Ephemeral });
    return;
  }

  if (field === 'repeatHours' || field === 'remindMinutesBefore') {
    const numberValue = Number(value);
    if (Number.isNaN(numberValue)) {
      await interaction.reply({ content: `${field} must be a number.`, flags: MessageFlags.Ephemeral });
      return;
    }
    event[field] = numberValue;
  } else {
    event[field] = value;
  }

  saveEvents(events);
  await interaction.reply({ content: `Event '${key}' updated (${field}).`, flags: MessageFlags.Ephemeral });
}

async function handleEditNextAtModal(interaction) {
  const key = interaction.fields.getTextInputValue('key').trim().toLowerCase();
  const day = interaction.fields.getTextInputValue('day').trim();
  const month = interaction.fields.getTextInputValue('month').trim();
  const hour = interaction.fields.getTextInputValue('hour').trim();
  const minute = interaction.fields.getTextInputValue('minute').trim();

  const events = getEvents();
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
  saveEvents(events);
  await interaction.reply({ content: `Event '${key}' updated (nextAt).`, flags: MessageFlags.Ephemeral });
}

async function handleModalSubmit(interaction) {
  if (!isLeader(interaction.user.id)) {
    await interaction.reply({
      content: 'Only leaders can use this action.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const [prefix, action, field] = interaction.customId.split(':');
  if (prefix !== 'modal') {
    return;
  }

  if (action === 'add') {
    await handleAddModal(interaction);
    return;
  }

  if (action === 'remove') {
    await handleRemoveModal(interaction);
    return;
  }

  if (action === 'edit_nextAt') {
    await handleEditNextAtModal(interaction);
    return;
  }

  if (action === 'edit_value' && field) {
    await handleEditValueModal(interaction, field);
  }
}

async function processReminders(botClient) {
  const { normalized: reminders, changed: migrated } = normalizeReminders(getReminders());
  if (reminders.length === 0) {
    if (migrated) {
      saveReminders(reminders);
    }
    return;
  }

  const now = Date.now();
  let changed = false;
  const batches = new Map();

  for (const reminder of reminders) {
    if (reminder.active === false) {
      continue;
    }
    const event = getEventByKey(reminder.eventKey);
    if (!event) {
      continue;
    }
    const notify = getOccurrenceToNotify(event, now);
    if (!notify) {
      continue;
    }
    if (reminder.lastNotifiedOccurrenceMs === notify.occurrenceMs) {
      continue;
    }

    const batchKey = `${reminder.channelId}|${reminder.eventKey}|${notify.occurrenceMs}|${notify.remindMinutesBefore}`;
    if (!batches.has(batchKey)) {
      batches.set(batchKey, {
        channelId: reminder.channelId,
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
      if (!channel || !channel.isTextBased()) {
        continue;
      }
      const mentions = [...new Set(batch.userIds)].map((id) => `<@${id}>`).join(' ');
      const unsubscribeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`unsub:${batch.eventKey}`)
          .setLabel("Don't remind me")
          .setStyle(ButtonStyle.Danger)
      );
      await channel.send({
        content: `${mentions} **${batch.eventTitle}** in ${batch.remindMinutesBefore} minutes`,
        components: [unsubscribeRow]
      });
    } catch (error) {
      console.error('Failed to send batch reminder:', error);
    }
  }

  if (changed || migrated) {
    saveReminders(reminders);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      await handleChatCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
    }
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
  processReminders(client);
}, 30 * 1000);

client.login(token);
