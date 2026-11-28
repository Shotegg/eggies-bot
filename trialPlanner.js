const { randomUUID } = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } = require('discord.js');
const { getEggPlayers } = require('./storage');
const { fetchMigrantScores } = require('./mightPulse');

function assignLanes(players) {
  const lanes = { middle: [], hard: [], easy: [] };
  const scored = players.filter(p => p.score != null).sort((a, b) => b.score - a.score || String(a.playerId).localeCompare(String(b.playerId)));
  const unscored = players.filter(p => p.score == null);
  for (let i = unscored.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unscored[i], unscored[j]] = [unscored[j], unscored[i]];
  }
  [...scored, ...unscored].forEach((p, i) => {
    const lane = i < 6 ? ['middle', 'middle', 'hard', 'hard', 'easy', 'easy'][i] : ['middle', 'hard', 'easy'][(i - 6) % 3];
    lanes[lane].push(p);
  });
  return lanes;
}

function createTrialPlanner(isLeader, apiKey) {
  const sessions = new Map();
  const flags = MessageFlags.Ephemeral;
  function render(s) {
    const players = s.players.slice(s.page * 25, s.page * 25 + 25);
    const pages = Math.ceil(s.players.length / 25);
    const menu = new StringSelectMenuBuilder().setCustomId('trial:select:' + s.id).setPlaceholder('Select participants').setMinValues(0).setMaxValues(players.length)
      .addOptions(players.map(p => ({ label: (p.nickname || String(p.playerId)).slice(0, 100), description: 'ID: ' + p.playerId, value: String(p.playerId), default: s.selected.has(String(p.playerId)) })));
    const buttons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('trial:prev:' + s.id).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(s.page === 0),
      new ButtonBuilder().setCustomId('trial:next:' + s.id).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(s.page === pages - 1),
      new ButtonBuilder().setCustomId('trial:plan:' + s.id).setLabel('Create plan').setStyle(ButtonStyle.Primary).setDisabled(s.selected.size === 0)
    );
    return { content: 'Select participants; everyone is selected initially. Page ' + (s.page + 1) + '/' + pages + ' · ' + s.selected.size + ' selected.', components: [new ActionRowBuilder().addComponents(menu), buttons] };
  }
  async function session(interaction) {
    if (!isLeader(interaction)) { await interaction.reply({ content: 'Only leaders can use this action.', flags }); return null; }
    const s = sessions.get(interaction.customId.split(':')[2]);
    if (!s || s.userId !== interaction.user.id || Date.now() - s.created > 840000) {
      if (s && Date.now() - s.created > 840000) sessions.delete(s.id);
      await interaction.reply({ content: 'This planner has expired. Run /trialliiance again.', flags }); return null;
    }
    return s;
  }
  async function command(interaction) {
    if (!isLeader(interaction)) return interaction.reply({ content: 'Only leaders can use this command.', flags });
    await interaction.deferReply({ flags });
    try {
      if (!apiKey) return interaction.editReply('MightPulse API key is not configured.');
      const players = (await getEggPlayers()).sort((a, b) => (a.nickname || String(a.playerId)).localeCompare(b.nickname || String(b.playerId)));
      if (!players.length) return interaction.editReply('No EGG members found in the database.');
      for (const [id, old] of sessions) if (Date.now() - old.created > 840000) sessions.delete(id);
      const s = { id: randomUUID(), userId: interaction.user.id, players, selected: new Set(players.map(p => String(p.playerId))), page: 0, created: Date.now() };
      sessions.set(s.id, s);
      await interaction.editReply(render(s));
    } catch (error) { console.error('Trial planner:', error); await interaction.editReply('Could not load EGG members. Please try again.'); }
  }
  async function select(interaction) {
    const s = await session(interaction); if (!s) return;
    for (const p of s.players.slice(s.page * 25, s.page * 25 + 25)) s.selected.delete(String(p.playerId));
    for (const id of interaction.values) s.selected.add(id);
    await interaction.update(render(s));
  }
  async function button(interaction) {
    const s = await session(interaction); if (!s) return;
    const action = interaction.customId.split(':')[1];
    if (action === 'prev' || action === 'next') {
      s.page = Math.max(0, Math.min(s.page + (action === 'prev' ? -1 : 1), Math.ceil(s.players.length / 25) - 1));
      return interaction.update(render(s));
    }
    if (!s.selected.size) return interaction.reply({ content: 'Select at least one participant.', flags });
    const input = new TextInputBuilder().setCustomId('header').setLabel('Legion, date and time (UTC)').setPlaceholder('Legion 2 - 31.10. at 14 UTC').setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(true);
    return interaction.showModal(new ModalBuilder().setCustomId('trial:submit:' + s.id).setTitle('Trial of Alliance planner').addComponents(new ActionRowBuilder().addComponents(input)));
  }
  async function submit(interaction) {
    const s = await session(interaction); if (!s) return;
    const participants = s.players.filter(p => s.selected.has(String(p.playerId)));
    if (!participants.length) return interaction.reply({ content: 'Select at least one participant.', flags });
    await interaction.deferReply({ flags });
    try {
      const scores = await fetchMigrantScores(participants.map(p => String(p.playerId)), apiKey);
      const missing = participants.filter(p => !scores.has(String(p.playerId)));
      const lanes = assignLanes(participants.map(p => ({ ...p, score: scores.get(String(p.playerId)) })));
      const lines = ['👥 ' + interaction.fields.getTextInputValue('header').trim()];
      for (const [key, title] of [['hard', '🟡 Hard lane'], ['middle', '🔴 Middle lane'], ['easy', '🔵 Easy lane']]) {
        lines.push('', title, ...lanes[key].map((p, i) => (i + 1) + '. ' + (p.nickname || p.playerId)));
      }
      if (missing.length) lines.push('', "Didn't find migrant score for:", ...missing.map(p => '- ' + (p.nickname || p.playerId)));
      const chunks = []; let chunk = '';
      for (const line of lines) { if (chunk.length + line.length + 1 > 1900) { chunks.push(chunk); chunk = ''; } chunk += (chunk ? '\n' : '') + line; }
      if (chunk) chunks.push(chunk);
      await interaction.editReply({ content: chunks[0], allowedMentions: { parse: [] } });
      for (const content of chunks.slice(1)) await interaction.followUp({ content, flags, allowedMentions: { parse: [] } });
    } catch (error) { console.error('Trial planner scores:', error); await interaction.editReply('MightPulse request failed. Please try again later.'); }
  }
  return { command, select, button, submit };
}
module.exports = { createTrialPlanner, assignLanes };
