const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const eventsPath = path.join(dataDir, 'events.json');
const remindersPath = path.join(dataDir, 'reminders.json');
const eventDetailsPath = path.join(dataDir, 'event-details.json');

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Failed to read ${filePath}:`, error);
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getEvents() {
  return readJson(eventsPath, []);
}

function getEventByKey(key) {
  const events = getEvents();
  return events.find((event) => event.key === key);
}

function saveEvents(events) {
  writeJson(eventsPath, events);
}

function getReminders() {
  return readJson(remindersPath, []);
}

function saveReminders(reminders) {
  writeJson(remindersPath, reminders);
}

function getEventDetailsMap() {
  return readJson(eventDetailsPath, {});
}

function getEventDetailsByKey(key) {
  const map = getEventDetailsMap();
  return map[key] || null;
}

module.exports = {
  getEvents,
  getEventByKey,
  saveEvents,
  getReminders,
  saveReminders,
  getEventDetailsByKey
};
