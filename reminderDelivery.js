function getOccurrenceToNotify(event, nowMs) {
  const baseMs = Date.parse(event.nextAt);
  if (!baseMs || Number.isNaN(baseMs)) return null;
  const remindMinutes = event.remindMinutesBefore ?? 60;
  const firstRemindMs = baseMs - remindMinutes * 60000;
  if (nowMs < firstRemindMs) return null;
  const repeatMs = Number(event.repeatHours || 0) * 3600000;
  const cycles = repeatMs > 0 ? Math.floor((nowMs - firstRemindMs) / repeatMs) : 0;
  return { occurrenceMs: baseMs + cycles * (repeatMs > 0 ? repeatMs : 0), remindMinutesBefore: remindMinutes };
}

// Record each successful Discord message separately, so failed chunks can retry.
async function deliverReminders({ client, events, reminders, channelId, getOccurrence, chunkUserIds, buildActionRow, markNotified, now = Date.now(), logger = console }) {
  const batches = new Map();
  const eventMap = new Map(events.map((event) => [event.key, event]));
  for (const reminder of reminders) {
    if (reminder.active === false) continue;
    const event = eventMap.get(reminder.eventKey);
    if (!event) continue;
    const notify = getOccurrence(event, now);
    if (!notify || reminder.lastNotifiedOccurrenceMs === notify.occurrenceMs) continue;
    const key = JSON.stringify([event.key, notify.occurrenceMs, notify.remindMinutesBefore]);
    if (!batches.has(key)) batches.set(key, { event, notify, reminders: [] });
    batches.get(key).reminders.push(reminder);
  }

  for (const { event, notify, reminders: pending } of batches.values()) {
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) throw new Error('Reminder channel is not a text channel.');
    } catch (error) {
      logger.error('Failed to fetch reminder channel:', error);
      continue;
    }
    const suffix = ` **${event.title}** in ${notify.remindMinutesBefore} minutes`;
    const chunks = chunkUserIds([...new Set(pending.map((reminder) => reminder.userId))], suffix);
    for (const userIds of chunks) {
      try {
        await channel.send({
          content: `${userIds.map((id) => `<@${id}>`).join(' ')}${suffix}`,
          allowedMentions: { users: userIds },
          components: [buildActionRow(event.key)]
        });
        await markNotified(event.key, userIds, notify.occurrenceMs);
        const sentIds = new Set(userIds);
        for (const reminder of pending) {
          if (sentIds.has(reminder.userId)) reminder.lastNotifiedOccurrenceMs = notify.occurrenceMs;
        }
      } catch (error) {
        logger.error('Failed to send or record reminder chunk:', error);
      }
    }
  }
}

module.exports = { deliverReminders, getOccurrenceToNotify };
