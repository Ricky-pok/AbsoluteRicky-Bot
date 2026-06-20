// Carga variables de entorno desde .env y exporta constantes globales del bot.
// Todas las constantes inmutables del bot viven aquí.
require('dotenv').config();
const path = require('path');

// ── Variables de entorno (validadas) ─────────────────────────────────────────
const env = {
  TOKEN_BOT_RECEPTOR:   process.env.TOKEN_BOT_RECEPTOR,
  ID_CANAL_DESTINO:     process.env.ID_CANAL_DESTINO,
  ID_DEL_ROL:           process.env.ID_DEL_ROL,
  ID_PVP_NORMAL_ROL:    process.env.ID_PVP_NORMAL_ROL,
  ID_PVP_EVENT_ROL:     process.env.ID_PVP_EVENT_ROL,
  ALERT_API_TOKEN:      process.env.ALERT_API_TOKEN,
  MONITORED_CHANNEL_ID: process.env.MONITORED_CHANNEL_ID || process.env.ID_CANAL_DESTINO,
  OLD_BOT_USER_ID:      process.env.OLD_BOT_USER_ID || '',
  MUTED_ROLE_ID:        process.env.MUTED_ROLE_ID || '',
  OWNER_ID:             process.env.OWNER_ID || '',
  SAFE_BROWSING_API_KEY: process.env.SAFE_BROWSING_API_KEY || '',
  IMPORT_BOT_MESSAGES:  String(process.env.IMPORT_BOT_MESSAGES || 'true').toLowerCase() !== 'false',
  PORT:                 Number(process.env.PORT || 3100),
};

if (!env.TOKEN_BOT_RECEPTOR || !env.ID_CANAL_DESTINO) {
  console.error('❌ Missing required env vars: TOKEN_BOT_RECEPTOR and ID_CANAL_DESTINO');
  process.exit(1);
}

// ── Prefijos de comandos ─────────────────────────────────────────────────────
const PREFIX       = '$ricky';
const PREFIX_SHORT = '$r';

// ── Rutas a archivos JSON (safety net para migración inicial) ────────────────
const DATA_DIR     = __dirname;
const EVENTS_FILE  = path.join(DATA_DIR, 'events.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const LOGS_FILE    = path.join(DATA_DIR, 'logs.json');
const AUTOMOD_FILE = path.join(DATA_DIR, 'automod.json');
const DB_FILE      = path.join(DATA_DIR, 'bot.db');

// ── Límites ──────────────────────────────────────────────────────────────────
const MAX_EVENTS = 100;
const MAX_LOGS   = 200;

// Mutes pueden durar hasta 3 meses (cap por seguridad)
const MAX_MUTE_MS = 90 * 24 * 60 * 60 * 1000;

// ── Rate limiting ────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW   = 60_000;
const RATE_LIMIT_MAX      = 10;
const RATE_LIMIT_COOLDOWN = 60_000;

module.exports = {
  env,
  PREFIX, PREFIX_SHORT,
  DATA_DIR, EVENTS_FILE, CHANNELS_FILE, LOGS_FILE, AUTOMOD_FILE, DB_FILE,
  MAX_EVENTS, MAX_LOGS, MAX_MUTE_MS,
  RATE_LIMIT_WINDOW, RATE_LIMIT_MAX, RATE_LIMIT_COOLDOWN,
};
