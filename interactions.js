const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const { getEvents, getEventByKey, saveEvents, getReminders, deleteRemindersForUser, saveReminders, getGiftCodePlayers, getGiftCodePlayersForKingdom, getGiftCodePlayer, deleteGiftCodePlayer, getLatestKingdomSnapshot, saveKingdomSnapshot, upsertGiftCodes } = require('./storage');
const { getCurrentMemberSnapshot } = require('./memberSnapshots');

function createInteractions({ leaderRoleId, snapshotUserId, snapshotKingdomId, reminderChannelId, defaultGiftCodeKingdomId, toEpochMs, formatPower, saveGiftCodePlayerKingdom, redeemCodeForPlayer, syncGiftCodes, startGiftCodeWorker, maybeScanGiftCodesInBackground, isGiftCodeWorkerRunning, giftCodeRetryDelayMs, giftCodeFailedRetryCooldownMs }) {
const debugMemberUserIds = new Set();
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
    new ButtonBuilder().setCustomId(`sub:${eventKey}`).setLabel('Remind me').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`unsub:${eventKey}`).setLabel("Don't remind me").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`info:${eventKey}`).setLabel('Info').setStyle(ButtonStyle.Secondary)
  );
}

function buildSubscribeAllMembersRow(eventKey) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`allremind:${eventKey}`).setLabel('Subscribe all members').setStyle(ButtonStyle.Primary)
  );
}

function hasLeaderRole(interaction) {
  const roles = interaction.member?.roles;
  return Boolean(leaderRoleId && (Array.isArray(roles) ? roles.includes(leaderRoleId) : roles?.cache?.has(leaderRoleId)));
}

function isLeader(interaction) {
  return hasLeaderRole(interaction) && !debugMemberUserIds.has(interaction.user.id);
}

function buildHelpContent(interaction) {
  return [
    '**Available commands**',
    '`/help` show this message',
    '`/events` list saved events',
    '`/event name:<event title>` show next time + actions',
    '`/giftcode run [player_id] [code] [kingdom]` sync/redeem active Kingshot gift codes',
    '`/giftcode list` list saved gift code players',
    isLeader(interaction) ? '`/clear` remove reminder subscriptions for users who left the server' : null,
    isLeader(interaction) ? 'Role: Leader' : 'Role: Member'
  ].filter(Boolean).join('\n');
}

function formatGiftCodeSyncResult(result) {
  if (!result.ok) {
    const errCode = result.player?.data?.err_code;
    return [`Status: ${result.message}`, errCode ? `Error code: ${errCode}` : null].filter(Boolean).join('\n');
  }

  const successes = result.attempted.filter((item) => item.ok);
  const failures = result.attempted.filter((item) => !item.ok);
  const byMessage = new Map();
  for (const item of failures) {
    byMessage.set(item.message, (byMessage.get(item.message) || 0) + 1);
  }
  const lines = [
    result.player
      ? `Saved player: ${result.player.nickname || 'Unknown'} (${result.player.playerId}) | State: ${result.player.kid || 'unknown'} | Town Center: ${result.player.stoveLv || 'unknown'}`
      : 'Processing saved players.',
    `Active codes found: ${result.discoveredCodes.map((item) => item.code).join(', ') || 'none'}`,
    `Queued pending redemptions: ${result.pending}`,
    `Skipped saved results: ${Array.isArray(result.skipped) ? result.skipped.length : result.skipped}`,
    `Background worker: ${isGiftCodeWorkerRunning() ? 'already running' : 'started'} | Delay: ${Math.round(giftCodeRetryDelayMs / 1000)}s/request | Failed retry cooldown: ${Math.round(giftCodeFailedRetryCooldownMs / 60000)}m`
  ];

  if (successes.length > 0) {
    const successCodes = [...new Set(successes.map((item) => item.code))].join(', ');
    lines.push(`Successful codes: ${successCodes}`);
  }

  if (byMessage.size > 0) {
    lines.push('Failure summary:');
    for (const [message, count] of byMessage) {
      lines.push(`- ${message}: ${count}`);
    }
  }

  return lines.join('\n');
}

function chunkLines(header, lines, maxLength = 1900) {
  const chunks = [];
  let current = header;

  for (const line of lines) {
    const next = `${current}\n${line}`;
    if (next.length > maxLength && current !== header) {
      chunks.push(current);
      current = `${header}\n${line}`;
    } else {
      current = next;
    }
  }

  chunks.push(current);
  return chunks;
}

function formatSnapshotPlayer(player) {
  const name = player.nickname || 'Unknown';
  const alliance = player.allianceTag || player.allianceName || 'No alliance';
  return `- ${name} | ${player.playerId} | ${alliance}`;
}

function buildSnapshotReport(previousSnapshot, currentPlayers) {
  if (!previousSnapshot) {
    return [`Kingdom ${snapshotKingdomId} snapshot saved with ${currentPlayers.length} players. This is the baseline; the next snapshot will report arrivals and departures.`];
  }

  const previousById = new Map(previousSnapshot.players.map((player) => [String(player.player_id), player]));
  const currentById = new Map(currentPlayers.map((player) => [String(player.playerId), player]));
  const arrivals = currentPlayers.filter((player) => !previousById.has(String(player.playerId)));
  const departures = previousSnapshot.players.filter((player) => !currentById.has(String(player.player_id)));
  const header = `**Kingdom ${snapshotKingdomId} snapshot report**\nCurrent players: ${currentPlayers.length} | New: ${arrivals.length} | Left: ${departures.length}`;
  const lines = [
    '**New arrivals**',
    ...(arrivals.length > 0 ? arrivals.map(formatSnapshotPlayer) : ['- None']),
    '**Departures**',
    ...(departures.length > 0 ? departures.map((player) => formatSnapshotPlayer({ ...player, playerId: player.player_id })) : ['- None'])
  ];
  return chunkLines(header, lines);
}

async function replySnapshotReport(interaction, messages) {
  await interaction.editReply(messages[0]);
  for (const message of messages.slice(1)) {
    await interaction.followUp(message);
  }
}

function formatGiftCodePlayerLines(players) {
  return players
    .slice()
    .sort((a, b) => (a.nickname || '').localeCompare(b.nickname || '') || String(a.playerId).localeCompare(String(b.playerId)))
    .map((player) => `${player.nickname || 'Unknown'} - ${player.playerId}`);
}

function buildGiftCodePlayerListRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('giftplayer:remove').setLabel('Browse players').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('giftplayer:search').setLabel('Search player').setStyle(ButtonStyle.Secondary)
  );
}

function getGiftCodePlayerPage(players, page) {
  const pageSize = 25;
  const pageCount = Math.max(1, Math.ceil(players.length / pageSize));
  const safePage = Math.max(0, Math.min(page, pageCount - 1));
  return {
    players: players.slice(safePage * pageSize, (safePage + 1) * pageSize),
    page: safePage,
    pageCount
  };
}

function buildGiftCodePlayerRemovalComponents(players, page = 0) {
  const selection = getGiftCodePlayerPage(players, page);
  const options = selection.players.map((player) => ({
    label: `${player.nickname || 'Unknown'} (${player.playerId})`.slice(0, 100),
    description: `Kingdom ${player.kid || 'unknown'}${player.power == null ? '' : ` • ${formatPower(player.power)} power`}`.slice(0, 100),
    value: String(player.playerId)
  }));
  const select = new StringSelectMenuBuilder()
    .setCustomId(`giftplayer:select:${selection.page}`)
    .setPlaceholder(`Choose a player to remove (${selection.page + 1}/${selection.pageCount})`)
    .addOptions(options);
  const components = [new ActionRowBuilder().addComponents(select)];

  if (selection.pageCount > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`giftplayer:page:${selection.page - 1}`)
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(selection.page === 0),
      new ButtonBuilder()
        .setCustomId(`giftplayer:page:${selection.page + 1}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(selection.page >= selection.pageCount - 1)
    ));
  }
  return components;
}

function buildGiftCodePlayerSearchComponents(players) {
  const options = players.slice(0, 25).map((player) => ({
    label: `${player.nickname || 'Unknown'} (${player.playerId})`.slice(0, 100),
    description: `Kingdom ${player.kid || 'unknown'}${player.power == null ? '' : ` • ${formatPower(player.power)} power`}`.slice(0, 100),
    value: String(player.playerId)
  }));
  const select = new StringSelectMenuBuilder()
    .setCustomId('giftplayer:selectsearch')
    .setPlaceholder('Choose the player to remove')
    .addOptions(options);
  return [new ActionRowBuilder().addComponents(select)];
}

function showGiftCodePlayerSearchModal(interaction) {
  const modal = new ModalBuilder().setCustomId('giftplayer:searchmodal').setTitle('Search gift code player');
  const queryInput = new TextInputBuilder()
    .setCustomId('query')
    .setLabel('Player name or Player ID')
    .setPlaceholder('Example: Shotegg or 123456789')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);
  modal.addComponents(new ActionRowBuilder().addComponents(queryInput));
  return interaction.showModal(modal);
}

async function replyGiftCodePlayerList(interaction) {
  const players = await getGiftCodePlayers();
  if (players.length === 0) {
    await interaction.editReply('No saved gift code players.');
    return;
  }

  const header = `Saved gift code players (${players.length})`;
  const chunks = chunkLines(header, formatGiftCodePlayerLines(players));
  await interaction.editReply({
    content: chunks[0],
    components: isLeader(interaction) ? [buildGiftCodePlayerListRow()] : []
  });
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
  }
}

function buildDebugRoleRow(interaction) {
  const nextRole = isLeader(interaction) ? 'Member' : 'Leader';
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('debugrole:toggle').setLabel(`View as ${nextRole}`).setStyle(ButtonStyle.Secondary)
  );
}

function buildHelpResponse(interaction) {
  const response = {
    content: buildHelpContent(interaction),
    flags: MessageFlags.Ephemeral
  };

  if (hasLeaderRole(interaction)) {
    response.components = [buildDebugRoleRow(interaction)];
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
  const leader = isLeader(interaction);
  const matches = events
    .filter((event) => (leader ? event.key.toLowerCase().includes(query) || event.title.toLowerCase().includes(query) : event.title.toLowerCase().includes(query)))
    .slice(0, 25)
    .map((event) => ({ name: leader ? `${event.key} (${event.title})` : event.title, value: leader ? event.key : event.title }));

  await interaction.respond(matches);
}

async function handleChatCommand(interaction) {
  if (interaction.commandName === 'clear') {
    if (!isLeader(interaction)) {
      await interaction.reply({ content: 'Only leaders can use this command.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!interaction.inGuild()) {
      await interaction.reply({ content: 'This command can only be used in the server.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const snapshot = await getCurrentMemberSnapshot(interaction.guild);
      const members = new Set(snapshot.members.map((member) => member.id));
      const reminders = await getReminders();
      const missingIds = [...new Set(reminders.map((reminder) => reminder.userId))]
        .filter((userId) => !members.has(userId));
      const departedIds = [];
      for (const userId of missingIds) {
        try {
          await interaction.guild.members.fetch({ user: userId, force: true });
        } catch (error) {
          if (error.code !== 10007) throw error;
          departedIds.push(userId);
        }
      }
      let count = 0;
      for (const userId of departedIds) count += await deleteRemindersForUser(userId);
      await interaction.editReply(`Removed ${count} reminder subscription(s) for ${departedIds.length} user(s) who left the server.`);
    } catch (error) {
      console.error('Failed to clear reminder subscriptions:', error);
      await interaction.editReply('Could not complete the cleanup. Some subscriptions may already have been removed; please try again.');
    }
    return;
  }

  if (interaction.commandName === 'help') {
    await interaction.reply(buildHelpResponse(interaction));
    return;
  }

  if (interaction.commandName === 'events') {
    maybeScanGiftCodesInBackground('events-command');
    const events = await getEvents();
    const leader = isLeader(interaction);
    const lines = events.length === 0 ? ['No saved events yet.'] : events.map(leader ? formatEventLineForLeader : formatEventLine);

    const response = {
      content: ['**Saved events**', ...lines].join('\n'),
      flags: MessageFlags.Ephemeral
    };

    if (leader) response.components = [buildLeaderRow()];
    await interaction.reply(response);
    return;
  }

  if (interaction.commandName === 'snapshot') {
    if (interaction.user.id !== snapshotUserId) {
      await interaction.reply({ content: 'You are not allowed to run snapshots.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply();
    try {
      const [previousSnapshot, currentPlayers] = await Promise.all([
        getLatestKingdomSnapshot(snapshotKingdomId),
        getGiftCodePlayersForKingdom(snapshotKingdomId)
      ]);
      await saveKingdomSnapshot(snapshotKingdomId, currentPlayers);
      await replySnapshotReport(interaction, buildSnapshotReport(previousSnapshot, currentPlayers));
    } catch (error) {
      console.error('Kingdom snapshot failed:', error);
      await interaction.editReply('Could not save the kingdom snapshot. Check the Supabase snapshot tables and try again.');
    }
    return;
  }

  if (interaction.commandName === 'giftcode') {
    const subcommand = interaction.options.getSubcommand(false);
    const playerId = interaction.options.getString('player_id', false)?.trim();
    const code = interaction.options.getString('code', false)?.trim();
    const kingdom = interaction.options.getInteger('kingdom', false) || defaultGiftCodeKingdomId;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (subcommand === 'list') {
        await replyGiftCodePlayerList(interaction);
        return;
      }

      if (!code) {
        const result = await syncGiftCodes(playerId, kingdom);
        await interaction.editReply(formatGiftCodeSyncResult(result));
        return;
      }

      if (!playerId) {
        await upsertGiftCodes([{ code, source: 'manual-command', expiresAt: null, active: true }]);
        startGiftCodeWorker();
        await interaction.editReply(`Saved code ${code} and started background redeem for saved players.`);
        return;
      }

      await upsertGiftCodes([{ code, source: 'manual-command', expiresAt: null, active: true }]);
      const player = await saveGiftCodePlayerKingdom(playerId, kingdom);

      const result = await redeemCodeForPlayer(player, code);
      const playerLine = `Player: ${player.nickname || 'Unknown'} (${player.playerId}) | State: ${player.kid || 'unknown'} | Town Center: ${player.stoveLv || 'unknown'}`;
      const raw = result.redeem?.data || result.player?.data;
      const statusLine = result.ok ? 'Status: Redeemed successfully.' : `Status: ${result.message}`;
      const codeLine = !result.ok && raw?.err_code ? `Error code: ${raw.err_code}` : null;

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
    const leader = isLeader(interaction);
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
  if (!isLeader(interaction)) {
    await interaction.reply({ content: 'Only leaders can use this action.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (action === 'add') return showAddModal(interaction);
  if (action === 'remove') return showRemoveModal(interaction);
  if (action === 'edit') return showEditFieldSelector(interaction);
}

async function handleSelectMenu(interaction) {
  if (interaction.customId.startsWith('giftplayer:select')) {
    if (!isLeader(interaction)) {
      await interaction.reply({ content: 'Only leaders can remove gift code players.', flags: MessageFlags.Ephemeral });
      return;
    }

    const page = Number(interaction.customId.split(':')[2]) || 0;
    const playerId = interaction.values[0];
    const player = await getGiftCodePlayer(playerId);
    if (!player) {
      await interaction.update({ content: 'That player no longer exists.', components: [] });
      return;
    }

    const confirmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`giftplayerconfirm:yes:${player.playerId}`).setLabel('Yes, remove').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`giftplayerconfirm:cancel:${page}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    );
    await interaction.update({
      content: `Remove **${player.nickname || 'Unknown'}** (${player.playerId})? Their saved gift-code redemption history will also be deleted.`,
      components: [confirmRow]
    });
    return;
  }

  if (interaction.customId !== 'leader:edit_field_select') return;
  if (!isLeader(interaction)) {
    await interaction.reply({ content: 'Only leaders can use this action.', flags: MessageFlags.Ephemeral });
    return;
  }

  const selectedField = interaction.values[0];
  if (selectedField === 'nextAt') return showEditNextAtModal(interaction);
  return showEditValueModal(interaction, selectedField);
}

async function subscribeAllMembersToEvent(interaction, eventKey) {
  if (!isLeader(interaction)) {
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

  const snapshot = await getCurrentMemberSnapshot(interaction.guild);
  const memberIds = snapshot.members.filter((member) => !member.bot).map((member) => member.id);

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

  if (action === 'giftplayer') {
    if (!isLeader(interaction)) {
      await interaction.reply({ content: 'Only leaders can remove gift code players.', flags: MessageFlags.Ephemeral });
      return;
    }

    const playerAction = eventKey;
    if (playerAction === 'remove') {
      const players = await getGiftCodePlayers();
      if (players.length === 0) {
        await interaction.update({ content: 'No saved gift code players.', components: [] });
        return;
      }
      await interaction.update({
        content: 'Choose the player to remove:',
        components: buildGiftCodePlayerRemovalComponents(players)
      });
      return;
    }

    if (playerAction === 'search') {
      await showGiftCodePlayerSearchModal(interaction);
      return;
    }

    if (playerAction === 'page') {
      const page = Number(interaction.customId.split(':')[2]) || 0;
      const players = await getGiftCodePlayers();
      await interaction.update({
        content: 'Choose the player to remove:',
        components: buildGiftCodePlayerRemovalComponents(players, page)
      });
      return;
    }
  }

  if (action === 'giftplayerconfirm') {
    if (!isLeader(interaction)) {
      await interaction.reply({ content: 'Only leaders can remove gift code players.', flags: MessageFlags.Ephemeral });
      return;
    }

    const [, confirmation, value] = interaction.customId.split(':');
    if (confirmation === 'cancel') {
      const players = await getGiftCodePlayers();
      await interaction.update({
        content: 'Choose the player to remove:',
        components: buildGiftCodePlayerRemovalComponents(players, Number(value) || 0)
      });
      return;
    }

    if (confirmation === 'yes') {
      const player = await getGiftCodePlayer(value);
      if (!player) {
        await interaction.update({ content: 'That player was already removed.', components: [] });
        return;
      }
      await deleteGiftCodePlayer(value);
      await interaction.update({ content: `Removed **${player.nickname || 'Unknown'}** (${player.playerId}).`, components: [] });
      return;
    }
  }

  if (action === 'debugrole') {
    if (!hasLeaderRole(interaction)) {
      await interaction.reply({ content: 'Only leaders can use this debug action.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (debugMemberUserIds.has(interaction.user.id)) {
      debugMemberUserIds.delete(interaction.user.id);
    } else {
      debugMemberUserIds.add(interaction.user.id);
    }

    await interaction.update(buildHelpResponse(interaction));
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

  if (action === 'sub') {
    const event = await getEventByKey(eventKey);
    if (!event || !event.nextAt) {
      await interaction.reply({ content: 'Event or event time is missing.', flags: MessageFlags.Ephemeral });
      return;
    }

    const reminders = await getReminders();
    const existing = reminders.find((r) => r.userId === interaction.user.id && r.eventKey === eventKey);

    if (existing) {
      if (existing.active !== false) {
        await interaction.reply({ content: `You are already subscribed to ${event.title}.`, flags: MessageFlags.Ephemeral });
        return;
      }

      existing.active = true;
      existing.channelId = reminderChannelId;
      existing.lastNotifiedOccurrenceMs = null;
      await saveReminders(reminders);
      await interaction.reply({ content: `Reminder enabled. I will ping you every time for ${event.title}.`, flags: MessageFlags.Ephemeral });
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
  if (interaction.customId === 'giftplayer:searchmodal') {
    if (!isLeader(interaction)) {
      await interaction.reply({ content: 'Only leaders can remove gift code players.', flags: MessageFlags.Ephemeral });
      return;
    }

    const query = interaction.fields.getTextInputValue('query').trim().toLowerCase();
    const matches = (await getGiftCodePlayers()).filter((player) => (
      String(player.playerId).includes(query) || (player.nickname || '').toLowerCase().includes(query)
    ));
    if (matches.length === 0) {
      await interaction.reply({ content: 'No saved player matches that name or ID.', flags: MessageFlags.Ephemeral });
      return;
    }

    const resultNote = matches.length > 25 ? ` Found ${matches.length}; showing the first 25—please refine your search.` : '';
    await interaction.reply({
      content: `Choose the player to remove.${resultNote}`,
      components: buildGiftCodePlayerSearchComponents(matches),
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (!isLeader(interaction)) {
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


return { buildReminderActionRow, handleAutocomplete, handleChatCommand, handleButton, handleSelectMenu, handleModalSubmit };
}

module.exports = { createInteractions };
