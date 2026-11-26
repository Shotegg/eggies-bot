require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags
} = require('discord.js');
const { getEvents, saveEvents, getReminders, markRemindersNotified } = require('./storage');
const { startKeepAlive } = require('./keepAlive');
const { deliverReminders, getOccurrenceToNotify } = require('./reminderDelivery');
const { scheduleMemberSnapshotRefresh } = require('./memberSnapshots');
const { createInteractions } = require('./interactions');
const { createMightPulseTasks } = require('./mightPulseTasks');
const { createGiftCodeWorker } = require('./giftCodeWorker');
const { getAllianceTags } = require('./allianceTags');

const token = process.env.DISCORD_TOKEN;
const reminderChannelId = process.env.REMINDER_CHANNEL_ID || '1501304144139653193';
const guildId = process.env.GUILD_ID;
const giftCodeNotifyChannelId = process.env.GIFT_CODE_NOTIFY_CHANNEL_ID || '';
const leaderRoleId = '1493344291358118058';
const snapshotUserId = '612726128137863169';
const snapshotKingdomId = 342;
const giftCodeTerminalStatuses = new Set([
  'success',
  'already_redeemed',
  'expired',
  'claim_limit_reached',
  'invalid_code',
  'requirements_unmet',
  'town_center_too_low',
  'account_age_unmet',
  'prerequisite_unmet',
  'same_type_redeemed',
  'missing_kingdom_id'
]);
const giftCodeRetryDelayMs = Number(process.env.GIFT_CODE_RETRY_DELAY_MS || 45000);
const giftCodeFailedRetryCooldownMs = Number(process.env.GIFT_CODE_FAILED_RETRY_COOLDOWN_MS || 1800000);
const giftCodeAutoScanIntervalMs = Number(process.env.GIFT_CODE_AUTO_SCAN_INTERVAL_MS || 3600000);
const giftCodeCleanupAfterDays = Number(process.env.GIFT_CODE_CLEANUP_AFTER_DAYS || 14);
const defaultGiftCodeKingdomId = Number(process.env.GIFT_CODE_DEFAULT_KINGDOM_ID || 342);
const reminderMinPollIntervalMs = Number(process.env.REMINDER_MIN_POLL_INTERVAL_MS || 30000);
const reminderMaxPollIntervalMs = Number(process.env.REMINDER_MAX_POLL_INTERVAL_MS || 900000);
const reminderWakeBufferMs = Number(process.env.REMINDER_WAKE_BUFFER_MS || 5000);
const giftCodeDebug = process.env.GIFT_CODE_DEBUG === 'true';
const mightPulseApiKey = (process.env.MIGHTPULSE_API_KEY || '').trim();
const mightPulseAllianceKingdomId = Number(process.env.MIGHTPULSE_ALLIANCE_KINGDOM_ID || 342);
// The primary alliance remains the source for weekly reports.
const mightPulseAllianceTag = (process.env.MIGHTPULSE_ALLIANCE_TAG || 'EGG').trim();
// Each alliance is fetched with its own single roster request. Keep EGG first so
// existing weekly-report behavior continues to use it as the primary alliance.
const mightPulseGiftCodeAllianceTags = getAllianceTags(mightPulseAllianceTag, process.env.MIGHTPULSE_GIFTCODE_ALLIANCE_TAGS);
const mightPulseWeeklyReportChannelId = (process.env.MIGHTPULSE_WEEKLY_REPORT_CHANNEL_ID || giftCodeNotifyChannelId || '').trim();
const mightPulseRecoveryCheckIntervalMs = Number(process.env.MIGHTPULSE_RECOVERY_CHECK_INTERVAL_MS || 7200000);

if (!token) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const { scheduleMightPulseTasks, formatPower } = createMightPulseTasks({ client, mightPulseApiKey, mightPulseAllianceKingdomId, mightPulseAllianceTag, mightPulseGiftCodeAllianceTags, mightPulseWeeklyReportChannelId, mightPulseRecoveryCheckIntervalMs });
const { saveGiftCodePlayerKingdom, redeemCodeForPlayer, syncGiftCodes, startGiftCodeWorker, maybeScanGiftCodesInBackground, scheduleGiftCodeAutoScan, isGiftCodeWorkerRunning } = createGiftCodeWorker({ client, giftCodeTerminalStatuses, giftCodeRetryDelayMs, giftCodeFailedRetryCooldownMs, giftCodeAutoScanIntervalMs, giftCodeCleanupAfterDays, defaultGiftCodeKingdomId, giftCodeDebug, giftCodeNotifyChannelId });
const { buildReminderActionRow, handleAutocomplete, handleChatCommand, handleButton, handleSelectMenu, handleModalSubmit } = createInteractions({ leaderRoleId, snapshotUserId, snapshotKingdomId, reminderChannelId, defaultGiftCodeKingdomId, toEpochMs, formatPower, saveGiftCodePlayerKingdom, redeemCodeForPlayer, syncGiftCodes, startGiftCodeWorker, maybeScanGiftCodesInBackground, isGiftCodeWorkerRunning, giftCodeRetryDelayMs, giftCodeFailedRetryCooldownMs });
startKeepAlive();

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  maybeScanGiftCodesInBackground('startup');
  scheduleGiftCodeAutoScan();
  scheduleMightPulseTasks();
  if (guildId) scheduleMemberSnapshotRefresh(readyClient, guildId);
});

function toEpochMs(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
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

function getNextReminderDueMs(event, reminder, nowMs) {
  if (!event || reminder.active === false) return null;

  const baseMs = toEpochMs(event.nextAt);
  if (!baseMs) return null;

  const remindMinutes = event.remindMinutesBefore ?? 60;
  const remindOffsetMs = remindMinutes * 60 * 1000;
  const repeatHours = Number(event.repeatHours || 0);
  const repeatMs = repeatHours > 0 ? repeatHours * 60 * 60 * 1000 : 0;

  if (repeatMs === 0) {
    if (reminder.lastNotifiedOccurrenceMs === baseMs) return null;
    return baseMs - remindOffsetMs;
  }

  const firstRemindMs = baseMs - remindOffsetMs;
  if (nowMs < firstRemindMs) return firstRemindMs;

  const cycles = Math.floor((nowMs - firstRemindMs) / repeatMs);
  const occurrenceMs = baseMs + cycles * repeatMs;
  const remindAtMs = occurrenceMs - remindOffsetMs;
  if (reminder.lastNotifiedOccurrenceMs !== occurrenceMs && nowMs >= remindAtMs) return nowMs;

  return occurrenceMs + repeatMs - remindOffsetMs;
}

function getNextRolloverMs(events, nowMs) {
  const dueTimes = events
    .filter((event) => Number(event.repeatHours || 0) > 0 && event.nextAt)
    .map((event) => toEpochMs(event.nextAt))
    .filter((value) => value && value > nowMs);

  return dueTimes.length > 0 ? Math.min(...dueTimes) : null;
}

function getNextReminderCycleDelayMs(events, reminders) {
  const nowMs = Date.now();
  const eventMap = new Map(events.map((event) => [event.key, event]));
  const dueTimes = [];
  const nextRolloverMs = getNextRolloverMs(events, nowMs);
  if (nextRolloverMs) dueTimes.push(nextRolloverMs);

  for (const reminder of reminders) {
    const dueMs = getNextReminderDueMs(eventMap.get(reminder.eventKey), reminder, nowMs);
    if (dueMs) dueTimes.push(dueMs);
  }

  if (dueTimes.length === 0) return reminderMaxPollIntervalMs;

  const nextDueMs = Math.min(...dueTimes);
  const delayMs = nextDueMs - nowMs + reminderWakeBufferMs;
  return Math.max(reminderMinPollIntervalMs, Math.min(delayMs, reminderMaxPollIntervalMs));
}

async function processEventRollovers(events) {
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

async function processReminders(botClient, events, reminders) {
  await deliverReminders({
    client: botClient, events, reminders, channelId: reminderChannelId,
    getOccurrence: getOccurrenceToNotify, chunkUserIds: chunkUserIdsForReminder,
    buildActionRow: buildReminderActionRow, markNotified: markRemindersNotified
  });
}

async function runReminderCycle(botClient) {
  const events = await getEvents();
  await processEventRollovers(events);

  const reminders = await getReminders();
  await processReminders(botClient, events, reminders);

  return getNextReminderCycleDelayMs(events, reminders);
}

function scheduleReminderCycle(botClient, delayMs = reminderMinPollIntervalMs) {
  setTimeout(async () => {
    let nextDelayMs = reminderMaxPollIntervalMs;
    try {
      nextDelayMs = await runReminderCycle(botClient);
    } catch (err) {
      console.error('Reminder cycle error:', err);
      nextDelayMs = reminderMinPollIntervalMs;
    }

    scheduleReminderCycle(botClient, nextDelayMs);
  }, delayMs);
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isAutocomplete()) return await handleAutocomplete(interaction);
    if (interaction.isChatInputCommand()) return await handleChatCommand(interaction);
    if (interaction.isButton()) return await handleButton(interaction);
    if (interaction.isStringSelectMenu()) return await handleSelectMenu(interaction);
    if (interaction.isModalSubmit()) return await handleModalSubmit(interaction);
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content: 'Something went wrong. Please try again.' }).catch(console.error);
    } else if (!interaction.replied) {
      await interaction.reply({
        content: `Something went wrong: ${error.message || 'unknown error'}`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
});

scheduleReminderCycle(client, 1000);

client.login(token);
