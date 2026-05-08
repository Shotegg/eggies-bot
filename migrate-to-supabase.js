require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { saveEvents, saveReminders } = require('./storage');

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

(async () => {
  const eventsPath = path.join(__dirname, 'data', 'events.json');
  const remindersPath = path.join(__dirname, 'data', 'reminders.json');

  const events = readJson(eventsPath, []);
  const remindersRaw = readJson(remindersPath, []);
  const reminders = remindersRaw
    .map((r) => ({
      userId: r.userId,
      channelId: r.channelId,
      eventKey: r.eventKey,
      active: r.active !== false && r.sent !== true,
      lastNotifiedOccurrenceMs: r.lastNotifiedOccurrenceMs ?? null
    }))
    .filter((r) => r.userId && r.channelId && r.eventKey);

  // Deduplicate by (userId,eventKey) to satisfy ON CONFLICT upsert requirements.
  const dedupedRemindersMap = new Map();
  for (const reminder of reminders) {
    dedupedRemindersMap.set(`${reminder.userId}::${reminder.eventKey}`, reminder);
  }
  const dedupedReminders = [...dedupedRemindersMap.values()];

  // Deduplicate events by key (last one wins).
  const dedupedEventsMap = new Map();
  for (const event of events) {
    if (event && event.key) {
      dedupedEventsMap.set(event.key, event);
    }
  }
  const dedupedEvents = [...dedupedEventsMap.values()];

  await saveEvents(dedupedEvents);
  await saveReminders(dedupedReminders);

  console.log(`Migrated ${dedupedEvents.length} events and ${dedupedReminders.length} reminders to Supabase.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
