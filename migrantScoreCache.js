const DAY_MS = 24 * 60 * 60 * 1000;

// Dates are UTC calendar dates; a score dated seven days ago is still valid today.
async function resolveMigrantScores(playerIds, { readCache, fetchScores, saveCache, now = () => new Date() }) {
  const ids = [...new Set(playerIds.map(String))];
  const today = now().toISOString().slice(0, 10);
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const rows = await readCache(ids);
  const scores = new Map();
  const requested = new Set(ids);
  for (const row of rows) {
    const id = String(row.player_id);
    const date = row.score_date;
    const dateMs = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date + 'T00:00:00Z') : NaN;
    const age = (todayMs - dateMs) / DAY_MS;
    if (requested.has(id) && age >= 0 && age <= 7 && row.score != null && row.score !== '' && Number.isFinite(Number(row.score))) {
      scores.set(id, Number(row.score));
    }
  }
  const missing = ids.filter(id => !scores.has(id));
  if (missing.length) {
    const fetched = await fetchScores(missing);
    const valid = new Map();
    for (const [id, score] of fetched) {
      if (missing.includes(String(id)) && score != null && score !== '' && Number.isFinite(Number(score))) valid.set(String(id), Number(score));
    }
    if (valid.size) {
      await saveCache(valid, now().toISOString().slice(0, 10));
      for (const [id, score] of valid) scores.set(id, score);
    }
  }
  return scores;
}

module.exports = { resolveMigrantScores };
