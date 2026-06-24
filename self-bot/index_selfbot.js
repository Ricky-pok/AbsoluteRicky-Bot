// Self-bot que monitorea el canal de Plasma Survival y reenvía eventos al
// bot-receptor-http vía su API HTTP local.
// IMPORTANTE: el token del usuario va en .env, NO hardcodeado aquí.
require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');

// ── Config desde .env ───────────────────────────────────────────────────────
const TOKEN_DE_USUARIO = process.env.TOKEN_DE_USUARIO;
const ALERT_API_TOKEN  = process.env.ALERT_API_TOKEN  || 'clove-http-test-token';
const HTTP_API_URL     = process.env.HTTP_API_URL     || 'http://localhost:3100';

if (!TOKEN_DE_USUARIO) {
  console.error('❌ Missing TOKEN_DE_USUARIO in .env');
  process.exit(1);
}

// IDs de bots de Plasma Survival que postean eventos
const ID_VALIDOS = [
  '1519054980848418988', // Double Coins
  '1308035892912328757', // Plasma Event
  '1237946463560929320', // PvP
];

// Canal original de Plasma Survival que se monitorea
const ID_CANAL_ORIGINAL = '1235041963191832697';

const client = new Client();
const procesados = new Set();

client.on('ready', () => {
  console.log(`✅ Self-bot conectado como ${client.user.username}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (
      ID_VALIDOS.includes(message.author?.id) &&
      message.channel?.id === ID_CANAL_ORIGINAL &&
      message.embeds?.length > 0 &&
      !procesados.has(message.id)
    ) {
      procesados.add(message.id);
      if (procesados.size > 500) procesados.delete(procesados.values().next().value);

      const embed = message.embeds[0];
      const titulo = embed.title || '';
      const descripcion = embed.description || '';
      const footer = embed.footer?.text || '';
      const campos = embed.fields?.map(f => `${f.name} ${f.value}`).join('\n') || '';
      const textoCompleto = `${titulo}\n${descripcion}\n${footer}\n${campos}`.toLowerCase();
      const ahora = new Date().toLocaleTimeString();

      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ALERT_API_TOKEN}`,
      };

      if (textoCompleto.includes('will be hosted in 2 hours')) {
        console.log(`⚡ [${ahora}] Detectado: DOUBLE COINS`);
        await fetch(`${HTTP_API_URL}/alerts/doublecoins`, { method: 'POST', headers, body: JSON.stringify({ content: titulo }) });
        console.log(`📨 [${ahora}] Alerta enviada via HTTP.`);
      } else if (textoCompleto.includes('arena has opened for 30 minutes')) {
        console.log(`⚡ [${ahora}] Detectado: ARENA PVP`);
        await fetch(`${HTTP_API_URL}/alerts/pvp-normal`, { method: 'POST', headers });
        console.log(`📨 [${ahora}] Alerta enviada via HTTP.`);
      } else if (textoCompleto.includes('plasma events live')) {
        console.log(`⚡ [${ahora}] Detectado: PLASMA EVENT`);
        await fetch(`${HTTP_API_URL}/alerts/plasma-event`, { method: 'POST', headers });
        console.log(`📨 [${ahora}] Alerta enviada via HTTP.`);
      }
    }
  } catch (err) {
    console.error('❌ Error en handler:', err);
  }
});

client.login(TOKEN_DE_USUARIO);
