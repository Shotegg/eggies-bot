const API_BASE_URL = 'https://api.mightpulse.com/v1';
const REQUEST_TIMEOUT_MS = 100000;

function buildApiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function fetchPlayer(governorId, apiKey) {
  const url = new URL(`${API_BASE_URL}/players/${encodeURIComponent(String(governorId))}`);
  url.searchParams.set('include', 'base');

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
      throw buildApiError(`MightPulse returned HTTP ${response.status}`, response.status);
    }

    const data = await response.json();
    const player = data?.player;
    const nickname = player?.nick_name;
    if (typeof nickname !== 'string' || !nickname.trim()) {
      throw buildApiError('MightPulse response did not include a player nickname.', response.status);
    }

    return {
      nickname: nickname.trim(),
      power: Number.isFinite(Number(player.power)) ? Number(player.power) : null,
      allianceTag: typeof player.alliance?.abbr === 'string' ? player.alliance.abbr : '',
      allianceName: typeof player.alliance?.name === 'string' ? player.alliance.name : ''
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllianceRoster(kingdomId, allianceTag, apiKey) {
  const url = new URL(`${API_BASE_URL}/alliances/${encodeURIComponent(String(kingdomId))}/${encodeURIComponent(allianceTag)}`);
  url.searchParams.set('include', 'info,roster');

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

    return data.members.map((member) => ({
      playerId: String(member.governor_id),
      nickname: typeof member.nick_name === 'string' ? member.nick_name.trim() : '',
      power: Number.isFinite(Number(member.power)) ? Number(member.power) : null
    })).filter((member) => member.playerId && member.playerId !== 'undefined');
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchPlayer, fetchAllianceRoster };
