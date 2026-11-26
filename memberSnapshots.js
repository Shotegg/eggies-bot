const { getDiscordMemberSnapshot, saveDiscordMemberSnapshot } = require('./storage');

const memberSnapshotMaxAgeMs = 24 * 60 * 60 * 1000;
const memberSnapshotRetryMs = 5 * 60 * 1000;
const memberSnapshotCache = new Map();
const memberSnapshotRequests = new Map();
const memberSnapshotFailures = new Map();
async function getCurrentMemberSnapshot(guild) {
  if (memberSnapshotRequests.has(guild.id)) return memberSnapshotRequests.get(guild.id);
  const request = (async () => {
    let snapshot = memberSnapshotCache.get(guild.id);
    if (!snapshot) {
      snapshot = await getDiscordMemberSnapshot(guild.id);
      if (snapshot) memberSnapshotCache.set(guild.id, snapshot);
    }
    const fetchedAt = snapshot && Date.parse(snapshot.fetched_at);
    if (snapshot && Array.isArray(snapshot.members) && Number.isFinite(fetchedAt) && Date.now() - fetchedAt < memberSnapshotMaxAgeMs) return snapshot;
    if (Date.now() - (memberSnapshotFailures.get(guild.id) || 0) < memberSnapshotRetryMs) {
      throw new Error('Member list refresh recently failed; please try again in a few minutes.');
    }
    try {
      const members = await guild.members.fetch();
      const rows = members.map((member) => ({ id: member.id, bot: member.user.bot }));
      if (rows.length === 0 || (guild.memberCount && rows.length < guild.memberCount)) {
        throw new Error('Discord returned an incomplete member list.');
      }
      snapshot = await saveDiscordMemberSnapshot(guild.id, rows);
      memberSnapshotCache.set(guild.id, snapshot);
      memberSnapshotFailures.delete(guild.id);
      return snapshot;
    } catch (error) {
      memberSnapshotFailures.set(guild.id, Date.now());
      throw error;
    }
  })();
  memberSnapshotRequests.set(guild.id, request);
  try { return await request; } finally { memberSnapshotRequests.delete(guild.id); }
}

function scheduleMemberSnapshotRefresh(botClient, targetGuildId) {
  const refresh = async () => {
    try {
      const guild = await botClient.guilds.fetch(targetGuildId);
      await getCurrentMemberSnapshot(guild);
    } catch (error) {
      console.error('Failed to refresh Discord member snapshot:', error);
    }
    setTimeout(refresh, memberSnapshotRetryMs);
  };
  void refresh();
}


module.exports = { getCurrentMemberSnapshot, scheduleMemberSnapshotRefresh };
