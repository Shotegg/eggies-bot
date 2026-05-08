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

module.exports = {
  getEvents,
  getEventByKey,
  saveEvents,
  getReminders,
  saveReminders
};
