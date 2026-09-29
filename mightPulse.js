const API_BASE_URL = 'https://api.mightpulse.com/v1';
const REQUEST_TIMEOUT_MS = 100000;

function buildApiError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function fetchPlayerName(governorId, apiKey) {
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
    const nickname = data?.player?.nick_name;
    if (typeof nickname !== 'string' || !nickname.trim()) {
      throw buildApiError('MightPulse response did not include a player nickname.', response.status);
    }

    return nickname.trim();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { fetchPlayerName };
