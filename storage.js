const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

function mapEventRow(row) {
  return {
    key: row.key,
    title: row.title,
    description: row.description || '',
    info: row.info || '',
    nextAt: row.next_at,
    repeatHours: row.repeat_hours ?? 0,
    remindMinutesBefore: row.remind_minutes_before ?? 60
  };
}

function mapEventToRow(event) {
  return {
    key: event.key,
    title: event.title,
    description: event.description || '',
    info: event.info || '',
    next_at: event.nextAt,
    repeat_hours: Number(event.repeatHours || 0),
    remind_minutes_before: Number(event.remindMinutesBefore || 60)
  };
}

function mapReminderRow(row) {
  return {
    userId: row.user_id,
    channelId: row.channel_id,
    eventKey: row.event_key,
    active: row.active !== false,
    lastNotifiedOccurrenceMs: row.last_notified_occurrence_ms
  };
}

function mapReminderToRow(reminder) {
  return {
    user_id: reminder.userId,
    channel_id: reminder.channelId,
    event_key: reminder.eventKey,
    active: reminder.active !== false,
    last_notified_occurrence_ms: reminder.lastNotifiedOccurrenceMs ?? null
  };
}

function mapGiftCodePlayerRow(row) {
  return {
    playerId: row.player_id,
    nickname: row.nickname || '',
    kid: row.kid ?? null,
    stoveLv: row.stove_lv ?? null,
    power: row.power == null ? null : Number(row.power),
    allianceTag: row.alliance_tag || '',
    allianceName: row.alliance_name || '',
    active: row.active !== false
  };
}

function mapGiftCodeRow(row) {
  return {
    code: row.code,
    source: row.source || '',
    expiresAt: row.expires_at,
    active: row.active !== false
  };
}

async function getEvents() {
  const { data, error } = await supabase
    .from('events')
    .select('key,title,description,info,next_at,repeat_hours,remind_minutes_before')
    .order('key', { ascending: true });

  if (error) throw error;
  return (data || []).map(mapEventRow);
}

async function getEventByKey(key) {
  const { data, error } = await supabase
    .from('events')
    .select('key,title,description,info,next_at,repeat_hours,remind_minutes_before')
    .eq('key', key)
    .maybeSingle();

  if (error) throw error;
  return data ? mapEventRow(data) : null;
}

async function saveEvents(events) {
  const rows = events.map(mapEventToRow);

  if (rows.length > 0) {
    const { error: upsertError } = await supabase
      .from('events')
      .upsert(rows, { onConflict: 'key' });
    if (upsertError) throw upsertError;
  }

  const keepKeys = rows.map((r) => r.key);
  if (keepKeys.length === 0) {
    const { error: deleteAllError } = await supabase.from('events').delete().neq('key', '');
    if (deleteAllError) throw deleteAllError;
    return;
  }

  const { error: deleteError } = await supabase
    .from('events')
    .delete()
    .not('key', 'in', `(${keepKeys.map((k) => `"${k.replace(/"/g, '\\"')}"`).join(',')})`);
  if (deleteError) throw deleteError;
}

async function getReminders() {
  const { data, error } = await supabase
    .from('reminder_subscriptions')
    .select('user_id,channel_id,event_key,active,last_notified_occurrence_ms');

  if (error) throw error;
  return (data || []).map(mapReminderRow);
}

async function saveReminders(reminders) {
  const rows = reminders.map(mapReminderToRow);

  if (rows.length > 0) {
    const { error: upsertError } = await supabase
      .from('reminder_subscriptions')
      .upsert(rows, { onConflict: 'user_id,event_key' });
    if (upsertError) throw upsertError;
  }

  const pairs = rows.map((r) => `${r.user_id}::${r.event_key}`);
  const { data: existing, error: existingError } = await supabase
    .from('reminder_subscriptions')
    .select('user_id,event_key');
  if (existingError) throw existingError;

  for (const row of existing || []) {
    const id = `${row.user_id}::${row.event_key}`;
    if (!pairs.includes(id)) {
      const { error: delErr } = await supabase
        .from('reminder_subscriptions')
        .delete()
        .eq('user_id', row.user_id)
        .eq('event_key', row.event_key);
      if (delErr) throw delErr;
    }
  }
}

async function upsertGiftCodePlayer(player) {
  const { error } = await supabase
    .from('gift_code_players')
    .upsert({
      player_id: String(player.playerId),
      nickname: player.nickname || '',
      kid: player.kid ?? null,
      stove_lv: player.stoveLv ?? null,
      power: player.power ?? null,
      alliance_tag: player.allianceTag || '',
      alliance_name: player.allianceName || '',
      active: player.active !== false,
      last_seen_at: new Date().toISOString()
    }, { onConflict: 'player_id' });

  if (error) throw error;
}

async function getGiftCodePlayers() {
  const { data, error } = await supabase
    .from('gift_code_players')
    .select('player_id,nickname,kid,stove_lv,power,alliance_tag,alliance_name,active')
    .eq('active', true)
    .order('player_id', { ascending: true });

  if (error) throw error;
  return (data || []).map(mapGiftCodePlayerRow);
}

async function getGiftCodePlayer(playerId) {
  const { data, error } = await supabase
    .from('gift_code_players')
    .select('player_id,nickname,kid,stove_lv,power,alliance_tag,alliance_name,active')
    .eq('player_id', String(playerId))
    .maybeSingle();

  if (error) throw error;
  return data ? mapGiftCodePlayerRow(data) : null;
}

async function updateGiftCodePlayerNickname(playerId, nickname) {
  const { error } = await supabase
    .from('gift_code_players')
    .update({ nickname })
    .eq('player_id', String(playerId));

  if (error) throw error;
}

async function updateGiftCodePlayerMightPulseData(playerId, player) {
  const { error } = await supabase
    .from('gift_code_players')
    .update({
      nickname: player.nickname,
      power: player.power,
      alliance_tag: player.allianceTag,
      alliance_name: player.allianceName,
      last_seen_at: new Date().toISOString()
    })
    .eq('player_id', String(playerId));

  if (error) throw error;
}

async function deleteGiftCodePlayer(playerId) {
  const { error } = await supabase
    .from('gift_code_players')
    .delete()
    .eq('player_id', String(playerId));

  if (error) throw error;
}

async function saveWeeklyPowerSnapshot(weekStart, members) {
  if (members.length === 0) return;

  const rows = members.map((member) => ({
    week_start: weekStart,
    player_id: String(member.playerId),
    nickname: member.nickname || '',
    power: member.power
  }));
  const { error } = await supabase
    .from('alliance_weekly_power_snapshots')
    .upsert(rows, { onConflict: 'week_start,player_id' });

  if (error) throw error;
}

async function hasMightPulseDailySync(syncDate) {
  const { data, error } = await supabase
    .from('mightpulse_daily_syncs')
    .select('sync_date')
    .eq('sync_date', syncDate)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

async function markMightPulseDailySyncComplete(syncDate) {
  const { error } = await supabase
    .from('mightpulse_daily_syncs')
    .upsert({ sync_date: syncDate, completed_at: new Date().toISOString() }, { onConflict: 'sync_date' });

  if (error) throw error;
}

async function getWeeklyPowerSnapshot(weekStart) {
  const { data, error } = await supabase
    .from('alliance_weekly_power_snapshots')
    .select('week_start,player_id,nickname,power')
    .eq('week_start', weekStart);

  if (error) throw error;
  return data || [];
}

async function hasWeeklyPowerReport(weekStart) {
  const { data, error } = await supabase
    .from('alliance_weekly_power_reports')
    .select('week_start')
    .eq('week_start', weekStart)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

async function markWeeklyPowerReportSent(weekStart) {
  const { error } = await supabase
    .from('alliance_weekly_power_reports')
    .upsert({ week_start: weekStart, sent_at: new Date().toISOString() }, { onConflict: 'week_start' });

  if (error) throw error;
}

async function upsertGiftCodes(codes) {
  if (codes.length === 0) return;

  const now = new Date().toISOString();
  const rows = codes.map((code) => ({
    code: code.code,
    source: code.source || 'unknown',
    expires_at: code.expiresAt || null,
    active: code.active !== false,
    last_seen_at: now
  }));

  const { error } = await supabase
    .from('gift_codes')
    .upsert(rows, { onConflict: 'code' });

  if (error) throw error;
}

async function getActiveGiftCodes() {
  const { data, error } = await supabase
    .from('gift_codes')
    .select('code,source,expires_at,active')
    .eq('active', true)
    .order('code', { ascending: true });

  if (error) throw error;
  return (data || []).map(mapGiftCodeRow);
}

async function getGiftCodeRedemption(playerId, code) {
  const { data, error } = await supabase
    .from('gift_code_redemptions')
    .select('player_id,code,status,last_attempt_at')
    .eq('player_id', String(playerId))
    .eq('code', code)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getGiftCodeRedemptionsForCodes(codes) {
  const codeList = [...new Set(codes.map((code) => String(code)).filter(Boolean))];
  if (codeList.length === 0) return [];

  const pageSize = 1000;
  const rows = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('gift_code_redemptions')
      .select('player_id,code,status,last_attempt_at')
      .in('code', codeList)
      .range(from, from + pageSize - 1);

    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  return rows;
}

async function deleteOldGiftCodes(cutoffIso) {
  const expired = await supabase
    .from('gift_codes')
    .delete()
    .not('expires_at', 'is', null)
    .lt('expires_at', cutoffIso);
  if (expired.error) throw expired.error;

  const stale = await supabase
    .from('gift_codes')
    .delete()
    .lt('last_seen_at', cutoffIso);
  if (stale.error) throw stale.error;
}

async function saveGiftCodeRedemption(result) {
  const { error } = await supabase
    .from('gift_code_redemptions')
    .upsert({
      player_id: String(result.playerId),
      code: result.code,
      status: result.status,
      message: result.message || '',
      err_code: result.errCode == null ? null : String(result.errCode),
      last_attempt_at: new Date().toISOString()
    }, { onConflict: 'player_id,code' });

  if (error) throw error;
}

module.exports = {
  getEvents,
  getEventByKey,
  saveEvents,
  getReminders,
  saveReminders,
  upsertGiftCodePlayer,
  getGiftCodePlayers,
  getGiftCodePlayer,
  updateGiftCodePlayerNickname,
  updateGiftCodePlayerMightPulseData,
  deleteGiftCodePlayer,
  saveWeeklyPowerSnapshot,
  hasMightPulseDailySync,
  markMightPulseDailySyncComplete,
  getWeeklyPowerSnapshot,
  hasWeeklyPowerReport,
  markWeeklyPowerReportSent,
  upsertGiftCodes,
  getActiveGiftCodes,
  getGiftCodeRedemption,
  getGiftCodeRedemptionsForCodes,
  deleteOldGiftCodes,
  saveGiftCodeRedemption
};
