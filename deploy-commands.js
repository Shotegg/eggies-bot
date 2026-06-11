require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show how to use the bot')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('events')
    .setDescription('List all saved events')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('event')
    .setDescription('Show details for a specific event')
    .addStringOption((option) =>
      option
        .setName('name')
        .setDescription('Event key (example: castle_war)')
        .setAutocomplete(true)
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('giftcode')
    .setDescription('Redeem a Kingshot gift code for one player')
    .addStringOption((option) =>
      option
        .setName('player_id')
        .setDescription('Kingshot Player ID')
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName('code')
        .setDescription('Gift code to redeem. Leave empty to sync active codes.')
        .setRequired(false)
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Deploying slash commands...');
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands
    });
    console.log('Slash commands deployed.');
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
