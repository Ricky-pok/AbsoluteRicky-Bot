// Singletons compartidos: Discord client + Google Vision OCR client.
// Cualquier módulo puede importarlos sin necesidad de wiring manual.
const { Client, GatewayIntentBits } = require('discord.js');
const { ImageAnnotatorClient } = require('@google-cloud/vision');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const visionClient = new ImageAnnotatorClient();

module.exports = { client, visionClient };
