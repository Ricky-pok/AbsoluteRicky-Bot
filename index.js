// ═══════════════════════════════════════════════════════════════════════════
// AbsoluteRicky Bot — entry point
// Wiring: config → db (con schema + migración) → state → client → handlers
// Express API: /health, /events, /alerts/*, /messages/send, /tos, /privacy
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const express = require('express');

const { env, DATA_DIR } = require('./config');
const { client } = require('./client');
const { state } = require('./state');
require('./db');         // crea schema + migra JSON si hace falta
require('./handlers');   // registra todos los event handlers Discord
const { handleAlert } = require('./handlers');

// ── HTTP server ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Cache en memoria de HTML estáticos (tos, privacy)
const _htmlCache = {};

// Middleware de autenticación: si ALERT_API_TOKEN está set, exige Bearer token.
function requireAuth(req, res, next) {
  if (!env.ALERT_API_TOKEN) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (token !== env.ALERT_API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── Routes: HTML estático ───────────────────────────────────────────────────
app.get('/tos', (_req, res) => {
  try {
    if (!_htmlCache.tos) _htmlCache.tos = fs.readFileSync(path.join(DATA_DIR, 'public/tos.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(_htmlCache.tos);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.get('/privacy', (_req, res) => {
  try {
    if (!_htmlCache.privacy) _htmlCache.privacy = fs.readFileSync(path.join(DATA_DIR, 'public/privacy.html'), 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(_htmlCache.privacy);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ── Routes: health + events lectura ─────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    source: 'http-api',
    monitoredChannelId: env.MONITORED_CHANNEL_ID,
    importBotMessages: env.IMPORT_BOT_MESSAGES,
    oldBotUserIdConfigured: Boolean(env.OLD_BOT_USER_ID),
  });
});

app.get('/events/latest', (_req, res) => {
  res.json(state.events[0] ?? null);
});

app.get('/events', (req, res) => {
  const limit = Number(req.query.limit || 20);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  let result = [...state.events];
  if (since && !Number.isNaN(since.getTime())) {
    result = result.filter(e => new Date(e.createdAt) > since);
  }
  res.json(result.slice(0, limit));
});

// ── Routes: mensajes manuales y alertas ─────────────────────────────────────
app.post('/messages/send', requireAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Message text is required' });
    const canal = await client.channels.fetch(env.ID_CANAL_DESTINO);
    if (!canal) throw new Error('Canal destino no encontrado');
    await canal.send(text);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('❌ Error sending plain message:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/alerts/doublecoins', requireAuth, async (req, res) => {
  try {
    const contenido = String(req.body?.content || '').trim();
    const body = `${contenido} Double Coins will be hosted in 2 hours in Plasma Survival`.trim();
    const event = await handleAlert({
      type: 'doublecoins', title: 'Double Coins', body,
      roleId: env.ID_DEL_ROL,
      decorate: (text) => `💀 ${text}`,
    });
    res.status(201).json({ ok: true, event });
  } catch (err) {
    console.error('❌ Error handling doublecoins alert:', err);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

app.post('/alerts/pvp-normal', requireAuth, async (_req, res) => {
  try {
    const body = 'The AntiMatter PvP Arena has opened! Battle players for plasma coins and kills! ⚔️🔥';
    const event = await handleAlert({
      type: 'pvp_normal', title: 'PvP Normal', body,
      roleId: env.ID_PVP_NORMAL_ROL,
    });
    res.status(201).json({ ok: true, event });
  } catch (err) {
    console.error('❌ Error handling PvP Normal alert:', err);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

app.post('/alerts/plasma-event', requireAuth, async (_req, res) => {
  try {
    const body = 'Plasma events are being hosted! Come and join to win some shiny plasma coins!';
    const event = await handleAlert({
      type: 'plasma_event', title: 'Plasma Event', body,
      roleId: env.ID_PVP_EVENT_ROL,
      decorate: (text) => `${text} ❗ ⭐`,
    });
    res.status(201).json({ ok: true, event });
  } catch (err) {
    console.error('❌ Error handling plasma event alert:', err);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

// ── Startup ─────────────────────────────────────────────────────────────────
app.listen(env.PORT, () => {
  console.log(`🌐 HTTP API listening on port ${env.PORT}`);
});

// Cierre limpio del bot
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received — closing Discord gateway cleanly');
  client.destroy();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received — closing Discord gateway cleanly');
  client.destroy();
  process.exit(0);
});

// Conectar a Discord
client.login(env.TOKEN_BOT_RECEPTOR);
