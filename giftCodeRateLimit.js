const RATE_LIMIT_RETRY_DELAY_MS = 5000;
const MAX_RATE_LIMIT_RETRIES = 3;

function isTimeError(message) {
  return /^TIME ERROR\.?$/i.test(String(message || '').trim());
}

function normalizeGiftCodeRedemption(row) {
  if (row.status === 'town_center_too_low' && String(row.err_code) === '40007' && isTimeError(row.message)) {
    return { ...row, status: 'failed' };
  }
  return row;
}

function isRateLimited(result) {
  return !result.ok && (result.redeem?.status === 429 || String(result.redeem?.data?.err_code) === '40013' ||
    (String(result.redeem?.data?.err_code) === '40007' && isTimeError(result.message || result.redeem?.data?.msg)));
}

async function redeemWithRateLimitRetry(redeem, playerId, code, kingdomId, options = {}) {
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logger = options.logger || console;
  for (let attempt = 0; ; attempt += 1) {
    const result = await redeem(playerId, code, kingdomId);
    if (!isRateLimited(result)) return { result, rateLimitExhausted: false };
    if (attempt >= MAX_RATE_LIMIT_RETRIES) {
      logger.warn('[giftcode] Rate limit or TIME ERROR persisted after retries; stopping the worker until a later scan.');
      return { result, rateLimitExhausted: true };
    }
    logger.warn(`[giftcode] Rate limit or TIME ERROR; retrying the same player and code in 5 seconds (${attempt + 1}/${MAX_RATE_LIMIT_RETRIES}).`);
    await wait(RATE_LIMIT_RETRY_DELAY_MS);
  }
}

module.exports = { redeemWithRateLimitRetry, normalizeGiftCodeRedemption };
