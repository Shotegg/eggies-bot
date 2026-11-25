const API_BASE_URL = 'https://api.mightpulse.com/v1';
const REQUEST_TIMEOUT_MS = 100000;
const REQUEST_COOLDOWN_MS = 60 * 1000;

// Reserve request slots so concurrent callers cannot bypass the API cooldown.
let nextRequestAt = 0;

function waitForRequestSlot() {
  const now = Date.now();
  const requestAt = Math.max(now, nextRequestAt);
  nextRequestAt = requestAt + REQUEST_COOLDOWN_MS;

  if (requestAt === now) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, requestAt - now));
}

function buildApiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function fetchAllianceRoster(kingdomId, allianceTag, apiKey, maxAgeSeconds = 86400) {
  await waitForRequestSlot();

  const url = new URL(`${API_BASE_URL}/alliances/${encodeURIComponent(String(kingdomId))}/${encodeURIComponent(allianceTag)}`);
  // members_base refreshes every member's base stats in one API request.
  url.searchParams.set('include', 'info,members_base');
  url.searchParams.set('max_age', String(maxAgeSeconds));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw buildApiError(`MightPulse alliance request returned HTTP ${response.status}`, response.status);
    }

    const data = await response.json();
    if (!Array.isArray(data?.members)) {
      throw buildApiError('MightPulse alliance response did not include a roster.', response.status);
    }

    return {
      allianceTag: typeof data.alliance?.abbr === 'string' ? data.alliance.abbr : allianceTag,
      allianceName: typeof data.alliance?.name === 'string' ? data.alliance.name : '',
      members: data.members.map((member) => ({
        playerId: String(member.governor_id),
        nickname: typeof member.nick_name === 'string' ? member.nick_name.trim() : '',
        power: Number.isFinite(Number(member.power)) ? Number(member.power) : null,
        stoveLv: Number.isFinite(Number(member.town_center_level)) ? Number(member.town_center_level) : null
      })).filter((member) => member.playerId && member.playerId !== 'undefined')
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchAllianceRoster };
