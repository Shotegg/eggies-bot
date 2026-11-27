const { fetchActiveGiftCodes, redeemGiftCode } = require('./giftCodes');
const { redeemWithRateLimitRetry } = require('./giftCodeRateLimit');
const { getGiftCodePlayer, upsertGiftCodePlayer, getGiftCodePlayers, getGiftCodeRedemption, getGiftCodeRedemptionsForCodes, saveGiftCodeRedemption, getActiveGiftCodes, upsertGiftCodes, deleteOldGiftCodes } = require('./storage');

function createGiftCodeWorker({ client, giftCodeTerminalStatuses, giftCodeRetryDelayMs, giftCodeFailedRetryCooldownMs, giftCodeAutoScanIntervalMs, giftCodeCleanupAfterDays, defaultGiftCodeKingdomId, giftCodeDebug, giftCodeNotifyChannelId }) {
function logGiftCodeDebug(message, details = {}) {
  if (!giftCodeDebug) return;
  console.log('[giftcode]', message, details);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let giftCodeNotificationTimer = null;
const giftCodeNotificationBuffer = new Map();
let lastGiftCodeScanMs = 0;
let giftCodeScanRunning = false;
let giftCodeWorkerRunning = false;
async function saveGiftCodePlayerKingdom(playerId, kingdomId) {
  const existing = await getGiftCodePlayer(playerId);
  const info = {
    playerId: String(playerId),
    nickname: existing?.nickname || '',
    kid: Number(kingdomId),
    stoveLv: existing?.stoveLv ?? null,
    power: existing?.power ?? null,
    allianceTag: existing?.allianceTag || '',
    allianceName: existing?.allianceName || '',
    active: true
  };

  await upsertGiftCodePlayer(info);
  return info;
}

function isGiftCodeTerminalStatus(status) {
  return giftCodeTerminalStatuses.has(status);
}

function isGiftCodeAttemptCoolingDown(redemption, nowMs = Date.now()) {
  if (!redemption || isGiftCodeTerminalStatus(redemption.status)) return false;
  const lastAttemptMs = Date.parse(redemption.last_attempt_at);
  return Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < giftCodeFailedRetryCooldownMs;
}

function classifyGiftCodeFailure(errCode, message) {
  const normalized = String(message || '').toLowerCase();

  if (['40001', '40002', '40008'].includes(errCode) || normalized.includes('already claimed') || normalized.includes('already redeemed') || normalized.includes('received')) {
    return 'already_redeemed';
  }
  if (['40003', '40015'].includes(errCode) || normalized.includes('expired')) {
    return 'expired';
  }
  if (errCode === '40004' || normalized.includes('claim limit') || normalized.includes('redemption limit')) {
    return 'claim_limit_reached';
  }
  if (errCode === '40005' || normalized.includes('redeemed successfully') || normalized.includes('please claim the rewards')) {
    return 'success';
  }
  if (errCode === '40006' || normalized.includes('gift code not found') || normalized.includes('case-sensitive')) {
    return 'invalid_code';
  }
  if (errCode === '40007' || normalized.includes('town center')) {
    return 'town_center_too_low';
  }
  if (errCode === '40011' || normalized.includes('redemption requirements')) {
    return 'requirements_unmet';
  }
  if (errCode === '40012' || normalized.includes('account age')) {
    return 'account_age_unmet';
  }
  if (normalized.includes('prerequisite unmet')) {
    return 'prerequisite_unmet';
  }
  if (normalized.includes('same gift code type')) {
    return 'same_type_redeemed';
  }

  return 'failed';
}

async function recordGiftCodeResult(playerId, code, result, forcedStatus = null) {
  const raw = result.redeem?.data || result.player?.data || {};
  const errCode = raw.err_code == null ? null : String(raw.err_code);
  const status = forcedStatus || (result.ok ? 'success' : classifyGiftCodeFailure(errCode, result.message || raw.msg));

  await saveGiftCodeRedemption({
    playerId,
    code,
    status,
    message: result.message,
    errCode
  });
}

async function redeemCodeForPlayer(player, code) {
  const playerId = player.playerId || player;
  const playerInfo = typeof player === 'object'
    ? player
    : { playerId: String(playerId), nickname: '', kid: null, stoveLv: null };
  const existing = await getGiftCodeRedemption(playerId, code);
  if (existing && (isGiftCodeTerminalStatus(existing.status) || isGiftCodeAttemptCoolingDown(existing))) {
    logGiftCodeDebug('skip saved/cooling redemption', {
      playerId: String(playerId),
      code,
      status: existing.status,
      lastAttemptAt: existing.last_attempt_at
    });
    return {
      ok: false,
      skipped: true,
      message: `Skipped saved result: ${existing.status}`,
      playerInfo
    };
  }

  if (playerInfo.kid == null || playerInfo.kid === '') {
    const result = {
      ok: false,
      step: 'config',
      player: null,
      redeem: null,
      message: 'Missing kingdom id for saved player.'
    };
    await recordGiftCodeResult(playerInfo.playerId, code, result, 'missing_kingdom_id');
    return {
      ...result,
      playerInfo,
      previousStatus: existing?.status || null,
      newSuccessfulRedemption: false
    };
  }

  const { result, rateLimitExhausted } = await redeemWithRateLimitRetry(redeemGiftCode, playerId, code, playerInfo.kid);
  const raw = result.redeem?.data || result.player?.data || {};
  logGiftCodeDebug('redeem result', {
    playerId: String(playerId),
    code,
    kid: playerInfo.kid,
    ok: result.ok,
    step: result.step,
    message: result.message,
    errCode: raw.err_code || null
  });

  await recordGiftCodeResult(playerInfo.playerId, code, result, rateLimitExhausted ? 'failed' : null);
  return {
    ...result,
    rateLimitExhausted,
    playerInfo,
    previousStatus: existing?.status || null,
    newSuccessfulRedemption: result.ok && existing?.status !== 'success'
  };
}

function getRedemptionFromIndex(redemptionIndex, playerId, code) {
  return redemptionIndex.get(`${String(playerId)}::${String(code).toLowerCase()}`) || null;
}

function buildRedemptionIndex(redemptions) {
  return new Map(redemptions.map((row) => [`${String(row.player_id)}::${String(row.code).toLowerCase()}`, row]));
}

function findNextGiftCodeAttempt(players, codes, redemptionIndex) {
  const nowMs = Date.now();
  for (const code of codes) {
    for (const player of players) {
      const redemption = getRedemptionFromIndex(redemptionIndex, player.playerId, code.code);
      if (!redemption || (!isGiftCodeTerminalStatus(redemption.status) && !isGiftCodeAttemptCoolingDown(redemption, nowMs))) {
        return { player, code, redemption };
      }
    }
  }
  return null;
}

function countPendingGiftCodeAttempts(players, codes, redemptionIndex) {
  const nowMs = Date.now();
  let pending = 0;
  let skipped = 0;

  for (const code of codes) {
    for (const player of players) {
      const redemption = getRedemptionFromIndex(redemptionIndex, player.playerId, code.code);
      if (redemption && (isGiftCodeTerminalStatus(redemption.status) || isGiftCodeAttemptCoolingDown(redemption, nowMs))) {
        skipped += 1;
      } else {
        pending += 1;
      }
    }
  }

  return { pending, skipped };
}

async function cleanupOldGiftCodes() {
  if (!Number.isFinite(giftCodeCleanupAfterDays) || giftCodeCleanupAfterDays <= 0) return;
  const cutoff = new Date(Date.now() - giftCodeCleanupAfterDays * 24 * 60 * 60 * 1000).toISOString();
  await deleteOldGiftCodes(cutoff);
  logGiftCodeDebug('cleanup old gift codes', { cutoff, cleanupAfterDays: giftCodeCleanupAfterDays });
}

function formatGiftCodePlayerLabel(playerInfo) {
  const name = playerInfo.nickname || 'Unknown';
  return `${name} (${playerInfo.playerId})`;
}

async function flushGiftCodeNotifications() {
  giftCodeNotificationTimer = null;
  if (!giftCodeNotifyChannelId || giftCodeNotificationBuffer.size === 0) return;

  const entries = [...giftCodeNotificationBuffer.entries()];
  giftCodeNotificationBuffer.clear();

  try {
    const channel = await client.channels.fetch(giftCodeNotifyChannelId);
    if (!channel || !channel.isTextBased()) return;

    for (const [code, players] of entries) {
      const uniquePlayers = [...new Map(players.map((player) => [player.playerId, player])).values()];
      const labels = uniquePlayers.map(formatGiftCodePlayerLabel);
      const shown = labels.slice(0, 20).join(', ');
      const extra = labels.length > 20 ? `, +${labels.length - 20} more` : '';
      await channel.send(`Redeemed ${code} for ${labels.length} player${labels.length === 1 ? '' : 's'}: ${shown}${extra}`);
    }
  } catch (error) {
    console.error('Gift code notification failed:', error);
  }
}

function queueGiftCodeNotification(code, playerInfo) {
  if (!giftCodeNotifyChannelId) return;
  if (!giftCodeNotificationBuffer.has(code)) giftCodeNotificationBuffer.set(code, []);
  giftCodeNotificationBuffer.get(code).push(playerInfo);

  if (!giftCodeNotificationTimer) {
    giftCodeNotificationTimer = setTimeout(() => {
      flushGiftCodeNotifications().catch((error) => console.error('Gift code notification failed:', error));
    }, 30000);
  }
}

async function runGiftCodeWorker() {
  if (giftCodeWorkerRunning) {
    logGiftCodeDebug('worker already running');
    return;
  }
  giftCodeWorkerRunning = true;
  logGiftCodeDebug('worker started', {
    retryDelayMs: giftCodeRetryDelayMs,
    failedRetryCooldownMs: giftCodeFailedRetryCooldownMs
  });

  try {
    while (true) {
      const players = await getGiftCodePlayers();
      const codes = await getActiveGiftCodes();
      const redemptions = await getGiftCodeRedemptionsForCodes(codes.map((code) => code.code));
      const redemptionIndex = buildRedemptionIndex(redemptions);
      logGiftCodeDebug('worker loaded queue', {
        players: players.length,
        codes: codes.length,
        relevantRedemptions: redemptions.length
      });

      const next = findNextGiftCodeAttempt(players, codes, redemptionIndex);
      if (!next) {
        logGiftCodeDebug('worker stopped: no pending work');
        break;
      }

      logGiftCodeDebug('worker attempting redeem', {
        playerId: next.player.playerId,
        code: next.code.code,
        previousStatus: next.redemption?.status || null
      });

      const result = await redeemCodeForPlayer(next.player, next.code.code);
      if (result.newSuccessfulRedemption) {
        queueGiftCodeNotification(next.code.code, result.playerInfo);
      }
      if (result.rateLimitExhausted) break;
      logGiftCodeDebug('worker sleeping after attempt', {
        delayMs: giftCodeRetryDelayMs
      });
      await sleep(giftCodeRetryDelayMs);
    }
  } catch (error) {
    console.error('Gift code background worker failed:', error);
  } finally {
    giftCodeWorkerRunning = false;
    logGiftCodeDebug('worker finished');
  }
}

function startGiftCodeWorker() {
  logGiftCodeDebug('worker scheduled');
  setTimeout(() => {
    runGiftCodeWorker().catch((error) => console.error('Gift code background worker failed:', error));
  }, 0);
}

async function syncGiftCodes(playerId, kingdomId = defaultGiftCodeKingdomId) {
  let registered = null;
  if (playerId) {
    const info = await saveGiftCodePlayerKingdom(playerId, kingdomId);
    registered = { ok: true, player: null, info };
  }

  if (registered && !registered.ok) {
    return {
      ok: false,
      message: 'Player lookup failed.',
      playerId,
      player: registered.player,
      discoveredCodes: [],
      attempted: [],
      skipped: []
    };
  }

  const discoveredCodes = await fetchActiveGiftCodes();
  lastGiftCodeScanMs = Date.now();
  logGiftCodeDebug('sync discovered active codes', {
    playerId: playerId || null,
    codes: discoveredCodes.map((item) => `${item.code}:${item.source}`)
  });
  await upsertGiftCodes(discoveredCodes);
  await cleanupOldGiftCodes();

  const players = await getGiftCodePlayers();
  if (players.length === 0) {
    return {
      ok: false,
      message: 'No saved players yet. Run /giftcode with player_id first.',
      playerId,
      player: null,
      discoveredCodes,
      attempted: [],
      skipped: [],
      pending: 0
    };
  }

  const attempted = [];
  const redemptions = await getGiftCodeRedemptionsForCodes(discoveredCodes.map((code) => code.code));
  const redemptionIndex = buildRedemptionIndex(redemptions);
  const { pending, skipped } = countPendingGiftCodeAttempts(players, discoveredCodes, redemptionIndex);

  startGiftCodeWorker();
  logGiftCodeDebug('sync queued worker', {
    players: players.length,
    discoveredCodes: discoveredCodes.length,
    pending,
    skipped
  });

  return {
    ok: true,
    playerId: registered?.info?.playerId || null,
    player: registered?.info || null,
    discoveredCodes,
    attempted,
    skipped,
    pending
  };
}

async function scanGiftCodesInBackground(reason = 'scheduled') {
  if (giftCodeScanRunning) {
    logGiftCodeDebug('scan already running', { reason });
    return;
  }

  giftCodeScanRunning = true;
  lastGiftCodeScanMs = Date.now();

  try {
    const discoveredCodes = await fetchActiveGiftCodes();
    logGiftCodeDebug('auto scan discovered active codes', {
      reason,
      codes: discoveredCodes.map((item) => `${item.code}:${item.source}`)
    });
    await upsertGiftCodes(discoveredCodes);
    await cleanupOldGiftCodes();

    const players = await getGiftCodePlayers();
    if (players.length > 0 && discoveredCodes.length > 0) {
      startGiftCodeWorker();
      logGiftCodeDebug('auto scan queued worker', {
        reason,
        players: players.length,
        discoveredCodes: discoveredCodes.length
      });
    }
  } catch (error) {
    console.error('Gift code auto scan failed:', error);
  } finally {
    giftCodeScanRunning = false;
  }
}

function maybeScanGiftCodesInBackground(reason) {
  if (!Number.isFinite(giftCodeAutoScanIntervalMs) || giftCodeAutoScanIntervalMs <= 0) return;
  if (Date.now() - lastGiftCodeScanMs < giftCodeAutoScanIntervalMs) return;
  setTimeout(() => {
    scanGiftCodesInBackground(reason).catch((error) => console.error('Gift code auto scan failed:', error));
  }, 0);
}

function scheduleGiftCodeAutoScan(delayMs = giftCodeAutoScanIntervalMs) {
  if (!Number.isFinite(giftCodeAutoScanIntervalMs) || giftCodeAutoScanIntervalMs <= 0) return;
  setTimeout(async () => {
    await scanGiftCodesInBackground('scheduled');
    scheduleGiftCodeAutoScan(giftCodeAutoScanIntervalMs);
  }, Math.max(60000, delayMs));
}


return { saveGiftCodePlayerKingdom, redeemCodeForPlayer, syncGiftCodes, startGiftCodeWorker, maybeScanGiftCodesInBackground, scheduleGiftCodeAutoScan, isGiftCodeWorkerRunning: () => giftCodeWorkerRunning };
}

module.exports = { createGiftCodeWorker };
