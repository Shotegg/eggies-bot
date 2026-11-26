const { fetchAllianceRoster } = require('./mightPulse');
const { REPORT_TEMPLATES, applyTemplate } = require('./weeklyPowerReport');
const { getGiftCodePlayers, upsertGiftCodePlayers, saveWeeklyPowerSnapshot, hasMightPulseDailySync, markMightPulseDailySyncComplete, getWeeklyPowerSnapshot, hasWeeklyPowerReport, markWeeklyPowerReportSent } = require('./storage');

function createMightPulseTasks({ client, mightPulseApiKey, mightPulseAllianceKingdomId, mightPulseAllianceTag, mightPulseGiftCodeAllianceTags, mightPulseWeeklyReportChannelId, mightPulseRecoveryCheckIntervalMs }) {
let weeklyReportRunning = false;
let mightPulseDailySyncPromise = null;
let weeklyPowerSnapshotRunning = false;
let allianceSyncRunning = false;
async function getEggAllianceRoster() {
  if (!mightPulseApiKey) throw new Error('Missing MIGHTPULSE_API_KEY.');
  if (!Number.isFinite(mightPulseAllianceKingdomId) || mightPulseAllianceKingdomId <= 0 || !mightPulseAllianceTag) {
    throw new Error('Invalid MightPulse alliance configuration.');
  }
  return fetchAllianceRoster(mightPulseAllianceKingdomId, mightPulseAllianceTag, mightPulseApiKey);
}

async function syncEggAllianceRoster() {
  if (!mightPulseApiKey) throw new Error('Missing MIGHTPULSE_API_KEY.');
  if (allianceSyncRunning) throw new Error('MightPulse alliance roster sync is already running.');
  allianceSyncRunning = true;
  try {
    if (mightPulseGiftCodeAllianceTags.length === 0) throw new Error('No MightPulse gift-code alliances configured.');

    const [rosters, savedPlayers] = await Promise.all([
      Promise.all(mightPulseGiftCodeAllianceTags.map((allianceTag) => (
        fetchAllianceRoster(mightPulseAllianceKingdomId, allianceTag, mightPulseApiKey)
      ))),
      getGiftCodePlayers()
    ]);
    const savedById = new Map(savedPlayers.map((player) => [String(player.playerId), player]));
    const playersById = new Map();
    for (const roster of rosters) {
      for (const member of roster.members) {
        const saved = savedById.get(member.playerId);
        playersById.set(member.playerId, {
          playerId: member.playerId,
          nickname: member.nickname,
          kid: mightPulseAllianceKingdomId,
          stoveLv: member.stoveLv ?? saved?.stoveLv ?? null,
          power: member.power,
          allianceTag: roster.allianceTag,
          allianceName: roster.allianceName,
          active: true
        });
      }
    }
    const players = [...playersById.values()];
    await upsertGiftCodePlayers(players);
    const eggRoster = rosters.find((roster) => roster.allianceTag.toUpperCase() === mightPulseAllianceTag)
      || rosters.find((roster) => roster.allianceTag.toUpperCase() === 'EGG');
    console.log(`MightPulse gift-code alliance sync finished: ${players.length} members updated from ${rosters.length} API requests (${mightPulseGiftCodeAllianceTags.join(', ')}).`);
    return eggRoster?.members || [];
  } catch (error) {
    console.error('MightPulse alliance roster sync failed:', error);
    throw error;
  } finally {
    allianceSyncRunning = false;
  }
}

function getUtcDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { weekday: values.weekday, date: `${values.year}-${values.month}-${values.day}` };
}

function getPreviousWeekDate(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 7);
  return date.toISOString().slice(0, 10);
}

function getPreviousDayDate(dateString) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function isPushSaturday(reportDate) {
  const firstPushSaturdayMs = Date.parse('2026-11-07T00:00:00Z');
  const reportMs = Date.parse(`${reportDate}T00:00:00Z`);
  const weeksSinceFirstPush = Math.round((reportMs - firstPushSaturdayMs) / (7 * 24 * 60 * 60 * 1000));
  return weeksSinceFirstPush >= 0 && weeksSinceFirstPush % 4 === 0;
}

function formatPower(value) {
  const abs = Math.abs(Number(value));
  if (abs >= 1_000_000_000) return `${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}K`;
  return String(abs);
}

function formatSignedPower(value) {
  return `${Number(value) >= 0 ? '+' : '-'}${formatPower(value)}`;
}

function formatPercent(value) {
  return `${Number(value) >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
}

function formatMetricPlayer(player, metric, isPercent = false) {
  const metricValue = isPercent ? formatPercent(player[metric]) : formatSignedPower(player[metric]);
  return `**${player.nickname || 'Unknown'}** — ${metricValue}`;
}

function buildWeeklyPowerReport(currentRows, previousRows, reportDate, reportKind) {
  const previousByPlayerId = new Map(previousRows.map((row) => [String(row.player_id), row]));
  const comparisons = currentRows
    .map((current) => {
      const previous = previousByPlayerId.get(String(current.player_id));
      if (!previous || current.power == null || previous.power == null) return null;
      const currentPower = Number(current.power);
      const previousPower = Number(previous.power);
      if (!Number.isFinite(currentPower) || !Number.isFinite(previousPower)) return null;
      const gain = currentPower - previousPower;
      return {
        playerId: String(current.player_id),
        nickname: current.nickname || previous.nickname || 'Unknown',
        gain,
        percentageGain: previousPower > 0 ? (gain / previousPower) * 100 : null
      };
    })
    .filter(Boolean);

  const template = reportKind === 'push' ? REPORT_TEMPLATES.push : REPORT_TEMPLATES.normal;
  if (comparisons.length === 0) {
    return `${template.title}\n\nNo comparable EGG members were available for this week.`;
  }

  const nonNegative = comparisons.filter((player) => player.gain >= 0);
  const percentagePlayers = nonNegative.filter((player) => Number.isFinite(player.percentageGain));
  const losses = comparisons.filter((player) => player.gain < 0).sort((a, b) => a.gain - b.gain);
  const lines = [template.title, `Period: ${getPreviousWeekDate(reportDate)} → ${reportDate}`];

  if (nonNegative.length > 0) {
    const biggest = nonNegative.slice().sort((a, b) => b.gain - a.gain)[0];
    const smallest = nonNegative.slice().sort((a, b) => a.gain - b.gain)[0];
    lines.push('', template.biggestGain, formatMetricPlayer(biggest, 'gain'), applyTemplate(template.highGainMessage, { name: biggest.nickname }));
    lines.push('', template.smallestGain, formatMetricPlayer(smallest, 'gain'), applyTemplate(template.lowGainMessage, { name: smallest.nickname }));
  }

  if (percentagePlayers.length > 0) {
    const biggestPercentage = percentagePlayers.slice().sort((a, b) => b.percentageGain - a.percentageGain)[0];
    const smallestPercentage = percentagePlayers.slice().sort((a, b) => a.percentageGain - b.percentageGain)[0];
    lines.push('', template.bestPercentage, formatMetricPlayer(biggestPercentage, 'percentageGain', true), applyTemplate(template.highGainMessage, { name: biggestPercentage.nickname }));
    lines.push('', template.smallestPercentage, formatMetricPlayer(smallestPercentage, 'percentageGain', true), applyTemplate(template.lowGainMessage, { name: smallestPercentage.nickname }));
  }

  if (losses.length > 0) {
    // Power loss always uses the regular-week message, including during Push Week.
    lines.push('', REPORT_TEMPLATES.normal.losses);
    for (const player of losses.slice(0, 3)) {
      lines.push(formatMetricPlayer(player, 'gain'), applyTemplate(REPORT_TEMPLATES.normal.lossMessage, { name: player.nickname, power: formatPower(player.gain) }));
    }
  }

  return lines.join('\n');
}

function buildPushWeekLossReport(currentRows, previousRows, snapshotDate) {
  const previousByPlayerId = new Map(previousRows.map((row) => [String(row.player_id), row]));
  const losses = currentRows
    .map((current) => {
      const previous = previousByPlayerId.get(String(current.player_id));
      if (!previous || current.power == null || previous.power == null) return null;
      const gain = Number(current.power) - Number(previous.power);
      if (!Number.isFinite(gain) || gain >= 0) return null;
      return { nickname: current.nickname || previous.nickname || 'Unknown', gain };
    })
    .filter(Boolean)
    .sort((a, b) => a.gain - b.gain);

  if (losses.length === 0) return null;
  const lines = [REPORT_TEMPLATES.push.losses, `Period: ${getPreviousWeekDate(snapshotDate)} → ${snapshotDate}`];
  for (const player of losses.slice(0, 3)) {
    lines.push('', formatMetricPlayer(player, 'gain'), applyTemplate(REPORT_TEMPLATES.push.lossMessage, {
      name: player.nickname,
      power: formatPower(player.gain)
    }));
  }
  return lines.join('\n');
}

async function sendWeeklyPowerReport(snapshotDate, reportDate, reportKind) {
  if (!mightPulseWeeklyReportChannelId || await hasWeeklyPowerReport(reportDate)) return;

  const previousDate = getPreviousWeekDate(snapshotDate);
  const [currentRows, previousRows] = await Promise.all([
    getWeeklyPowerSnapshot(snapshotDate),
    getWeeklyPowerSnapshot(previousDate)
  ]);
  if (currentRows.length === 0 || previousRows.length === 0) {
    console.warn(`MightPulse weekly report skipped for ${reportDate}: current snapshot has ${currentRows.length} members; previous snapshot (${previousDate}) has ${previousRows.length}.`);
    return;
  }

  const channel = await client.channels.fetch(mightPulseWeeklyReportChannelId);
  if (!channel || !channel.isTextBased()) throw new Error('MIGHTPULSE_WEEKLY_REPORT_CHANNEL_ID is not a text channel.');
  if (!isWeeklyReportWindow(reportDate)) return;
  await channel.send(buildWeeklyPowerReport(currentRows, previousRows, snapshotDate, reportKind));
  await markWeeklyPowerReportSent(reportDate);
}

async function sendPushWeekLossReport(snapshotDate, reportDate) {
  if (!mightPulseWeeklyReportChannelId || await hasWeeklyPowerReport(reportDate)) return;

  const previousDate = getPreviousWeekDate(snapshotDate);
  const [currentRows, previousRows] = await Promise.all([
    getWeeklyPowerSnapshot(snapshotDate),
    getWeeklyPowerSnapshot(previousDate)
  ]);
  if (currentRows.length === 0 || previousRows.length === 0) {
    console.warn(`MightPulse push-week loss report skipped for ${reportDate}: current snapshot (${snapshotDate}) has ${currentRows.length} members; previous snapshot (${previousDate}) has ${previousRows.length}.`);
    return;
  }

  const report = buildPushWeekLossReport(currentRows, previousRows, snapshotDate);
  if (!report) {
    await markWeeklyPowerReportSent(reportDate);
    return;
  }

  const channel = await client.channels.fetch(mightPulseWeeklyReportChannelId);
  if (!channel || !channel.isTextBased()) throw new Error('MIGHTPULSE_WEEKLY_REPORT_CHANNEL_ID is not a text channel.');
  if (!isWeeklyReportWindow(reportDate)) return;
  await channel.send(report);
  await markWeeklyPowerReportSent(reportDate);
}

async function captureSaturdayPowerSnapshot(members, syncDate) {
  const today = getUtcDateParts();
  if (today.weekday !== 'Sat' || weeklyPowerSnapshotRunning) return;

  weeklyPowerSnapshotRunning = true;
  try {
    await saveWeeklyPowerSnapshot(syncDate, members);
    console.log(`MightPulse weekly [${mightPulseAllianceTag}] power snapshot saved: ${members.length} members for ${syncDate}.`);
  } catch (error) {
    console.error('MightPulse weekly power snapshot failed:', error);
  } finally {
    weeklyPowerSnapshotRunning = false;
  }
}

async function runMightPulseDailySyncIfDue() {
  if (mightPulseDailySyncPromise) return mightPulseDailySyncPromise;

  mightPulseDailySyncPromise = (async () => {
    const now = new Date();
    const today = getUtcDateParts(now);
    if (!mightPulseApiKey || now.getUTCHours() < 9 || await hasMightPulseDailySync(today.date)) return;

    try {
      const members = await syncEggAllianceRoster();
      await captureSaturdayPowerSnapshot(members, today.date);
      await markMightPulseDailySyncComplete(today.date);
      console.log(`MightPulse daily sync completed for ${today.date}.`);
    } catch (error) {
      console.error(`MightPulse daily sync will retry later for ${today.date}:`, error);
    }
  })();

  try {
    return await mightPulseDailySyncPromise;
  } finally {
    mightPulseDailySyncPromise = null;
  }
}

function isWeeklyReportWindow(reportDate, now = new Date()) {
  return getUtcDateParts(now).date === reportDate && now.getUTCHours() === 11;
}

async function runWeeklyReportsIfDue() {
  const now = new Date();
  const today = getUtcDateParts(now);
  if (!isWeeklyReportWindow(today.date, now) || weeklyReportRunning) return;

  weeklyReportRunning = true;
  try {
    if (today.weekday === 'Sat') {
      // A report needs today's snapshot. Await the same daily sync if it is
      // already in progress, rather than racing it at the scheduled hour.
      await runMightPulseDailySyncIfDue();
      await sendWeeklyPowerReport(today.date, today.date, isPushSaturday(today.date) ? 'push' : 'normal');
    } else if (today.weekday === 'Sun' && isPushSaturday(getPreviousDayDate(today.date))) {
      await sendPushWeekLossReport(getPreviousDayDate(today.date), today.date);
    }
  } catch (error) {
    console.error('MightPulse weekly report will retry later:', error);
  } finally {
    weeklyReportRunning = false;
  }
}

function millisecondsUntilNextUtcHour(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

function scheduleDailyUtcTask(hour, task) {
  setTimeout(async () => {
    await task();
    scheduleDailyUtcTask(hour, task);
  }, millisecondsUntilNextUtcHour(hour));
}

function scheduleMightPulseTasks() {
  runMightPulseDailySyncIfDue();
  runWeeklyReportsIfDue();
  scheduleDailyUtcTask(9, runMightPulseDailySyncIfDue);
  scheduleDailyUtcTask(11, runWeeklyReportsIfDue);
  setInterval(() => {
    runWeeklyReportsIfDue();
  }, 5 * 60 * 1000);
  setInterval(() => {
    runMightPulseDailySyncIfDue();
  }, Math.max(60000, mightPulseRecoveryCheckIntervalMs));
}


return { scheduleMightPulseTasks, formatPower };
}

module.exports = { createMightPulseTasks };
