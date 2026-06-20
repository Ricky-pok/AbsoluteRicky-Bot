// ════════════════════════════════════════════════════════════════════════════════
// AbsoluteRicky Bot — index_bot_receptor_http.js
// Bot de Discord con AutoMod (LinkGuard), comandos de moderación, sistema de
// eventos de Graal Online Era, y API HTTP para notificaciones externas.
// ════════════════════════════════════════════════════════════════════════════════

// Carga las variables de entorno desde el archivo .env (tokens, IDs, claves API)
require('dotenv').config();

// Módulos nativos de Node.js para leer/escribir archivos y construir rutas
const fs = require('fs');
const path = require('path');

// Express es el servidor HTTP que usamos para recibir alertas desde apps externas
const express = require('express');

// discord.js — librería principal para conectar con Discord
// Client: la instancia del bot
// GatewayIntentBits: permisos de eventos que el bot necesita escuchar
// ChannelType: tipos de canal (texto, voz, etc.)
// PermissionFlagsBits: flags de permisos para verificar en interacciones
// ActionRowBuilder / ButtonBuilder / ButtonStyle: para crear botones en mensajes
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

// Google Cloud Vision — API de OCR para leer texto dentro de imágenes adjuntas
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const visionClient = new ImageAnnotatorClient(); // cliente listo para hacer llamadas OCR

// ── Servidor HTTP ─────────────────────────────────────────────────────────────
const app = express();
const port = Number(process.env.PORT || 3100); // puerto 3100 por defecto
app.use(express.json()); // permite leer cuerpos JSON en los requests

// ── Cliente de Discord ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,        // acceso a servidores (guilds)
    GatewayIntentBits.GuildMessages, // ver mensajes en canales
    GatewayIntentBits.MessageContent,// leer el contenido de los mensajes (privado por Discord)
    GatewayIntentBits.GuildMembers,  // acceso a miembros del servidor (para mutes, kicks, etc.)
  ],
});

// ── Variables de entorno ──────────────────────────────────────────────────────
// Todas vienen del archivo .env en el servidor VM
const TOKEN_BOT_RECEPTOR   = process.env.TOKEN_BOT_RECEPTOR;   // token del bot de Discord
const ID_CANAL_DESTINO     = process.env.ID_CANAL_DESTINO;     // canal donde se envían las alertas de Graal
const ID_DEL_ROL           = process.env.ID_DEL_ROL;           // rol que se menciona en alertas de Double Coins
const ID_PVP_NORMAL_ROL    = process.env.ID_PVP_NORMAL_ROL;    // rol para alertas de PvP
const ID_PVP_EVENT_ROL     = process.env.ID_PVP_EVENT_ROL;     // rol para alertas de Plasma Event
const ALERT_API_TOKEN      = process.env.ALERT_API_TOKEN;      // token de autenticación para la API HTTP
const MONITORED_CHANNEL_ID = process.env.MONITORED_CHANNEL_ID || ID_CANAL_DESTINO; // canal que el bot monitorea para importar eventos
const OLD_BOT_USER_ID      = process.env.OLD_BOT_USER_ID || '';   // si se pone, solo importa mensajes de ese bot específico
const MUTED_ROLE_ID        = process.env.MUTED_ROLE_ID || '';     // ID fijo del rol muted (opcional, si no se usa búsqueda por nombre)
const OWNER_ID             = process.env.OWNER_ID || '';           // ID del dueño del bot (para comandos privados como $ricky logs)
const SAFE_BROWSING_API_KEY= process.env.SAFE_BROWSING_API_KEY || ''; // clave de Google Safe Browsing (opcional, para detección extra)
const IMPORT_BOT_MESSAGES  = String(process.env.IMPORT_BOT_MESSAGES || 'true').toLowerCase() !== 'false'; // si debe importar mensajes de bots del canal monitoreado

// Prefijos que activan comandos del bot
const PREFIX       = '$ricky';
const PREFIX_SHORT = '$r';

// Si faltan las variables críticas, el bot no puede funcionar — abortar
if (!TOKEN_BOT_RECEPTOR || !ID_CANAL_DESTINO) {
  console.error('❌ Missing required environment variables: TOKEN_BOT_RECEPTOR and ID_CANAL_DESTINO are required.');
  process.exit(1);
}

// ── Rutas a archivos JSON de persistencia ────────────────────────────────────
// Todos los datos se guardan en archivos JSON en la misma carpeta del bot
const EVENTS_FILE  = path.join(__dirname, 'events.json');   // historial de eventos de Graal
const CHANNELS_FILE= path.join(__dirname, 'channels.json'); // canales suscritos a eventos
const LOGS_FILE    = path.join(__dirname, 'logs.json');     // logs de comandos y moderación
const AUTOMOD_FILE = path.join(__dirname, 'automod.json');  // configuración de AutoMod por servidor
const MAX_EVENTS   = 100;   // máximo de eventos guardados en memoria/disco
const _htmlCache   = {};    // caché en memoria de las páginas HTML estáticas (tos, privacy)

// ── Inicialización SQLite ─────────────────────────────────────────────────────
// SQLite reemplazará progresivamente los archivos JSON. En esta fase solo creamos
// las tablas vacías. La lógica del bot sigue leyendo y escribiendo a los JSON
// como antes — esta fase es puramente aditiva, no rompe nada.
const Database = require('better-sqlite3');
const DB_FILE  = path.join(__dirname, 'bot.db');
const db       = new Database(DB_FILE);

// WAL mode: escrituras más rápidas y lecturas no bloquean escrituras
db.pragma('journal_mode = WAL');
// Habilita foreign keys (necesario para el CASCADE en channel_event_subscriptions)
db.pragma('foreign_keys = ON');

// Crea las tablas si no existen — idempotente, seguro correr en cada arranque
db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id                 TEXT PRIMARY KEY,
    type               TEXT NOT NULL,
    title              TEXT NOT NULL,
    body               TEXT NOT NULL,
    source             TEXT NOT NULL DEFAULT 'http-api',
    created_at         TEXT NOT NULL,
    discord_message_id TEXT
  );

  CREATE TABLE IF NOT EXISTS subscribed_channels (
    channel_id   TEXT PRIMARY KEY,
    guild_id     TEXT NOT NULL,
    guild_name   TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    added_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channel_event_subscriptions (
    channel_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    PRIMARY KEY (channel_id, event_type),
    FOREIGN KEY (channel_id) REFERENCES subscribed_channels(channel_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    type      TEXT NOT NULL,
    at        TEXT NOT NULL,
    action    TEXT,
    target    TEXT,
    target_id TEXT,
    guild     TEXT,
    guild_id  TEXT,
    extra     TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS automod_config (
    guild_id             TEXT PRIMARY KEY,
    enabled              INTEGER NOT NULL DEFAULT 0,
    log_channel_id       TEXT,
    mod_alert_channel_id TEXT,
    mute_duration        INTEGER
  );

  CREATE TABLE IF NOT EXISTS active_mutes (
    key        TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    guild_id   TEXT NOT NULL,
    reason     TEXT NOT NULL,
    muted_by   TEXT NOT NULL,
    muted_at   INTEGER NOT NULL,
    expires_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_events_type        ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_created_at  ON events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_type          ON logs(type);
  CREATE INDEX IF NOT EXISTS idx_active_mutes_guild ON active_mutes(guild_id);
`);

console.log(`✅ SQLite ready: ${DB_FILE}`);

// ── Prepared statements (cacheados, mucho más rápidos que parsear SQL cada vez) ─
const _stmtUpsertEvent = db.prepare(`
  INSERT OR REPLACE INTO events (id, type, title, body, source, created_at, discord_message_id)
  VALUES (@id, @type, @title, @body, @source, @createdAt, @discordMessageId)
`);
const _stmtTrimEvents = db.prepare(`
  DELETE FROM events WHERE id NOT IN (
    SELECT id FROM events ORDER BY created_at DESC LIMIT ?
  )
`);
const _stmtUpsertChannel = db.prepare(`
  INSERT OR IGNORE INTO subscribed_channels (channel_id, guild_id, guild_name, channel_name, added_at)
  VALUES (@channelId, @guildId, @guildName, @channelName, @addedAt)
`);
const _stmtAddSub = db.prepare(`
  INSERT OR IGNORE INTO channel_event_subscriptions (channel_id, event_type) VALUES (?, ?)
`);
const _stmtRemoveSub = db.prepare(`
  DELETE FROM channel_event_subscriptions WHERE channel_id = ? AND event_type = ?
`);
const _stmtDeleteChannel = db.prepare(`DELETE FROM subscribed_channels WHERE channel_id = ?`);
const _stmtInsertLog = db.prepare(`
  INSERT INTO logs (type, at, action, target, target_id, guild, guild_id, extra)
  VALUES (@type, @at, @action, @target, @targetId, @guild, @guildId, @extra)
`);
const _stmtTrimLogs = db.prepare(`
  DELETE FROM logs WHERE id NOT IN (
    SELECT id FROM logs ORDER BY at DESC LIMIT ?
  )
`);
const _stmtUpsertAutomod = db.prepare(`
  INSERT INTO automod_config (guild_id, enabled, log_channel_id, mod_alert_channel_id, mute_duration)
  VALUES (@guildId, @enabled, @logChannelId, @modAlertChannelId, @muteDuration)
  ON CONFLICT(guild_id) DO UPDATE SET
    enabled              = excluded.enabled,
    log_channel_id       = excluded.log_channel_id,
    mod_alert_channel_id = excluded.mod_alert_channel_id,
    mute_duration        = excluded.mute_duration
`);
const _stmtUpsertMute = db.prepare(`
  INSERT OR REPLACE INTO active_mutes (key, user_id, guild_id, reason, muted_by, muted_at, expires_at)
  VALUES (@key, @userId, @guildId, @reason, @mutedBy, @mutedAt, @expiresAt)
`);
const _stmtDeleteMute = db.prepare(`DELETE FROM active_mutes WHERE key = ?`);

// Persiste la configuración de AutoMod de un servidor en la DB
function persistAutomodConfig(guildId) {
  const cfg = automodConfig[guildId] || {};
  _stmtUpsertAutomod.run({
    guildId,
    enabled:           cfg.enabled ? 1 : 0,
    logChannelId:      cfg.logChannelId      || null,
    modAlertChannelId: cfg.modAlertChannelId || null,
    muteDuration:      cfg.muteDuration      || null,
  });
}

// Persiste un registro de mute activo en la DB
function persistActiveMute(key, info) {
  const [userId, guildId] = key.split('_');
  _stmtUpsertMute.run({
    key, userId, guildId,
    reason:    info.reason,
    mutedBy:   info.mutedBy,
    mutedAt:   info.mutedAt,
    expiresAt: info.expiresAt || null,
  });
}

// ── Rate Limiting ─────────────────────────────────────────────────────────────
// Evita que un usuario spam-use comandos. Máximo 10 comandos por minuto.
// Si lo supera, queda bloqueado 60 segundos adicionales.
const RATE_LIMIT_WINDOW   = 60_000;  // ventana de 60 segundos
const RATE_LIMIT_MAX      = 10;      // máximo 10 comandos por ventana
const RATE_LIMIT_COOLDOWN = 60_000;  // bloqueado 60s si supera el límite
const _rateLimits = new Map();       // userId → { count, windowStart, blockedUntil }

// Limpia entradas expiradas cada 5 minutos para no acumular memoria
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _rateLimits) {
    if (entry.blockedUntil < now && (now - entry.windowStart) > RATE_LIMIT_WINDOW) {
      _rateLimits.delete(id);
    }
  }
}, 5 * 60 * 1000);

// Retorna true si el usuario está bloqueado por rate limit
function isRateLimited(userId) {
  const now = Date.now();
  const entry = _rateLimits.get(userId) || { count: 0, windowStart: now, blockedUntil: 0 };

  // Si está en cooldown activo, rechazar
  if (entry.blockedUntil > now) return true;

  // Ventana expirada — reiniciar contador
  if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
    _rateLimits.set(userId, { count: 1, windowStart: now, blockedUntil: 0 });
    return false;
  }

  // Incrementar contador dentro de la ventana actual
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    // Supera el límite — bloquear por RATE_LIMIT_COOLDOWN ms
    entry.blockedUntil = now + RATE_LIMIT_COOLDOWN;
    _rateLimits.set(userId, entry);
    return true;
  }

  _rateLimits.set(userId, entry);
  return false;
}
// ── Fin Rate Limiting ─────────────────────────────────────────────────────────


// Carga un archivo JSON del disco. Mantenido como safety net para la migración
// si alguien borra bot.db — permite re-importar desde los JSON originales.
function loadJsonArray(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Datos en memoria cargados desde SQLite al iniciar ────────────────────────
// events: ordenados newest-first, limitados a MAX_EVENTS
let events = db.prepare(`
  SELECT id, type, title, body, source,
         created_at AS createdAt,
         discord_message_id AS discordMessageId
  FROM events ORDER BY created_at DESC LIMIT ?
`).all(MAX_EVENTS);

// subscribedChannels: reconstruye el shape original con events: [] desde la tabla normalizada
const _rawChannels = db.prepare(`
  SELECT channel_id AS channelId, guild_id AS guildId,
         guild_name AS guildName, channel_name AS channelName,
         added_at AS addedAt
  FROM subscribed_channels
`).all();
const _channelSubs = db.prepare(`
  SELECT channel_id AS channelId, event_type AS eventType
  FROM channel_event_subscriptions
`).all();
const _subsByChannel = {};
for (const s of _channelSubs) {
  if (!_subsByChannel[s.channelId]) _subsByChannel[s.channelId] = [];
  _subsByChannel[s.channelId].push(s.eventType);
}
let subscribedChannels = _rawChannels.map(c => ({
  ...c,
  events: _subsByChannel[c.channelId] || [],
}));

// botLogs: campos fijos + spread de la columna extra JSON para los campos variables
const MAX_LOGS = 200; // máximo de entradas que guardamos
let botLogs = db.prepare(`
  SELECT type, at, action, target,
         target_id AS targetId,
         guild, guild_id AS guildId, extra
  FROM logs ORDER BY at DESC LIMIT ?
`).all(MAX_LOGS).map(row => {
  let extra = {};
  try { extra = JSON.parse(row.extra || '{}'); } catch { extra = {}; }
  const { extra: _drop, ...base } = row;
  return { ...base, ...extra };
});

// Agrega una entrada al log y la persiste en SQLite.
// type: 'mod' (moderación) o 'command' (comandos)
// data: objeto con detalles (campos fijos se mapean a columnas, resto va a extra JSON)
function addLog(type, data) {
  const entry = { type, ...data, at: new Date().toISOString() };
  botLogs = [entry, ...botLogs].slice(0, MAX_LOGS);

  const { type: _t, at, action, target, targetId, guild, guildId, ...rest } = entry;
  _stmtInsertLog.run({
    type: type || 'unknown',
    at,
    action:   action   || null,
    target:   target   || null,
    targetId: targetId || null,
    guild:    guild    || null,
    guildId:  guildId  || null,
    extra: JSON.stringify(rest),
  });
  _stmtTrimLogs.run(MAX_LOGS);
}

// automodConfig: objeto { [guildId]: { enabled, logChannelId, modAlertChannelId, muteDuration } }
let automodConfig = {};
for (const row of db.prepare('SELECT * FROM automod_config').all()) {
  automodConfig[row.guild_id] = {
    enabled:           Boolean(row.enabled),
    logChannelId:      row.log_channel_id      || null,
    modAlertChannelId: row.mod_alert_channel_id || null,
    muteDuration:      row.mute_duration       || null,
  };
}

// ── Migración one-shot JSON → SQLite ──────────────────────────────────────────
// Lee los JSON directamente del disco y los importa a SQLite.
// Solo corre si las tablas están vacías — idempotente, safety net si se borra bot.db.
// Usa transacciones (10-100x más rápido que inserts individuales).
function runJsonMigration() {
  const tablesEmpty =
    db.prepare('SELECT COUNT(*) AS c FROM events').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM devices').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM logs').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM automod_config').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM subscribed_channels').get().c === 0;

  if (!tablesEmpty) return; // tablas ya con datos — nada que hacer

  // Lee los JSON directamente (safety net si bot.db fue eliminado)
  const jsonEvents   = loadJsonArray(EVENTS_FILE);
  const jsonChannels = loadJsonArray(CHANNELS_FILE);
  const jsonLogs     = loadJsonArray(LOGS_FILE);
  let jsonAutomod = {};
  try {
    const r = fs.readFileSync(AUTOMOD_FILE, 'utf8');
    const p = JSON.parse(r);
    if (p && typeof p === 'object' && !Array.isArray(p)) jsonAutomod = p;
  } catch { /* archivo no existe — ok */ }

  const hasJsonData =
    jsonEvents.length > 0 ||
    jsonChannels.length > 0 ||
    jsonLogs.length > 0 ||
    Object.keys(jsonAutomod).length > 0;

  if (!hasJsonData) return; // ni JSON ni DB tienen datos — primer arranque limpio

  console.log('🔄 Iniciando migración one-shot JSON → SQLite...');

  if (jsonEvents.length > 0) {
    db.transaction((rows) => {
      for (const e of rows) {
        _stmtUpsertEvent.run({
          id: e.id,
          type: e.type,
          title: e.title,
          body: e.body,
          source: e.source || 'http-api',
          createdAt: e.createdAt,
          discordMessageId: e.discordMessageId || null,
        });
      }
    })(jsonEvents);
    console.log(`  ✅ events: ${jsonEvents.length} migrados`);
  }

  if (jsonChannels.length > 0) {
    db.transaction((rows) => {
      for (const c of rows) {
        _stmtUpsertChannel.run({
          channelId: c.channelId,
          guildId: c.guildId,
          guildName: c.guildName,
          channelName: c.channelName,
          addedAt: c.addedAt,
        });
        for (const evType of (c.events || [])) {
          _stmtAddSub.run(c.channelId, evType);
        }
      }
    })(jsonChannels);
    console.log(`  ✅ subscribed_channels: ${jsonChannels.length} migrados`);
  }

  if (jsonLogs.length > 0) {
    db.transaction((rows) => {
      for (const l of rows) {
        const { type, at, action, target, targetId, guild, guildId, ...rest } = l;
        _stmtInsertLog.run({
          type: type || 'unknown',
          at: at || new Date().toISOString(),
          action: action || null,
          target: target || null,
          targetId: targetId || null,
          guild: guild || null,
          guildId: guildId || null,
          extra: JSON.stringify(rest),
        });
      }
    })(jsonLogs);
    console.log(`  ✅ logs: ${jsonLogs.length} migrados`);
  }

  const automodEntries = Object.entries(jsonAutomod);
  if (automodEntries.length > 0) {
    db.transaction((entries) => {
      for (const [guildId, cfg] of entries) {
        _stmtUpsertAutomod.run({
          guildId,
          enabled: cfg.enabled ? 1 : 0,
          logChannelId: cfg.logChannelId || null,
          modAlertChannelId: cfg.modAlertChannelId || null,
          muteDuration: cfg.muteDuration || null,
        });
      }
    })(automodEntries);
    console.log(`  ✅ automod_config: ${automodEntries.length} migrados`);
  }

  console.log('✅ Migración JSON → SQLite completada.');
}

runJsonMigration();

// ── Sistema de inmunidad post-unmute ─────────────────────────────────────────
// Cuando un mod desmutea a alguien manualmente desde el panel de botones,
// ese usuario queda inmune durante 2 horas: el AutoMod lo detecta pero NO lo mutea,
// solo deja pasar el mensaje y registra en el log que fue skipped por inmunidad.
// Esto evita que el bot remutee a alguien que el mod acaba de liberar.

// userId_guildId -> timestamp when immunity expires
const immuneUsers = new Map();

// Retorna true si el usuario tiene inmunidad activa en ese servidor
function isImmune(userId, guildId) {
  const key = userId + '_' + guildId;
  const until = immuneUsers.get(key);
  if (!until) return false;
  if (Date.now() >= until) { immuneUsers.delete(key); return false; } // ya expiró — limpiar
  return true;
}

// Activa la inmunidad por 2 horas para el usuario en ese servidor
function setImmune(userId, guildId) {
  immuneUsers.set(userId + '_' + guildId, Date.now() + 2 * 60 * 60 * 1000);
}

// ── Duración de mutes ─────────────────────────────────────────────────────────
const MAX_MUTE_MS = 90 * 24 * 60 * 60 * 1000;

function parseDuration(str) {
  if (!str || typeof str !== 'string') return null;
  const units = {
    months: 30*24*3600, month: 30*24*3600, mo: 30*24*3600,
    weeks: 7*24*3600, week: 7*24*3600, w: 7*24*3600,
    days: 86400, day: 86400, d: 86400,
    hours: 3600, hour: 3600, h: 3600,
    minutes: 60, minute: 60, min: 60, m: 60,
    seconds: 1, second: 1, s: 1,
  };
  const re = /(\d+)\s*(months?|mo|weeks?|w|days?|d|hours?|h|minutes?|min|m|seconds?|s)/gi;
  let total = 0, matched = false, match;
  while ((match = re.exec(str.trim())) !== null) {
    const val = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    if (units[unit]) { total += val * units[unit]; matched = true; }
  }
  if (!matched || total === 0) return null;
  return Math.min(total * 1000, MAX_MUTE_MS);
}

// Convierte milisegundos a string legible: "1h 30m", "2d", "45m", etc.
function formatDuration(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  // filtra los ceros (ej: si d=0, no aparece "0d")
  return [d&&`${d}d`, h&&`${h}h`, m&&`${m}m`, s&&`${s}s`].filter(Boolean).join(' ');
}

// ── Registro de mutes activos y timers ───────────────────────────────────────

// userId_guildId → ID del setTimeout. Sirve para cancelar el timer si se desmutea antes de que expire.
const muteTimers = new Map();

// userId_guildId → { reason, mutedBy, mutedAt, expiresAt|null }
// Registro de todos los mutes activos. Lo usa $ricky mutes para mostrar la lista.
// Se carga desde SQLite al arrancar — los mutes ya no se pierden en restarts.
const activeMutes = new Map();
for (const row of db.prepare('SELECT * FROM active_mutes').all()) {
  activeMutes.set(row.key, {
    reason:    row.reason,
    mutedBy:   row.muted_by,
    mutedAt:   row.muted_at,
    expiresAt: row.expires_at,
  });
}

// Programa la remoción automática del rol muted después de durationMs milisegundos.
// Si ya había un timer para ese usuario, lo cancela primero para evitar doble unmute.
function scheduleMuteExpiry(member, role, durationMs) {
  const key = member.id + '_' + member.guild.id;
  if (muteTimers.has(key)) clearTimeout(muteTimers.get(key)); // cancela timer anterior
  const timer = setTimeout(async () => {
    muteTimers.delete(key);  // borra el timer del mapa
    activeMutes.delete(key); // borra el registro del mute activo en memoria
    _stmtDeleteMute.run(key); // y también en DB
    try {
      await member.guild.members.fetch(member.id); // refresca el miembro desde Discord
      const freshMember = member.guild.members.cache.get(member.id);
      if (freshMember && freshMember.roles.cache.has(role.id)) {
        await freshMember.roles.remove(role, 'Mute duration expired'); // quita el rol muted
        console.log(`⏱️ Auto-unmuted ${member.user.tag} in ${member.guild.name} (duration expired)`);
      }
    } catch (err) {
      console.error('❌ Auto-unmute failed:', err.message);
    }
  }, durationMs);
  muteTimers.set(key, timer); // guarda el timer para poder cancelarlo si se desmutea antes
}

// Set con los IDs de mensajes de Discord ya procesados como eventos.
// Evita importar el mismo evento dos veces si el bot se reinicia.
const seenDiscordMessageIds = new Set(
  events.map((event) => event.discordMessageId).filter(Boolean)
);

// Crea y guarda un nuevo evento (Double Coins, PvP, Plasma, etc.)
// extra puede incluir: id personalizado, source, createdAt, discordMessageId
function addEvent(type, title, body, extra = {}) {
  const event = {
    id: extra.id || `evt_${Date.now()}`,   // ID único, puede venir de afuera (ej: discord_<messageId>)
    type,                                   // 'doublecoins' | 'pvp_normal' | 'plasma_event'
    title,
    body,
    source: extra.source || 'http-api',    // de dónde vino: 'http-api' o 'discord:<userId>'
    createdAt: extra.createdAt || new Date().toISOString(),
    discordMessageId: extra.discordMessageId || null,
  };

  // Registra el ID para no volver a importarlo
  if (event.discordMessageId) seenDiscordMessageIds.add(event.discordMessageId);

  // Pone el nuevo evento al principio en memoria y descarta los más viejos
  events = [event, ...events.filter((existing) => existing.id !== event.id)].slice(0, MAX_EVENTS);

  // Persiste a SQLite (síncrono — sin debounce, sin race conditions)
  _stmtUpsertEvent.run(event);
  _stmtTrimEvents.run(MAX_EVENTS);

  return event;
}

// Middleware de autenticación para los endpoints HTTP.
// Si ALERT_API_TOKEN está configurado, exige un header "Authorization: Bearer <token>".
// Si no está configurado, deja pasar todo (modo sin autenticación).
function requireAuth(req, res, next) {
  if (!ALERT_API_TOKEN) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (token !== ALERT_API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Envía un mensaje al canal principal de Graal (ID_CANAL_DESTINO).
// Si se pasa roleId, menciona ese rol antes del contenido.
async function sendAlert(roleId, content) {
  const canal = await client.channels.fetch(ID_CANAL_DESTINO);
  if (!canal) throw new Error('Canal destino no encontrado');
  const prefix = roleId ? `<@&${roleId}> ` : '';
  await canal.send(`${prefix}${content}`.trim());
}

// Orquesta el envío de una alerta de Graal desde la API HTTP:
// 1. Aplica decoración opcional al texto (ej: agregar emojis)
// 2. Envía al canal principal con mención de rol
// 3. Broadcast a todos los canales suscritos en otros servidores
// 4. Guarda el evento en el historial
async function handleAlert({ type, title, body, roleId, decorate }) {
  const content = decorate ? decorate(body) : body;
  await sendAlert(roleId, content);         // canal principal con @rol
  _recentEventTypes.set(type, Date.now());  // evita que messageCreate re-broadcaste este evento
  await broadcastEvent(type, content);      // otros servidores suscritos (sin @rol)
  return addEvent(type, title, body, { source: 'http-api' });
}

// Limpia el texto de un mensaje Discord para analizarlo:
// quita menciones de rol (@&123...), colapsa espacios múltiples, trim
function normalizeContent(text) {
  return String(text || '')
    .replace(/<@&\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Detecta si un mensaje de Discord es un evento de Graal Online Era y lo clasifica.
// Busca palabras clave específicas de los mensajes que manda el juego.
// Retorna { type, title, body } o null si no es un evento reconocido.
function classifyDiscordMessage(text) {
  const normalized = normalizeContent(text);
  const lower = normalized.toLowerCase();

  if (lower.includes('double coins')) {
    return { type: 'doublecoins', title: 'Double Coins', body: normalized };
  }

  if (lower.includes('antimatter pvp arena') || lower.includes('pvp arena has opened')) {
    return { type: 'pvp_normal', title: 'PvP Normal', body: normalized };
  }

  if (lower.includes('plasma events are being hosted') || lower.includes('join to win some shiny plasma coins')) {
    return { type: 'plasma_event', title: 'Plasma Event', body: normalized };
  }

  return null; // mensaje no es un evento de Graal
}

// Decide si el bot debe importar este mensaje de Discord como evento.
// Filtros: importación habilitada, canal correcto, bot correcto, no visto antes.
function shouldImportDiscordMessage(message) {
  if (!IMPORT_BOT_MESSAGES) return false;                                      // importación desactivada en .env
  if (!message?.author) return false;                                          // mensaje sin autor (raro)
  if (message.channelId !== MONITORED_CHANNEL_ID) return false;               // no es el canal monitoreado
  if (OLD_BOT_USER_ID && message.author.id !== OLD_BOT_USER_ID) return false; // no es el bot específico configurado
  if (!OLD_BOT_USER_ID && !message.author.bot) return false;                  // si no hay bot específico, solo acepta bots
  if (seenDiscordMessageIds.has(message.id)) return false;                    // ya fue procesado antes
  return true;
}

// ── Sistema de eventos de Graal Online Era ────────────────────────────────────

// Aliases para que $ricky subscribe acepte nombres amigables como "dc", "pvp", "plasma"
const EVENT_ALIASES = {
  doublecoins: 'doublecoins',
  dc:           'doublecoins',      // alias corto para Double Coins
  pvp:          'pvp_normal',
  pvpnormal:    'pvp_normal',
  plasma:       'plasma_event',
  'plasma-event': 'plasma_event',
};
const ALL_EVENT_TYPES = ['doublecoins', 'pvp_normal', 'plasma_event']; // todos los tipos existentes
const EVENT_LABELS = {
  doublecoins:  'Double Coins',
  pvp_normal:   'PvP Normal',
  plasma_event: 'Plasma Event',
};

// Manda el contenido del evento a todos los canales que estén suscritos a ese tipo.
// Se usa tanto cuando llega un evento por API HTTP como cuando se detecta en Discord.
async function broadcastEvent(eventType, content) {
  const targets = subscribedChannels.filter((c) => c.events.includes(eventType));
  await Promise.all(targets.map(async (target) => {
    try {
      const channel = await client.channels.fetch(target.channelId).catch(() => null);
      if (channel) await channel.send(content);
    } catch (err) {
      console.error(`❌ Failed to broadcast to channel ${target.channelId}:`, err.message);
    }
  }));
}

// ── AutoMod ───────────────────────────────────────────────────────────────────

// Dominios NSFW (tube, cams, creators, hentai)
const NSFW_DOMAINS = new Set([
  'pornhub.com','xvideos.com','xhamster.com','xnxx.com','redtube.com','youporn.com',
  'tube8.com','spankbang.com','eporner.com','tnaflix.com','slutload.com','porndig.com',
  'beeg.com','drtuber.com','sunporno.com','hclips.com','porntrex.com','txxx.com',
  'anysex.com','fuq.com','faphouse.com','ah-me.com','perfectgirls.xxx','empflix.com',
  '4tube.com','hardsextube.com','pornid.xxx','analdin.com','vjav.com','javhd.com',
  'chaturbate.com','cam4.com','myfreecams.com','stripchat.com','livejasmin.com',
  'bongacams.com','streamate.com','camsoda.com','flirt4free.com','imlive.com',
  'jasmin.com','camdolls.com','camonster.com','cams.com','camplace.com',
  'onlyfans.com','fansly.com','manyvids.com','clips4sale.com','loyalfans.com',
  'fancentro.com','frisk.chat','4fans.com','unlockd.com','justforfans.com',
  'nhentai.net','e-hentai.org','g.e-hentai.org','gelbooru.com','rule34.xxx',
  'rule34.paheal.net','danbooru.donmai.us','yande.re','sankakucomplex.com',
  'hanime.tv','hentaihaven.xxx','hentai2read.com','luscious.net','fakku.net',
  'doujins.com','hentaifox.com','imhentai.xxx','hitomi.la','hentaiera.com',
  'bangbros.com','brazzers.com','realitykings.com','naughtyamerica.com',
  'digitalplayground.com','teamskeet.com','nubiles.net','mofos.com',
  'sex.com','xart.com','met-art.com','hegre.com',
]);

// TLD (.xxx .porn .adult .sex .sexy .nude) — cualquier URL con estos sufijos es NSFW
const ADULT_TLD_PATTERN = /\.(?:xxx|porn|adult|sex|sexy|nude)(?:[/?#]|$)/i;

// Palabras que en el subdominio o ruta de una URL indican contenido adulto
const NSFW_URL_KEYWORDS = ['porn','xxx','hentai','nsfw','nude','naked','onlyfan','chaturbat','camgirl'];

// Lista viva de dominios maliciosos — se actualiza cada 6h desde GitHub.
// Combina dos listas públicas: Discord-AntiScam y discord-phishing-links (~39k dominios)
let liveBlocklist = new Set();

// Descarga las dos listas desde GitHub y reconstruye liveBlocklist.
// Se llama al arrancar y luego cada 6 horas automáticamente.
async function refreshLiveBlocklist() {
  try {
    const [scamRes, phishRes] = await Promise.all([
      fetch('https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.json', { signal: AbortSignal.timeout(10000) }),
      fetch('https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/domain-list.json', { signal: AbortSignal.timeout(10000) }),
    ]);
    const scamList  = await scamRes.json();
    const phishData = await phishRes.json();
    // Combina ambas listas en un Set para búsqueda O(1)
    liveBlocklist = new Set([
      ...(Array.isArray(scamList) ? scamList : []),
      ...(Array.isArray(phishData.domains) ? phishData.domains : []),
    ]);
    console.log(`🛡️ Live blocklist refreshed: ${liveBlocklist.size} domains`);
  } catch (err) {
    console.error('❌ Live blocklist refresh failed:', err.message);
  }
}

// Verifica si un hostname está en la lista viva, revisando también subdominios.
// Ejemplo: "evil.discord.com" → chequea "evil.discord.com" y "discord.com"
function isInLiveBlocklist(hostname) {
  if (liveBlocklist.has(hostname)) return true;
  const parts = hostname.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (liveBlocklist.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// Consulta Google Safe Browsing API con todas las URLs de un mensaje en una sola llamada.
// Es opcional — solo se activa si SAFE_BROWSING_API_KEY está en el .env.
// Detecta malware, phishing y software no deseado que no estén en nuestras listas locales.
async function checkSafeBrowsingBatch(urls) {
  if (!SAFE_BROWSING_API_KEY || !urls.length) return [];
  try {
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${SAFE_BROWSING_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(6000), // timeout de 6 segundos para no bloquear el bot
        body: JSON.stringify({
          client: { clientId: 'discord-bot', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: urls.map(url => ({ url })), // todas las URLs del mensaje a la vez
          },
        }),
      }
    );
    const data = await res.json();
    return data.matches || []; // retorna los matches encontrados (o [] si está limpio)
  } catch { return []; }
}

// Fragmentos que suelen aparecer en dominios de scam (Nitro falso, Steam fake, robux, etc.)
const SCAM_DOMAIN_FRAGMENTS = [
  'discordnitro','discord-nitro','free-nitro','nitro-discord','discord-gift',
  'discordgift','nitro-free','freenitro','claimnitro','nitroclaim','getnitro',
  'steamgift','steam-gift','freegift','free-steam','steamtrade','steamtrd',
  'csgo-skins','csgoskins','csgofree','free-robux','freerobux','robux-free',
  'epicfree','free-vbucks','vbucks-free','roblox-free',
  'rexawin','crypto-casino','cryptocasino','casinocrypto','casino-crypto',
];

// Dominios legítimos a proteger contra typosquatting
const TRUSTED_DOMAINS = [
  'discord.com','discordapp.com','discord.gg',
  'steamcommunity.com','steampowered.com',
];

// Patrones de texto scam con soporte leetspeak
const SCAM_TEXT_PATTERNS = [
  { re: /fr[e3][e3]\s*n[i1]tr[o0]/i,                                    label: 'Free Nitro Scam' },
  { re: /cl[a4][i1]m[i1]ng\s*(your?)?\s*n[i1]tr[o0]/i,                 label: 'Nitro Claim Scam' },
  { re: /y[o0]u\s*(h[a4]v[e3]\s*)?w[o0]n.*n[i1]tr[o0]/i,              label: 'You Won Nitro Scam' },
  { re: /n[i1]tr[o0]\s*(g[i1]v[e3][a4]w[a4]y|r[e3]w[a4]rd|pr[i1]z[e3])/i, label: 'Nitro Giveaway Scam' },
  { re: /g[e3]t\s*n[i1]tr[o0]\s*(f[o0]r\s*)?fr[e3][e3]/i,             label: 'Get Nitro Free Scam' },
  { re: /[s5]t[e3][a4]m\s*g[i1]ft\s*c[a4]rd/i,                        label: 'Steam Gift Card Scam' },
  { re: /fr[e3][e3]\s*[s5]t[e3][a4]m\s*(w[a4]ll[e3]t|k[e3]y|g[a4]m[e3])/i, label: 'Free Steam Scam' },
  { re: /cl[a4][i1]m\s*(your?)?\s*(fr[e3][e3]\s*)?(r[e3]w[a4]rd|pr[i1]z[e3]|g[i1]ft)/i, label: 'Claim Prize Scam' },
  { re: /[a4][i1]rdr[o0]p\s*(cry?pt[o0]|t[o0]k[e3]n|nft)/i,           label: 'Crypto Airdrop Scam' },
  { re: /[s5][e3]nd\s*\d*\.?\d+\s*(eth|btc|bnb|usdt).*r[e3]c[e3][i1]v[e3]/i, label: 'Crypto Doubling Scam' },
  { re: /l[i1]nk\s*(your?)?\s*[s5]t[e3][a4]m.*n[i1]tr[o0]/i,          label: 'Steam-Nitro Link Scam' },
  { re: /d[i1][s5]c[o0]rd\s*(x|and)\s*[s5]t[e3][a4]m\s*c[o0]ll[a4]b/i, label: 'Discord x Steam Collab Scam' },
  { re: /cryptocurrency\s+casino/i,                                   label: 'Crypto Casino Scam' },
  { re: /giving\s+away\s+\$[\d,]+\s+to\s+everyone/i,            label: 'Fake Mass Giveaway' },
  { re: /withdrawal.{0,20}was\s+successful/i,                         label: 'Fake Withdrawal Proof' },
  { re: /rexawin/i,                                                    label: 'Known Scam Site (Rexawin)' },
  { re: /enter\s+(the\s+)?special\s+promo\s+code/i,               label: 'Fake Promo Code Scam' },
];

// Caché para no consultar la API de Discord cada vez que aparece el mismo invite.
// Se guarda el resultado por 5 minutos (INVITE_CACHE_TTL).
const inviteCache = new Map();
const INVITE_CACHE_TTL = 5 * 60 * 1000;

// Convierte un hostname a forma canónica para comparación.
// Elimina caracteres invisibles, unicode confusables, y convierte leetspeak a letras normales.
// Ejemplo: "d1sc0rd.com" → "discord.com"
function normalizeDomain(domain) {
  return domain
    .toLowerCase()
    .normalize('NFKC')                          // normaliza Unicode (ej: caracteres griegos que parecen latinos)
    .replace(/[​-‍؜᠎﻿­]/g, '')               // elimina caracteres invisibles usados para evadir filtros
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/@/g, 'a');                        // @ se puede usar en lugar de 'a' en leetspeak
}

// Algoritmo de Levenshtein — mide la "distancia" entre dos strings.
// Cuántas letras hay que cambiar/agregar/borrar para ir de 'a' a 'b'.
// Se usa para detectar typosquatting (ej: "discrod.com" vs "discord.com" = distancia 1)
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

// Compara el hostname normalizado contra cada dominio confiable.
// Si la distancia es <= 2 (casi igual pero no exacto), es typosquatting.
// Retorna un objeto de violación o null si es legítimo.
function checkTyposquatting(hostname) {
  const norm = normalizeDomain(hostname);
  for (const trusted of TRUSTED_DOMAINS) {
    const normTrusted = normalizeDomain(trusted);
    if (norm === normTrusted) return null; // es el dominio real — seguro
    if (levenshtein(norm, normTrusted) <= 2) {
      return { type: 'phishing', label: `Phishing — spoofing ${trusted}`, url: hostname };
    }
  }
  return null;
}

// Verifica si un código de invite de Discord apunta a un servidor NSFW.
// Usa caché de 5 minutos para no abusar la API de Discord con el mismo código.
// nsfwLevel: DEFAULT=0, EXPLICIT=1 (bloqueado), SAFE=2, AGE_RESTRICTED=3 (bloqueado)
async function checkDiscordInvite(code) {
  const cached = inviteCache.get(code);
  if (cached && Date.now() - cached.ts < INVITE_CACHE_TTL) return cached.result; // retorna desde caché
  try {
    const invite = await client.fetchInvite(code);
    let result = null;
    if (invite.guild) {
      if (invite.guild.nsfwLevel === 1 || invite.guild.nsfwLevel === 3) {
        result = { type: 'nsfw_invite', label: 'NSFW Discord Server Invite', url: `discord.gg/${code}` };
      }
    }
    if (inviteCache.size >= 500) inviteCache.delete(inviteCache.keys().next().value); // evita crecer infinito
    inviteCache.set(code, { result, ts: Date.now() });
    return result;
  } catch {
    if (inviteCache.size >= 500) inviteCache.delete(inviteCache.keys().next().value);
    inviteCache.set(code, { result: null, ts: Date.now() }); // cachea el error también (invite inválido = no NSFW)
    return null;
  }
}

// ── detectViolation — motor principal de detección ───────────────────────────
// Analiza el contenido de un mensaje de texto y detecta NSFW o scam.
// Pasa por 10 capas de detección en orden de velocidad (las más rápidas primero).
// Retorna { type, label, url } si encontró algo, o null si está limpio.
async function detectViolation(content) {
  const urls = content.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const safeBrowsingCandidates = [];
  for (const rawUrl of urls) {
    let parsed, hostname;
    try { parsed = new URL(rawUrl); hostname = parsed.hostname.toLowerCase(); } catch { continue; }
    const normHost = normalizeDomain(hostname);

    // 1. TLD adulto (.xxx .porn .adult .sex .sexy .nude)
    if (ADULT_TLD_PATTERN.test(rawUrl)) {
      return { type: 'nsfw', label: 'NSFW / Adult TLD', url: rawUrl };
    }

    // 2. Palabras clave NSFW en subdominio o ruta
    const urlPath = (hostname + parsed.pathname).toLowerCase();
    if (NSFW_URL_KEYWORDS.some((kw) => urlPath.includes(kw))) {
      return { type: 'nsfw', label: 'NSFW / Adult Content', url: rawUrl };
    }

    // 3. Dominio NSFW de la lista hardcodeada (exacto o normalizado)
    if (NSFW_DOMAINS.has(hostname) || NSFW_DOMAINS.has(normHost)) {
      return { type: 'nsfw', label: 'NSFW / Adult Content', url: rawUrl };
    }
    for (const d of NSFW_DOMAINS) {
      if (normHost.endsWith('.' + normalizeDomain(d))) {
        return { type: 'nsfw', label: 'NSFW / Adult Content', url: rawUrl };
      }
    }

    // 4. Lista viva de dominios maliciosos (GitHub, actualizada cada 6h)
    if (isInLiveBlocklist(hostname)) {
      return { type: 'scam', label: 'Known Malicious Domain', url: rawUrl };
    }

    // 5. Fragmento de dominio scam
    for (const frag of SCAM_DOMAIN_FRAGMENTS) {
      if (normHost.includes(frag)) {
        return { type: 'scam', label: 'Scam Domain', url: rawUrl };
      }
    }

    // 6. Phishing/typosquatting de Discord o Steam
    const typo = checkTyposquatting(hostname);
    if (typo) return typo;

    // 7. Collect URL for batch Safe Browsing check (done below)
    safeBrowsingCandidates.push(rawUrl);
  }

  // 7b. Batch Safe Browsing check (one HTTP call for all URLs)
  if (safeBrowsingCandidates.length > 0) {
    const matches = await checkSafeBrowsingBatch(safeBrowsingCandidates);
    if (matches.length > 0) {
      return { type: 'scam', label: `Threat Detected: ${matches[0].threatType}`, url: matches[0].threat.url };
    }
  }

  // 8. Patrones de texto scam (funciona con texto plano extraído por OCR)
  for (const { re, label } of SCAM_TEXT_PATTERNS) {
    if (re.test(content)) return { type: 'scam', label, url: null };
  }

  // 9. Dominios scam mencionados sin https:// (texto plano de OCR)
  const plainDomains = content.match(/\b[\w-]+\.(?:com|net|org|io|gg|win|xyz|site|online|app)\b/gi) || [];
  for (const domain of plainDomains) {
    const normD = normalizeDomain(domain);
    for (const frag of SCAM_DOMAIN_FRAGMENTS) {
      if (normD.includes(frag)) return { type: 'scam', label: 'Scam Domain', url: domain };
    }
    if (isInLiveBlocklist(domain)) return { type: 'scam', label: 'Known Malicious Domain', url: domain };
  }

  // 10. Invites de Discord NSFW verificados via API
  const inviteRegex = /discord(?:(?:app)?\.com\/invite|\.gg(?:\/invite)?)\/([a-zA-Z0-9\-]{2,32})/gi;
  let m;
  while ((m = inviteRegex.exec(content)) !== null) {
    const result = await checkDiscordInvite(m[1]);
    if (result) return result;
  }

  return null;
}

// Llama a Google Cloud Vision para extraer todo el texto visible en una imagen.
// Retorna el texto como string, o '' si la imagen no tiene texto o falla la API.
async function extractTextFromImage(imageUrl) {
  try {
    const [result] = await visionClient.textDetection({ image: { source: { imageUri: imageUrl } } });
    return result.textAnnotations?.[0]?.description || '';
  } catch (err) {
    console.error('\u274c Vision OCR failed:', err.message);
    return '';
  }
}

// Analiza todas las imágenes adjuntas a un mensaje buscando links o texto scam via OCR.
// Procesa todas en paralelo (Promise.all) y retorna la primera violación encontrada.
async function detectViolationInImages(attachments) {
  const images = attachments.filter(a => {
    const ct = a.contentType ?? a.content_type ?? '';
    return !ct || ct.startsWith('image/');
  });
  if (!images.length) return null;
  const results = await Promise.all(images.map(async (attachment) => {
    try {
      const text = await extractTextFromImage(attachment.url);
      if (!text) return null;
      const violation = await detectViolationFromOCR(text);
      return violation ? { ...violation, source: 'image-ocr' } : null;
    } catch (err) {
      console.error('❌ Image scan failed:', err.message);
      return null;
    }
  }));
  return results.find(r => r !== null) ?? null;
}


// Versión RESTRINGIDA de detección para texto de OCR (imágenes).
// NO aplica SCAM_TEXT_PATTERNS — frases como "Claim your reward" aparecen en apps
// legítimas (ej: Graal Online) y causarían falsos positivos masivos en screenshots.
// Solo analiza URLs con https:// y dominios escritos en el texto de la imagen.
async function detectViolationFromOCR(text) {
  const urls = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (const rawUrl of urls) {
    let parsed, hostname;
    try { parsed = new URL(rawUrl); hostname = parsed.hostname.toLowerCase(); } catch { continue; }
    const normHost = normalizeDomain(hostname);
    if (ADULT_TLD_PATTERN.test(rawUrl)) return { type: 'nsfw', label: 'NSFW / Adult TLD', url: rawUrl };
    const urlPath = (hostname + parsed.pathname).toLowerCase();
    if (NSFW_URL_KEYWORDS.some(kw => urlPath.includes(kw))) return { type: 'nsfw', label: 'NSFW / Adult Content', url: rawUrl };
    if (NSFW_DOMAINS.has(hostname) || NSFW_DOMAINS.has(normHost)) return { type: 'nsfw', label: 'NSFW / Adult Content', url: rawUrl };
    for (const d of NSFW_DOMAINS) {
      if (normHost.endsWith('.' + normalizeDomain(d))) return { type: 'nsfw', label: 'NSFW / Adult Content', url: rawUrl };
    }
    if (isInLiveBlocklist(hostname)) return { type: 'scam', label: 'Known Malicious Domain', url: rawUrl };
    for (const frag of SCAM_DOMAIN_FRAGMENTS) {
      if (normHost.includes(frag)) return { type: 'scam', label: 'Scam Domain', url: rawUrl };
    }
    const typo = checkTyposquatting(hostname);
    if (typo) return typo;
  }
  const plainDomains = text.match(/\b[\w-]+\.(?:com|net|org|io|gg|win|xyz|site|online|app)\b/gi) || [];
  for (const domain of plainDomains) {
    const normD = normalizeDomain(domain);
    for (const frag of SCAM_DOMAIN_FRAGMENTS) {
      if (normD.includes(frag)) return { type: 'scam', label: 'Scam Domain', url: domain };
    }
    if (isInLiveBlocklist(domain)) return { type: 'scam', label: 'Known Malicious Domain', url: domain };
  }
  return null;
}

// Motor principal del AutoMod. Se llama en cada mensaje de cada servidor.
// Flujo:
//   1. Ignorar bots y DMs
//   2. Verificar si el servidor tiene AutoMod activado
//   3. Analizar texto del mensaje, imágenes adjuntas, y mensajes forwarded
//   4. Si hay violación y el usuario tiene inmunidad: solo logear, dejar pasar
//   5. Si no hay inmunidad: borrar mensaje, mutar al usuario, notificar log y mod channel
async function checkAutomod(message) {
  if (message.author.bot) return; // ignorar mensajes de otros bots
  if (!message.guild) return;     // ignorar DMs (solo aplica en servidores)

  const config = automodConfig[message.guild.id];
  if (!config?.enabled) return;

let violation = await detectViolation(message.content);
  if (!violation && message.attachments.size > 0) {
    violation = await detectViolationInImages([...message.attachments.values()]);
  }
  // Mensajes forwarded: fetch raw desde la API de Discord para bypassear discord.js mapping
  if (!violation && message.messageSnapshots?.size > 0) {
    try {
      const rawRes = await fetch(
        `https://discord.com/api/v10/channels/${message.channelId}/messages/${message.id}`,
        { headers: { Authorization: `Bot ${TOKEN_BOT_RECEPTOR}` }, signal: AbortSignal.timeout(5000) }
      );
      if (rawRes.ok) {
        const rawData = await rawRes.json();
        const snapMsg = rawData.message_snapshots?.[0]?.message;
        if (snapMsg) {
          if (snapMsg.content) violation = await detectViolation(snapMsg.content);
          if (!violation && snapMsg.attachments?.length > 0) {
            violation = await detectViolationInImages(snapMsg.attachments.map(a => ({
              url: a.url,
              contentType: a.content_type ?? 'image/jpeg',
            })));
          }
        }
      }
    } catch (err) {
      console.error('❌ Failed to fetch forwarded message raw data:', err.message);
    }
  }
  if (!violation) return;

  // Si el usuario tiene inmunidad activa: mensaje pasa, no se mutea, solo log
  if (isImmune(message.author.id, message.guild.id)) {
    const immuneKey = message.author.id + '_' + message.guild.id;
    const immuneUntil = immuneUsers.get(immuneKey);
    addLog('mod', {
      action: 'automod_skipped_immunity',
      target: message.author.tag,
      targetId: message.author.id,
      violationType: violation.type,
      label: violation.label,
      url: violation.url || 'N/A',
      guild: message.guild.name,
      guildId: message.guild.id,
    });
    if (config.logChannelId) {
      const logCh = await client.channels.fetch(config.logChannelId).catch(() => null);
      if (logCh) {
        await logCh.send({ embeds: [{
          color: 0x5865f2,
          title: '🛡️ AutoMod — Action skipped (immunity active)',
          thumbnail: { url: message.author.displayAvatarURL() },
          fields: [
            { name: '👤 Usuario',         value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
            { name: '⚠️ Detected',        value: violation.label, inline: true },
            { name: '📍 Canal',           value: `<#${message.channel.id}>`, inline: true },
            { name: '🔇 Action',          value: '🛡️ Mute skipped  •  💬 Message allowed', inline: false },
            { name: '⏱️ Immunity expires', value: immuneUntil ? `<t:${Math.floor(immuneUntil/1000)}:R>` : 'soon', inline: false },
            ...(violation.url ? [{ name: '🔗 Link detectado', value: `\`${violation.url.slice(0,300)}\``, inline: false }] : []),
          ],
          timestamp: new Date().toISOString(),
          footer: { text: `AutoMod • ${message.guild.name}` },
        }] }).catch(() => {});
      }
    }
    return;
  }

  // Sin inmunidad: flujo normal
  await message.delete().catch(() => {});

  let muted = false;
  try {
    const isNSFW = violation.type === 'nsfw' || violation.type === 'nsfw_invite';
    const mutedRole = isNSFW
      ? await getOrCreateNSFWMutedRole(message.guild)
      : await getOrCreateMutedRole(message.guild);
    if (!message.member.roles.cache.has(mutedRole.id)) {
      await message.member.roles.add(mutedRole, `AutoMod: ${violation.label}`);
      muted = true;
      // Programa unmute automático si el servidor tiene muteDuration configurado
      const autoMuteDuration = config.muteDuration;
      if (autoMuteDuration) scheduleMuteExpiry(message.member, mutedRole, autoMuteDuration);
      // Registrar mute activo (memoria + DB)
      const _muteKey = message.author.id + '_' + message.guild.id;
      const _muteInfo = {
        reason: violation.label,
        mutedBy: 'AutoMod',
        mutedAt: Date.now(),
        expiresAt: autoMuteDuration ? Date.now() + autoMuteDuration : null,
      };
      activeMutes.set(_muteKey, _muteInfo);
      persistActiveMute(_muteKey, _muteInfo);
    }
  } catch (err) {
    console.error('❌ AutoMod mute failed:', err.message);
  }

  // Log interno
  addLog('mod', {
    action: 'automod',
    target: message.author.tag,
    targetId: message.author.id,
    violationType: violation.type,
    label: violation.label,
    url: violation.url || 'N/A',
    guild: message.guild.name,
    guildId: message.guild.id,
  });

  // Alerta al canal de log configurado
  if (config.logChannelId) {
    const logChannel = await client.channels.fetch(config.logChannelId).catch(() => null);
    if (logChannel) {
      const colorMap = { nsfw: 0xff0055, scam: 0xff6600, phishing: 0xff0000, nsfw_invite: 0xcc00ff, shortener: 0xffcc00, evasion: 0x888888 };
      const embed = {
        color: colorMap[violation.type] || 0xff3333,
        title: '🚨 AutoMod Alert',
        thumbnail: { url: message.author.displayAvatarURL() },
        fields: [
          { name: '👤 User',    value: `<@${message.author.id}>\n${message.author.tag}`, inline: true },
          { name: '⚠️ Type',   value: violation.label,                                   inline: true },
          { name: '📍 Channel', value: `<#${message.channel.id}>`,                        inline: true },
          { name: '🔨 Action',  value: `🗑️ Message deleted${muted ? '  •  🔇 User muted' : '  •  ⚠️ Warning only'}`, inline: false },
          ...(violation.url ? [{ name: '🔗 Link', value: `\`${violation.url.slice(0, 300)}\``, inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `AutoMod  •  ${message.guild.name}` },
      };
      await logChannel.send({ embeds: [embed] });
    }
  }

  // Mod action panel con botones Unmute / Ban
  if (config.modAlertChannelId && muted) {
    const modAlertCh = await client.channels.fetch(config.modAlertChannelId).catch(() => null);
    if (modAlertCh) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`automod_unmute_${message.author.id}_${message.guild.id}`)
          .setLabel('Unmute')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`automod_ban_${message.author.id}_${message.guild.id}`)
          .setLabel('Ban')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🔨'),
      );
      const modEmbed = {
        color: 0xff6600,
        title: '⚠️ AutoMod — Action required',
        description: 'The user was automatically muted. What should we do?',
        thumbnail: { url: message.author.displayAvatarURL() },
        fields: [
          { name: '👤 Usuario', value: `<@${message.author.id}> (${message.author.tag})`, inline: true },
          { name: '⚠️ Reason',  value: violation.label, inline: true },
          { name: '📍 Canal',   value: `<#${message.channel.id}>`, inline: true },
          ...(violation.url ? [{ name: '🔗 Link', value: `\`${violation.url.slice(0, 200)}\``, inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `AutoMod • ${message.guild.name}` },
      };
      await modAlertCh.send({ embeds: [modEmbed], components: [row] }).catch(() => {});
    }
  }

  console.log(`🛡️ AutoMod [${violation.type}]: ${message.author.tag} in ${message.guild.name}`);
}

// ── Fin AutoMod ────────────────────────────────────────────────────────────────

// Busca el rol "ABSOLUTE RICKY MUTE ROLE | NSFW" en el servidor o lo crea si no existe.
// Si encuentra un rol con el nombre viejo ("Muted | NSFW"), lo renombra automáticamente.
// Al crear el rol, aplica la restricción de SendMessages en todos los canales de texto y voz.
async function getOrCreateNSFWMutedRole(guild) {
  let role = guild.roles.cache.find((r) => r.name === 'ABSOLUTE RICKY MUTE ROLE | NSFW' || r.name === 'Muted | NSFW');
  if (role && role.name === 'Muted | NSFW') {
    try { await role.edit({ name: 'ABSOLUTE RICKY MUTE ROLE | NSFW' }); } catch (_) {}
  }
  if (!role) {
    role = await guild.roles.create({
      name: 'ABSOLUTE RICKY MUTE ROLE | NSFW',
      color: 0xff0055,
      permissions: [],
      reason: 'Auto-created for NSFW violations',
    });
    for (const [, channel] of guild.channels.cache) {
      if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        await channel.permissionOverwrites.create(role, {
          SendMessages: false,
          AddReactions: false,
        }).catch(() => {});
      }
    }
  }
  return role;
}

// Busca el rol "ABSOLUTE RICKY MUTE ROLE" en el servidor o lo crea si no existe.
// Si existe con el nombre viejo ("Muted"), lo renombra. Busca por MUTED_ROLE_ID del .env primero.
// Al crear, aplica override de permisos en todos los canales (texto, voz y stage) para bloquear mensajes.
async function getOrCreateMutedRole(guild) {
  let role = MUTED_ROLE_ID
    ? guild.roles.cache.get(MUTED_ROLE_ID)
    : guild.roles.cache.find((r) => r.name === 'ABSOLUTE RICKY MUTE ROLE' || r.name.toLowerCase() === 'muted');

  // Si encontró el rol con nombre viejo, renombrarlo
  if (role && role.name.toLowerCase() === 'muted') {
    try { await role.edit({ name: 'ABSOLUTE RICKY MUTE ROLE' }); } catch (_) {}
  }

  if (!role) {
    role = await guild.roles.create({
      name: 'ABSOLUTE RICKY MUTE ROLE',
      color: 0x808080,
      permissions: [],
      reason: 'Auto-created for mute command',
    });
    // Aplica denegación de mensajes en todos los canales de texto
    for (const [, channel] of guild.channels.cache) {
      if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        await channel.permissionOverwrites.create(role, {
          SendMessages: false,
          AddReactions: false,
        }).catch(() => {});
      }
    }
  }

  return role;
}

let BOT_READY_AT = 0;

// Reconstruye los setTimeout de mutes activos después de un restart.
// Los timers son objetos en memoria — se pierden al reiniciar, pero la DB persiste.
// Esta función lee active_mutes y vuelve a programar la expiración con el tiempo restante.
async function _rebuildMuteTimers() {
  const now = Date.now();
  let rebuilt = 0, expired = 0, cleaned = 0;

  for (const [key, info] of activeMutes) {
    if (!info.expiresAt) continue; // mute permanente — no hay timer que reconstruir

    const remaining = info.expiresAt - now;
    if (remaining <= 0) {
      // Expiró mientras el bot estaba apagado — limpia memoria y DB
      activeMutes.delete(key);
      _stmtDeleteMute.run(key);
      expired++;
      continue;
    }

    const [userId, guildId] = key.split('_');
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) { cleaned++; continue; }
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        // Usuario ya no está en el servidor — limpia registro
        activeMutes.delete(key);
        _stmtDeleteMute.run(key);
        cleaned++;
        continue;
      }
      const mutedRole = await getOrCreateMutedRole(guild);
      if (!member.roles.cache.has(mutedRole.id)) {
        // El rol ya fue quitado manualmente — limpia registro
        activeMutes.delete(key);
        _stmtDeleteMute.run(key);
        cleaned++;
        continue;
      }
      scheduleMuteExpiry(member, mutedRole, remaining);
      rebuilt++;
    } catch (err) {
      console.error(`❌ Rebuild timer failed for ${key}:`, err.message);
    }
  }

  if (rebuilt > 0 || expired > 0 || cleaned > 0) {
    console.log(`⏱️ Mute timers reconstruidos: ${rebuilt} activos, ${expired} expirados, ${cleaned} limpiados`);
  }
}

// Se ejecuta una sola vez cuando el bot se conecta exitosamente a Discord.
// Arranca la blocklist, programa su refresco cada 6h, y migra roles viejos.
client.on('ready', () => {
  BOT_READY_AT = Date.now();
  console.log(`✅ Bot receptor HTTP conectado como ${client.user.tag}`);
  refreshLiveBlocklist();
  setInterval(refreshLiveBlocklist, 6 * 60 * 60 * 1000);

  // Reconstruir timers de mutes que sobrevivieron al restart (Fase 6)
  // Sin esto, los mutes con expiración nunca se levantarían si el bot reinicia.
  _rebuildMuteTimers();

  // Migración: renombrar roles Muted/Muted | NSFW al nuevo nombre en todos los servidores
  setTimeout(async () => {
    let renamed = 0;
    for (const [, guild] of client.guilds.cache) {
      try {
        const oldMuted = guild.roles.cache.find(r => r.name === 'Muted');
        if (oldMuted) { await oldMuted.edit({ name: 'ABSOLUTE RICKY MUTE ROLE' }); renamed++; }
        const oldNsfw = guild.roles.cache.find(r => r.name === 'Muted | NSFW');
        if (oldNsfw) { await oldNsfw.edit({ name: 'ABSOLUTE RICKY MUTE ROLE | NSFW' }); renamed++; }
      } catch (_) {}
    }
    if (renamed > 0) console.log('Renamed ' + renamed + ' muted role(s) to new names across all guilds');
  }, 3000);
  console.log(`👀 Watching channel ${MONITORED_CHANNEL_ID} for Discord alerts`);
  if (OLD_BOT_USER_ID) {
    console.log(`🤖 Filtering to old bot user ID ${OLD_BOT_USER_ID}`);
  } else {
    console.log('🤖 OLD_BOT_USER_ID not set; importing matching messages from any bot in the monitored channel');
  }
});

// Set de IDs de mensajes ya procesados — evita procesar el mismo mensaje dos veces
// si Discord lo envía duplicado por reconexión del gateway.
const _processedMsgIds = new Set();
const _processedMsgQueue = []; // cola para limpiar _processedMsgIds cuando supera 500 entradas
const _recentEventTypes = new Map(); // tipo de evento → timestamp. Evita broadcast duplicado en 30s

// Se ejecuta cada vez que se envía un mensaje en cualquier canal donde el bot tiene acceso.
// Hace dos cosas: 1) pasa el mensaje por AutoMod, 2) procesa comandos si empieza con $ricky/$r
client.on('messageCreate', async (message) => {
  if (_processedMsgIds.has(message.id)) return;
  _processedMsgIds.add(message.id);
  _processedMsgQueue.push(message.id);
  if (_processedMsgQueue.length > 500) _processedMsgIds.delete(_processedMsgQueue.shift());
  // Drop replayed events from session resume — only process messages sent after the bot started
  if (message.createdTimestamp < BOT_READY_AT) return;

  try {
    // Revisa automod antes de cualquier otra cosa
    await checkAutomod(message);

    // Maneja comandos de prefijo
    const _contentLower = message.content.toLowerCase();
    const _usedPrefix = _contentLower.startsWith(PREFIX.toLowerCase())
      ? PREFIX
      : _contentLower.startsWith(PREFIX_SHORT.toLowerCase() + ' ') || _contentLower === PREFIX_SHORT.toLowerCase()
        ? PREFIX_SHORT
        : null;
    if (!message.author.bot && _usedPrefix) {
      const args = message.content.slice(_usedPrefix.length).trim().split(/\s+/);
      const command = args.shift().toLowerCase();

      // Registra uso del comando
      addLog('command', {
        command,
        args: args.slice(),
        user: message.author.tag,
        userId: message.author.id,
        guild: message.guild?.name || 'DM',
        guildId: message.guild?.id || null,
        channel: message.channel.name || null,
      });

      // Silenciosamente ignora si el usuario está spameando
      if (isRateLimited(message.author.id)) return;

      if (command === 'ping') {
        const sent = await message.reply('🏓 Pinging...');
        await sent.edit(`🏓 Pong! Latency: **${client.ws.ping}ms**`);
        return;
      }

      if (command === 'help') {
        const embedGeneral = {
          color: 0x5865f2,
          title: '📋 AbsoluteRicky Bot — Commands',
          description: 'Prefix: `$ricky` or `$r`',
          fields: [
            // General
            { name: '┌ 🤖  General', value: '​', inline: false },
            { name: '`$ricky ping`',          value: 'Check if the bot is online and show latency.',      inline: true },
            { name: '`$ricky help`',          value: 'Show this command list.',                            inline: true },
            { name: '`$ricky stats`',         value: 'Show member and bot count for this server.',        inline: true },
            { name: '`$ricky avatar [@user]`',value: 'Show your avatar or another user\'s.',              inline: true },
            { name: '`$ricky purge [1-50]`',  value: 'Delete up to 50 messages in this channel.',        inline: true },
            // Moderation
            { name: '┌ 🛡️  Moderation', value: '​', inline: false },
            { name: '`$ricky kick @user [reason]`',            value: 'Kick a member from the server.',                                                                     inline: false },
            { name: '`$ricky ban @user [reason]`',             value: 'Ban a member from the server.',                                                                      inline: false },
            { name: '`$ricky mute @user [duration] [reason]`', value: 'Mute a member. Duration optional: `30m`, `2h`, `1d`, `7d` (max 30d). Omit for permanent.',          inline: false },
            { name: '`$ricky unmute @user`',                   value: 'Remove the mute from a member.',                                                                     inline: false },
            { name: '`$ricky mutes`',                          value: 'List every currently muted member — reason, who muted them, and time remaining.',                    inline: false },
            // Graal
            { name: '┌ 🎮  Graal Online Era', value: '​', inline: false },
            { name: '`$ricky dc`',                                    value: 'Show a countdown to the next **Double Coins** event, or confirm it\'s currently active.',     inline: false },
            { name: '`$ricky pvp`',                                    value: 'Show a countdown to the next **PvP Arena** event, or confirm it\'s currently active.',     inline: false },
            { name: '`$ricky subscribe <event>`',                     value: 'Subscribe this channel to get pinged when an event starts.\nEvents: `doublecoins` `pvp` `plasma` `all`', inline: false },
            { name: '`$ricky unsubscribe <event>`',                   value: 'Remove a subscription from this channel.',                                                    inline: false },
            { name: '`$ricky subscriptions`',                         value: 'Show which events this channel is currently subscribed to.',                                  inline: false },
          ],
          footer: { text: 'AbsoluteRicky Bot • $ricky helpricky for admin/setup commands' },
        };
        await message.reply({ embeds: [embedGeneral] });
        return;
      }

      // Comando de ayuda privado — solo owner
      if (command === 'helpricky') {
        if (!OWNER_ID || message.author.id !== OWNER_ID) return;
        const embed = {
          color: 0x2b2d31,
          title: '🔧 Admin & Setup Commands',
          description: 'Prefix: `$ricky` or `$r` — visible only to you',
          fields: [
            // General admin
            { name: '┌ 📁  Logs', value: '​', inline: false },
            { name: '`$ricky logs`',          value: 'View all recent bot logs.',             inline: true },
            { name: '`$ricky logs mod`',       value: 'View moderation actions only.',        inline: true },
            { name: '`$ricky logs cmd`',       value: 'View command usage only.',             inline: true },
            // LinkGuard
            { name: '┌ 🔗  LinkGuard / AutoMod', value: '​', inline: false },
            { name: '`$ricky linkguard on`',                          value: 'Enable the scam/phishing/NSFW link scanner for this server.',                                                                inline: false },
            { name: '`$ricky linkguard off`',                         value: 'Disable the link scanner for this server.',                                                                                  inline: false },
            { name: '`$ricky linkguard logchannel #channel`',         value: 'Set where AutoMod alerts and audit logs are sent.',                                                                          inline: false },
            { name: '`$ricky linkguard modchannel #channel`',         value: 'Set the mod action channel — posts an Unmute/Ban panel on every auto-mute. Unmuting from here grants the user 2h immunity.', inline: false },
            { name: '`$ricky linkguard muteduration <time|off>`',     value: 'How long auto-mutes last: `30m` `1h` `12h` `1d` up to `30d`. Use `off` for permanent.',                                    inline: false },
            { name: '`$ricky linkguard status`',                      value: 'Show current AutoMod config: enabled, log channel, mod channel, mute duration.',                                            inline: false },
            // Graal events setup
            { name: '┌ 🎮  Graal Online Era — Event Setup', value: '​', inline: false },
            { name: '`$ricky subscribe <event>`',                     value: 'Subscribe this channel to auto-announce events: `doublecoins` `pvp` `plasma` `all`',                                        inline: false },
            { name: '`$ricky unsubscribe <event>`',                   value: 'Remove a subscription from this channel.',                                                                                   inline: false },
            { name: '`$ricky subscriptions`',                         value: 'List all active event subscriptions for this channel.',                                                                      inline: false },
          ],
          footer: { text: 'AbsoluteRicky Bot — admin panel' },
        };
        await message.reply({ embeds: [embed] });
        return;
      }

      // Kick: $ricky kick @user [reason]
      if (command === 'kick') {
        if (!message.member.permissions.has('KickMembers')) {
          await message.reply('❌ You do not have permission to kick members.');
          return;
        }
        const target = message.mentions.members.first();
        if (!target) {
          await message.reply('❌ Please mention a user to kick. Usage: `$ricky kick @user [reason]`');
          return;
        }
        if (!target.kickable) {
          await message.reply('❌ I cannot kick this user. They may have a higher role than me.');
          return;
        }
        const reason = args.slice(1).join(' ') || 'No reason provided';
        await target.kick(reason);
        addLog('mod', { action: 'kick', moderator: message.author.tag, moderatorId: message.author.id, target: target.user.tag, targetId: target.id, reason, guild: message.guild.name, guildId: message.guild.id });
        await message.reply(`✅ **${target.user.tag}** has been kicked. Reason: ${reason}`);
        return;
      }

      // Ban: $ricky ban @user [reason]
      if (command === 'ban') {
        if (!message.member.permissions.has('BanMembers')) {
          await message.reply('❌ You do not have permission to ban members.');
          return;
        }
        const target = message.mentions.members.first();
        if (!target) {
          await message.reply('❌ Please mention a user to ban. Usage: `$ricky ban @user [reason]`');
          return;
        }
        if (!target.bannable) {
          await message.reply('❌ I cannot ban this user. They may have a higher role than me.');
          return;
        }
        const reason = args.slice(1).join(' ') || 'No reason provided';
        await target.ban({ reason });
        addLog('mod', { action: 'ban', moderator: message.author.tag, moderatorId: message.author.id, target: target.user.tag, targetId: target.id, reason, guild: message.guild.name, guildId: message.guild.id });
        await message.reply(`✅ **${target.user.tag}** has been banned. Reason: ${reason}`);
        return;
      }

      // Mute: $ricky mute @user [reason]
      if (command === 'mute') {
        if (!message.member.permissions.has('ManageRoles')) {
          await message.reply('❌ You do not have permission to mute members.');
          return;
        }
        const target = message.mentions.members.first();
        if (!target) {
          await message.reply('❌ Please mention a user to mute. Usage: `$ricky mute @user [reason]`');
          return;
        }
        // Busca el rol Muted por ID o por nombre
        const mutedRole = await getOrCreateMutedRole(message.guild);
        if (target.roles.cache.has(mutedRole.id)) {
          await message.reply(`⚠️ **${target.user.tag}** is already muted.`);
          return;
        }
        // Detecta duración opcional: $ricky mute @user 1h reason
        const durationStr = args[1];
        const _rawDur = parseDuration(durationStr);
        const muteDuration = _rawDur ? Math.min(_rawDur, MAX_MUTE_MS) : null;
        const _durCapped = _rawDur && _rawDur > MAX_MUTE_MS;
        const reasonStart = muteDuration ? 2 : 1;
        const reason = args.slice(reasonStart).join(' ') || 'No reason provided';
        await target.roles.add(mutedRole, reason);
        if (muteDuration) scheduleMuteExpiry(target, mutedRole, muteDuration);
        // Registrar mute activo (memoria + DB)
        const _muteKey = target.id + '_' + message.guild.id;
        const _muteInfo = {
          reason,
          mutedBy: message.author.tag,
          mutedAt: Date.now(),
          expiresAt: muteDuration ? Date.now() + muteDuration : null,
        };
        activeMutes.set(_muteKey, _muteInfo);
        persistActiveMute(_muteKey, _muteInfo);
        addLog('mod', { action: 'mute', moderator: message.author.tag, moderatorId: message.author.id, target: target.user.tag, targetId: target.id, reason, duration: muteDuration ? formatDuration(muteDuration) : 'permanent', guild: message.guild.name, guildId: message.guild.id });
        const durationNote = muteDuration ? ` Duration: **${formatDuration(muteDuration)}**${_durCapped ? ' *(max 30d)*' : ''}.` : '';
        await message.reply(`🔇 **${target.user.tag}** has been muted.${durationNote} Reason: ${reason}`);
        return;
      }

      // Unmute: $ricky unmute @user
      if (command === 'unmute') {
        if (!message.member.permissions.has('ManageRoles')) {
          await message.reply('❌ You do not have permission to unmute members.');
          return;
        }
        const target = message.mentions.members.first();
        if (!target) {
          await message.reply('❌ Please mention a user to unmute. Usage: `$ricky unmute @user`');
          return;
        }
        const mutedRole = await getOrCreateMutedRole(message.guild);
        if (!target.roles.cache.has(mutedRole.id)) {
          await message.reply(`⚠️ **${target.user.tag}** is not muted.`);
          return;
        }
        await target.roles.remove(mutedRole);
        // Limpiar registro de mute activo y cancelar timer si existe (memoria + DB)
        const _unmuteKey = target.id + '_' + message.guild.id;
        if (muteTimers.has(_unmuteKey)) { clearTimeout(muteTimers.get(_unmuteKey)); muteTimers.delete(_unmuteKey); }
        activeMutes.delete(_unmuteKey);
        _stmtDeleteMute.run(_unmuteKey);
        addLog('mod', { action: 'unmute', moderator: message.author.tag, moderatorId: message.author.id, target: target.user.tag, targetId: target.id, guild: message.guild.name, guildId: message.guild.id });
        await message.reply(`🔊 **${target.user.tag}** has been unmuted.`);
        return;
      }

      // Mutes activos: lista todos los mutes activos en el servidor
      if (command === 'mutes') {
        if (!message.member.permissions.has('ManageRoles')) {
          await message.reply('❌ You do not have permission to view active mutes.');
          return;
        }
        const mutedRole = await getOrCreateMutedRole(message.guild).catch(() => null);
        if (!mutedRole) {
          await message.reply('❌ No Muted role found.');
          return;
        }
        // Obtener miembros con rol Muted actualizado
        await message.guild.members.fetch();
        const mutedMembers = message.guild.members.cache.filter(m => m.roles.cache.has(mutedRole.id));
        if (!mutedMembers.size) {
          await message.reply('✅ No active mutes in this server.');
          return;
        }
        const now = Date.now();
        const fields = [];
        for (const [, m] of mutedMembers) {
          const key = m.id + '_' + message.guild.id;
          const info = activeMutes.get(key);
          let timeLeft = '—';
          if (info?.expiresAt) {
            const remaining = info.expiresAt - now;
            timeLeft = remaining > 0 ? formatDuration(remaining) : 'expiring soon';
          } else if (info) {
            timeLeft = 'Permanent';
          }
          fields.push({
            name: m.user.tag,
            value: [
              `**Reason:** ${info?.reason || 'Unknown'}`,
              `**Muted by:** ${info?.mutedBy || 'Unknown'}`,
              `**Time left:** ${timeLeft}`,
            ].join('\n'),
            inline: false,
          });
        }
        // Dividir en chunks de 10 fields si hay muchos mutes
        const chunkSize = 10;
        for (let i = 0; i < fields.length; i += chunkSize) {
          const chunk = fields.slice(i, i + chunkSize);
          const isFirst = i === 0;
          await message.channel.send({ embeds: [{
            color: 0xff6600,
            title: isFirst ? `🔇 Active Mutes — ${message.guild.name} (${mutedMembers.size})` : `🔇 Active Mutes (continued)`,
            fields: chunk,
            timestamp: new Date().toISOString(),
            footer: { text: `Requested by ${message.author.tag}` },
          }] });
        }
        return;
      }

      // Logs: solo accesible por el owner
      if (command === 'logs') {
        if (!OWNER_ID || message.author.id !== OWNER_ID) return;

        const filter = (args[0] || '').toLowerCase();
        let entries = botLogs;
        if (filter === 'mod') entries = botLogs.filter((l) => l.type === 'mod');
        else if (filter === 'cmd') entries = botLogs.filter((l) => l.type === 'command');

        if (!entries.length) {
          await message.reply('📭 No logs found.');
          return;
        }

        const lines = entries.slice(0, 15).map((l) => {
          const time = new Date(l.at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          if (l.type === 'mod') {
            return `\`${time}\` **${l.action.toUpperCase()}** ${l.moderator} → ${l.target}${l.reason ? ` | ${l.reason}` : ''} *(${l.guild})*`;
          }
          return `\`${time}\` **${l.command}** by ${l.user}${l.args?.length ? ' ' + l.args.join(' ') : ''} *(${l.guild})*`;
        });

        const embed = {
          color: 0x2b2d31,
          title: filter === 'mod' ? '🔨 Moderation Logs' : filter === 'cmd' ? '⌨️ Command Logs' : '📋 Recent Logs',
          description: lines.join('\n'),
          footer: { text: `Showing ${entries.slice(0, 15).length} of ${entries.length} entries` },
        };
        await message.reply({ embeds: [embed] });
        return;
      }

      // Avatar: $ricky avatar [@user]
      if (command === 'avatar' || command === 'av') {
        const target = message.mentions.users.first() || message.author;
        const avatarUrl = target.displayAvatarURL({ size: 4096, extension: 'png', forceStatic: false });
        await message.reply({
          embeds: [{
            color: 0x5865f2,
            author: { name: target.tag, icon_url: target.displayAvatarURL({ size: 64 }) },
            image: { url: avatarUrl },
            footer: { text: 'Click the image to view it in full size.' },
          }],
        });
        return;
      }

      // Purge: $ricky purge [amount]
      if (command === 'purge') {
        if (!message.member.permissions.has('ManageMessages')) {
          await message.reply('❌ You do not have permission to delete messages.');
          return;
        }
        const amount = parseInt(args[0]);
        if (isNaN(amount) || amount < 1 || amount > 50) {
          await message.reply('❌ Provide a number between 1 and 50. Usage: `$ricky purge [1-50]`');
          return;
        }
        await message.delete().catch(() => {});
        const fetched = await message.channel.messages.fetch({ limit: amount });
        const deletable = fetched.filter(m => (Date.now() - m.createdTimestamp) < 14 * 24 * 60 * 60 * 1000);
        if (!deletable.size) {
          await message.channel.send('⚠️ No messages to delete (messages older than 14 days cannot be bulk deleted).').then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
          return;
        }
        await message.channel.bulkDelete(deletable, true);
        addLog('mod', { action: 'purge', moderator: message.author.tag, moderatorId: message.author.id, count: deletable.size, guild: message.guild.name, guildId: message.guild.id, channel: message.channel.name });
        const confirm = await message.channel.send(`🗑️ Deleted **${deletable.size}** message${deletable.size !== 1 ? 's' : ''}.`);
        setTimeout(() => confirm.delete().catch(() => {}), 4000);
        return;
      }

      // Stats: $ricky stats
      if (command === 'stats') {
        await message.guild.members.fetch();
        const total   = message.guild.memberCount;
        const bots    = message.guild.members.cache.filter((m) => m.user.bot).size;
        const humans  = total - bots;
        const embed = {
          color: 0x5865f2,
          title: `📊 ${message.guild.name}`,
          thumbnail: { url: message.guild.iconURL() || '' },
          fields: [
            { name: '👥 Members', value: humans.toLocaleString(), inline: true },
            { name: '🤖 Bots',    value: bots.toLocaleString(),   inline: true },
            { name: '🌐 Total',   value: total.toLocaleString(),  inline: true },
          ],
        };
        await message.reply({ embeds: [embed] });
        return;
      }

      // LinkGuard: $ricky linkguard <on|off|logchannel #canal|status>
      if (command === 'linkguard') {
        if (!message.member.permissions.has('ManageGuild')) {
          await message.reply('❌ You need the **Manage Server** permission to configure AutoMod.');
          return;
        }
        const sub = (args[0] || '').toLowerCase();
        const cfg = automodConfig[message.guild.id] || {};

        if (sub === 'on') {
          automodConfig[message.guild.id] = { ...cfg, enabled: true };
          persistAutomodConfig(message.guild.id);
          await message.reply('✅ AutoMod is now **enabled** for this server.');
        } else if (sub === 'off') {
          automodConfig[message.guild.id] = { ...cfg, enabled: false };
          persistAutomodConfig(message.guild.id);
          await message.reply('✅ AutoMod is now **disabled** for this server.');
        } else if (sub === 'logchannel') {
          const logCh = message.mentions.channels.first();
          if (!logCh) {
            await message.reply('❌ Mention a channel. Usage: `$ricky automod logchannel #channel`');
            return;
          }
          automodConfig[message.guild.id] = { ...cfg, logChannelId: logCh.id };
          persistAutomodConfig(message.guild.id);
          await message.reply(`✅ AutoMod alerts will be sent to <#${logCh.id}>.`);
        } else if (sub === 'modchannel') {
          const modCh = message.mentions.channels.first();
          if (!modCh) {
            await message.reply('❌ Mention a channel. Usage: `$ricky linkguard modchannel #channel`');
            return;
          }
          automodConfig[message.guild.id] = { ...cfg, modAlertChannelId: modCh.id };
          persistAutomodConfig(message.guild.id);
          await message.reply(`✅ Mod alert panel configured in <#${modCh.id}>. Moderators will receive alerts with Unmute and Ban buttons.`);
        } else if (sub === 'muteduration') {
          const durArg = args[1];
          if (durArg === 'off' || durArg === 'none' || durArg === '0') {
            automodConfig[message.guild.id] = { ...cfg, muteDuration: null };
            persistAutomodConfig(message.guild.id);
            await message.reply('✅ Auto-mute duration removed. Mutes will be permanent until manually removed.');
          } else {
            const rawMs = parseDuration(durArg);
            if (!rawMs) {
              await message.reply('❌ Invalid duration. Examples: `30m`, `1h`, `12h`, `1d`, `3mo`. Use `off` to disable. Max: **3 months**.');
              return;
            }
            const ms = Math.min(rawMs, MAX_MUTE_MS);
            const capped = rawMs > MAX_MUTE_MS;
            automodConfig[message.guild.id] = { ...cfg, muteDuration: ms };
            persistAutomodConfig(message.guild.id);
            await message.reply(`✅ Auto-mute duration set to **${formatDuration(ms)}**${capped ? ' *(capped at 3 months)*' : ''}. Users will be automatically unmuted after this time.`);
          }
        } else if (sub === 'status') {
          const status = cfg.enabled ? '🟢 Enabled' : '🔴 Disabled';
          const logCh = cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not configured';
          const modChDisplay = cfg.modAlertChannelId ? `<#${cfg.modAlertChannelId}>` : 'Not configured';
          const embed = {
            color: cfg.enabled ? 0x00cc66 : 0xff3333,
            title: '🛡️ AutoMod Status',
            fields: [
              { name: 'Status', value: status, inline: true },
              { name: 'Log Channel', value: logCh, inline: true },
              { name: 'Mod Alert Channel', value: modChDisplay, inline: true },
              { name: 'Auto-mute Duration', value: cfg.muteDuration ? formatDuration(cfg.muteDuration) : 'Permanent', inline: true },
              { name: 'Detects', value: '• NSFW / Adult sites\n• Scam links\n• NSFW Discord invites', inline: false },
            ],
          };
          await message.reply({ embeds: [embed] });
        } else {
          await message.reply('Usage: `$ricky linkguard <on | off | logchannel #channel | status>`');
        }
        return;
      }

      // Subscribe: $ricky subscribe <doublecoins|pvp|plasma|all>
      if (command === 'subscribe') {
        if (!message.member.permissions.has('ManageChannels')) {
          await message.reply('❌ You need the **Manage Channels** permission to subscribe.');
          return;
        }
        const input = (args[0] || '').toLowerCase();
        const eventTypes = input === 'all'
          ? ALL_EVENT_TYPES
          : [EVENT_ALIASES[input]].filter(Boolean);

        if (!eventTypes.length) {
          await message.reply('❌ Invalid event type. Use: `doublecoins`, `pvp`, `plasma`, or `all`.');
          return;
        }

        let entry = subscribedChannels.find((c) => c.channelId === message.channel.id);
        if (!entry) {
          entry = {
            channelId: message.channel.id,
            guildId: message.guild.id,
            guildName: message.guild.name,
            channelName: message.channel.name,
            events: [],
            addedAt: new Date().toISOString(),
          };
          subscribedChannels.push(entry);
        }

        // Agrega solo los eventos que no estaban ya
        const added = eventTypes.filter((t) => !entry.events.includes(t));
        entry.events = [...new Set([...entry.events, ...eventTypes])];

        // Persiste a SQLite: upsert del canal + agrega los tipos nuevos
        _stmtUpsertChannel.run(entry);
        for (const t of added) _stmtAddSub.run(entry.channelId, t);

        const labels = added.map((t) => EVENT_LABELS[t]).join(', ');
        if (!added.length) {
          await message.reply('⚠️ This channel is already subscribed to those events.');
        } else {
          await message.reply(`✅ This channel will now receive **${labels}** notifications.`);
        }
        return;
      }

      // Unsubscribe: $ricky unsubscribe <doublecoins|pvp|plasma|all>
      if (command === 'unsubscribe') {
        if (!message.member.permissions.has('ManageChannels')) {
          await message.reply('❌ You need the **Manage Channels** permission to unsubscribe.');
          return;
        }
        const input = (args[0] || '').toLowerCase();
        const eventTypes = input === 'all'
          ? ALL_EVENT_TYPES
          : [EVENT_ALIASES[input]].filter(Boolean);

        if (!eventTypes.length) {
          await message.reply('❌ Invalid event type. Use: `doublecoins`, `pvp`, `plasma`, or `all`.');
          return;
        }

        const entry = subscribedChannels.find((c) => c.channelId === message.channel.id);
        if (!entry || !entry.events.length) {
          await message.reply('⚠️ This channel has no active subscriptions.');
          return;
        }

        const removed = eventTypes.filter((t) => entry.events.includes(t));
        entry.events = entry.events.filter((t) => !eventTypes.includes(t));

        // Persiste a SQLite: quita las suscripciones removidas
        for (const t of removed) _stmtRemoveSub.run(entry.channelId, t);

        // Si no queda ningún evento, elimina la entrada completa (CASCADE limpia subs)
        if (!entry.events.length) {
          subscribedChannels = subscribedChannels.filter((c) => c.channelId !== message.channel.id);
          _stmtDeleteChannel.run(entry.channelId);
        }

        const labels = removed.map((t) => EVENT_LABELS[t]).join(', ');
        if (!removed.length) {
          await message.reply('⚠️ This channel was not subscribed to those events.');
        } else {
          await message.reply(`✅ Unsubscribed from **${labels}** notifications.`);
        }
        return;
      }


      // DC Timer: $ricky dctimer
      if (command === 'dctimer' || command === 'dctime' || command === 'dc') {
        const DC_INTERVAL_MS = 18000000; // exactamente 5h — promedio 18000.036s medido en 33 ciclos (±2.19s std dev)
        const dcEvents = events.filter(e => e.type === 'doublecoins');

        if (!dcEvents.length) {
          await message.reply('❌ No Double Coins events recorded yet.');
          return;
        }

        // events está ordenado newest-first
        const lastDC = dcEvents[0];
        const lastMs = new Date(lastDC.createdAt).getTime();
        const now = Date.now();

        const fmt = (ms) => {
          const s = Math.floor(ms / 1000);
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sec = s % 60;
          return `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
        };

        const toTimestamp = (ms) => `<t:${Math.floor(ms/1000)}:R>`;

        // DC inicia 2h después de la notificación y dura 1h
        const dcStartMs = lastMs + 2 * 60 * 60 * 1000;
        const dcEndMs   = dcStartMs + 60 * 60 * 1000;
        const isActive  = now >= dcStartMs && now < dcEndMs;

        let embed;
        if (isActive) {
          // DC está activo ahora mismo
          const timeLeft = dcEndMs - now;
          embed = {
            color: 0x00cc66,
            title: '⚡ Double Coins — ACTIVE NOW!',
            description: `💰 Double Coins is live! Ends ${toTimestamp(dcEndMs)} (**${fmt(timeLeft)}** left)`,
            timestamp: new Date().toISOString(),
          };
        } else {
          // Calcular próximo inicio de DC
          let nextEventMs = dcStartMs;
          while (nextEventMs <= now) nextEventMs += DC_INTERVAL_MS;
          const toEvent = nextEventMs - now;
          embed = {
            color: 0xf5a623,
            title: '⚡ Double Coins — Plasma Survival',
            description: `⏰ **${fmt(toEvent)}** until Double Coins starts — ${toTimestamp(nextEventMs)}`,
            timestamp: new Date().toISOString(),
          };
        }

        await message.reply({ embeds: [embed] });
        return;
      }

      // PvP Timer: pvptimer / pvptime / pvp
      if (command === 'pvptimer' || command === 'pvptime' || command === 'pvp') {
        const PVP_INTERVAL_MS = 18000000;
        const PVP_DURATION_MS = 30 * 60 * 1000;
        const pvpEvents = events.filter(e => e.type === 'pvp_normal');
        if (!pvpEvents.length) {
          await message.reply('No PvP events recorded yet.');
          return;
        }
        const lastMs = new Date(pvpEvents[0].createdAt).getTime();
        const now = Date.now();
        const fmt = (ms) => { const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h > 0 ? h+'h '+String(m).padStart(2,'0')+'m '+String(sec).padStart(2,'0')+'s' : String(m).padStart(2,'0')+'m '+String(sec).padStart(2,'0')+'s'; };
        const toTs = (ms) => '<t:'+Math.floor(ms/1000)+':R>';
        const pvpEndMs = lastMs + PVP_DURATION_MS;
        const isActive = now >= lastMs && now < pvpEndMs;
        let embed;
        if (isActive) {
          embed = { color: 0xff4444, title: '⚔️ AntiMatter PvP Arena — 🟢 LIVE', description: 'The arena is open! Join now! Closes '+toTs(pvpEndMs)+' ('+fmt(pvpEndMs-now)+' left)', timestamp: new Date().toISOString() };
        } else {
          let nextMs = lastMs; while (nextMs <= now) nextMs += PVP_INTERVAL_MS;
          embed = { color: 0xff4444, title: '⚔️ AntiMatter PvP Arena — Next Round', description: 'Arena opens in **'+fmt(nextMs-now)+'** — '+toTs(nextMs), timestamp: new Date().toISOString() };
        }
        await message.reply({ embeds: [embed] });
        return;
      }
      // Subscriptions: $ricky subscriptions
      if (command === 'subscriptions') {
        const entry = subscribedChannels.find((c) => c.channelId === message.channel.id);
        if (!entry || !entry.events.length) {
          await message.reply('📭 This channel has no active subscriptions. Use `$ricky subscribe <event>` to add one.');
          return;
        }
        const labels = entry.events.map((t) => `• **${EVENT_LABELS[t] || t}**`).join('\n');
        await message.reply(`📬 This channel is subscribed to:\n${labels}`);
        return;
      }

      return;
    }

    // Importa eventos de Discord
    if (!shouldImportDiscordMessage(message)) return;

    const classified = classifyDiscordMessage(message.content);
    if (!classified) return;

    const event = addEvent(classified.type, classified.title, classified.body, {
      id: `discord_${message.id}`,
      source: `discord:${message.author.id}`,
      createdAt: message.createdAt.toISOString(),
      discordMessageId: message.id,
    });

    // Broadcast a canales suscritos cuando se importa un evento de Discord
    const _lastSeen = _recentEventTypes.get(classified.type);
    if (_lastSeen && Date.now() - _lastSeen < 30000) {
      console.log(`⏭️ Skipped duplicate ${classified.type} (within 30s window)`);
      return;
    }
    _recentEventTypes.set(classified.type, Date.now());
    await broadcastEvent(classified.type, classified.body);
    console.log(`📥 Imported Discord event ${event.type} from message ${message.id}`);
  } catch (error) {
    console.error('❌ Error in messageCreate:', error);
  }
});

// ── Rutas HTTP ───────────────────────────────────────────────────────────────────
// Sirve la página de Términos de Servicio (archivo HTML estático, cacheado en memoria)
app.get('/tos', (_req, res) => {
  try {
    if (!_htmlCache.tos) _htmlCache.tos = fs.readFileSync('/home/josenriquefelix/bot-receptor-http/public/tos.html', 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(_htmlCache.tos);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

app.get('/privacy', (_req, res) => {
  try {
    if (!_htmlCache.privacy) _htmlCache.privacy = fs.readFileSync('/home/josenriquefelix/bot-receptor-http/public/privacy.html', 'utf8');
    res.setHeader('Content-Type', 'text/html');
    res.send(_htmlCache.privacy);
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// Healthcheck: retorna el estado del bot (uptime, canal monitoreado)
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    source: 'http-api',
    monitoredChannelId: MONITORED_CHANNEL_ID,
    importBotMessages: IMPORT_BOT_MESSAGES,
    oldBotUserIdConfigured: Boolean(OLD_BOT_USER_ID),
  });
});

// Retorna el evento más reciente registrado (o null si no hay ninguno)
app.get('/events/latest', (_req, res) => {
  res.json(events[0] ?? null);
});

// Lista de eventos con soporte de paginación (?limit=N) y filtro por fecha (?since=ISO)
app.get('/events', (req, res) => {
  const limit = Number(req.query.limit || 20);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  let result = [...events];
  if (since && !Number.isNaN(since.getTime())) {
    result = result.filter((event) => new Date(event.createdAt) > since);
  }
  res.json(result.slice(0, limit));
});

// Envía un mensaje de texto plano al canal principal de Discord (ID_CANAL_DESTINO)
app.post('/messages/send', requireAuth, async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ error: 'Message text is required' });
    }

    const canal = await client.channels.fetch(ID_CANAL_DESTINO);
    if (!canal) throw new Error('Canal destino no encontrado');
    await canal.send(text);

    res.status(201).json({ ok: true });
  } catch (error) {
    console.error('❌ Error sending plain message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Alerta de Double Coins: notifica al canal principal y a todos los canales suscritos
app.post('/alerts/doublecoins', requireAuth, async (req, res) => {
  try {
    const contenido = String(req.body?.content || '').trim();
    const body = `${contenido} Double Coins will be hosted in 2 hours in Plasma Survival`.trim();
    const event = await handleAlert({
      type: 'doublecoins',
      title: 'Double Coins',
      body,
      roleId: ID_DEL_ROL,
      decorate: (text) => `💀 ${text}`,
    });
    res.status(201).json({ ok: true, event });
  } catch (error) {
    console.error('❌ Error handling doublecoins alert:', error);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

// Alerta de PvP Normal: notifica la apertura del arena AntiMatter
app.post('/alerts/pvp-normal', requireAuth, async (_req, res) => {
  try {
    const body = 'The AntiMatter PvP Arena has opened! Battle players for plasma coins and kills! ⚔️🔥';
    const event = await handleAlert({
      type: 'pvp_normal',
      title: 'PvP Normal',
      body,
      roleId: ID_PVP_NORMAL_ROL,
    });
    res.status(201).json({ ok: true, event });
  } catch (error) {
    console.error('❌ Error handling PvP Normal alert:', error);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

// Alerta de Plasma Event: notifica el inicio del evento de plasma coins
app.post('/alerts/plasma-event', requireAuth, async (_req, res) => {
  try {
    const body = 'Plasma events are being hosted! Come and join to win some shiny plasma coins!';
    const event = await handleAlert({
      type: 'plasma_event',
      title: 'Plasma Event',
      body,
      roleId: ID_PVP_EVENT_ROL,
      decorate: (text) => `${text} ❗ ⭐`,
    });
    res.status(201).json({ ok: true, event });
  } catch (error) {
    console.error('❌ Error handling plasma event alert:', error);
    res.status(500).json({ error: 'Failed to send alert' });
  }
});

// Inicia el servidor HTTP Express en el puerto configurado (3100 por defecto)
app.listen(port, () => {
  console.log(`🌐 HTTP API listening on port ${port}`);
});


// Se ejecuta cuando alguien hace clic en un botón del panel de AutoMod (Unmute / Ban).
// Solo procesa botones que empiecen con "automod_unmute_" o "automod_ban_".
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const { customId, guild, member } = interaction;
  if (!customId.startsWith('automod_unmute_') && !customId.startsWith('automod_ban_')) return;

  if (!member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({ content: '❌ You need the **Manage Roles** permission to do this.', ephemeral: true });
  }

  const parts   = customId.split('_'); // ['automod','unmute'/'ban', userId, guildId]
  const action  = parts[1];
  const userId  = parts[2];

  const targetMember = await guild.members.fetch(userId).catch(() => null);
  if (!targetMember) {
    return interaction.reply({ content: '❌ User not found (they may have already left the server).', ephemeral: true });
  }

  if (action === 'unmute') {
    try {
      const mutedRoles = targetMember.roles.cache.filter(r =>
        r.name === 'ABSOLUTE RICKY MUTE ROLE' || r.name === 'ABSOLUTE RICKY MUTE ROLE | NSFW' || r.name.toLowerCase() === 'muted' || r.name.toLowerCase() === 'muted | nsfw'
      );
      for (const [, role] of mutedRoles) {
        await targetMember.roles.remove(role, `Unmuted by ${member.user.tag} via AutoMod panel`);
      }
      // Limpiar registro de mute activo y cancelar timer si existe (memoria + DB)
      const _btnUnmuteKey = userId + '_' + guild.id;
      if (muteTimers.has(_btnUnmuteKey)) { clearTimeout(muteTimers.get(_btnUnmuteKey)); muteTimers.delete(_btnUnmuteKey); }
      activeMutes.delete(_btnUnmuteKey);
      _stmtDeleteMute.run(_btnUnmuteKey);
      setImmune(userId, guild.id);
      const immuneUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const oldEmbed = interaction.message.embeds[0]?.data ?? {};
      await interaction.update({
        embeds: [{ ...oldEmbed, color: 0x00cc66, description: `✅ **Unmuted** by <@${member.user.id}>
🛡️ 2h immunity active — cannot be auto-muted until <t:${Math.floor(immuneUntil.getTime()/1000)}:t>` }],
        components: [],
      });
      // Log en el canal de log si está configurado
      const guildConfig = automodConfig[guild.id];
      if (guildConfig?.logChannelId) {
        const logCh = await client.channels.fetch(guildConfig.logChannelId).catch(() => null);
        if (logCh) {
          await logCh.send({ embeds: [{
            color: 0x00cc66,
            title: '🛡️ Manual Unmute + Immunity',
            fields: [
              { name: '👤 Unmuted user',      value: `<@${userId}> (${targetMember.user.tag})`, inline: true },
              { name: '👮 Por',               value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
              { name: '⏱️ Immunity until',   value: `<t:${Math.floor(immuneUntil.getTime()/1000)}:F> (<t:${Math.floor(immuneUntil.getTime()/1000)}:R>)`, inline: false },
              { name: 'ℹ️ Note',             value: 'The bot **will not auto-mute** this user for 2 hours. Only a manual mute will apply.', inline: false },
            ],
            timestamp: new Date().toISOString(),
            footer: { text: `AutoMod • ${guild.name}` },
          }] }).catch(() => {});
        }
      }
    } catch (err) {
      await interaction.reply({ content: `❌ No pude desmutear: ${err.message}`, ephemeral: true });
    }
  } else if (action === 'ban') {
    try {
      await guild.members.ban(userId, { reason: `Banned by ${member.user.tag} via AutoMod panel` });
      const oldEmbed = interaction.message.embeds[0]?.data ?? {};
      await interaction.update({
        embeds: [{ ...oldEmbed, color: 0xff0000, description: `🔨 **Banned** by <@${member.user.id}>` }],
        components: [],
      });
    } catch (err) {
      await interaction.reply({ content: `❌ No pude banear: ${err.message}`, ephemeral: true });
    }
  }
});

client.on('guildCreate', async (guild) => {
  try {
    const channel =
      guild.systemChannel ??
      guild.channels.cache
        .filter(c => c.type === 0 && c.permissionsFor(guild.members.me)?.has('SendMessages'))
        .sort((a, b) => a.position - b.position)
        .first();

    if (!channel) return;

    await channel.send({
      embeds: [{
        color: 0x5865f2,
        title: '👋 Welcome!',
        description: [
          'Thanks for adding me to **' + guild.name + '**!',
          '',
          'Use `$ricky help` (or `$r help`) to see available commands.',
          'To enable the scam/NSFW link filter: `$ricky linkguard on`',
        ].join('\n'),
        footer: { text: 'Bot Receptor • $ricky help to get started' },
        timestamp: new Date().toISOString(),
      }],
    });

    console.log('✅ Joined guild: ' + guild.name + ' (' + guild.id + ')');
  } catch (err) {
    console.error('❌ guildCreate message failed in ' + guild.name + ':', err.message);
  }
});

// Detecta cuando alguien quita el rol Muted manualmente (no por bot) y limpia los registros internos
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const mutedRoleNames = ['absolute ricky mute role', 'absolute ricky mute role | nsfw', 'muted', 'muted | nsfw'];
    const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
    const lostMutedRole = removedRoles.find(r => mutedRoleNames.includes(r.name.toLowerCase()));
    if (!lostMutedRole) return;
    const key = newMember.id + '_' + newMember.guild.id;
    const hadRecord = activeMutes.has(key) || muteTimers.has(key);
    if (muteTimers.has(key)) { clearTimeout(muteTimers.get(key)); muteTimers.delete(key); }
    activeMutes.delete(key);
    _stmtDeleteMute.run(key);
    if (hadRecord) {
      console.log('Role muted removed manually from ' + newMember.user.tag + ' in ' + newMember.guild.name + ' -- records cleared');
    }
  } catch (err) {
    console.error('guildMemberUpdate handler error:', err.message);
  }
});
// Cierre limpio del bot cuando el sistema manda señal de terminación (pm2 stop, servidor apagado, etc.)
process.on('SIGTERM', () => {
  console.log('⚠️ SIGTERM received — closing Discord gateway cleanly');
  client.destroy();
  process.exit(0);
});

// Cierre limpio del bot cuando se presiona Ctrl+C en la terminal
process.on('SIGINT', () => {
  console.log('⚠️ SIGINT received — closing Discord gateway cleanly');
  client.destroy();
  process.exit(0);
});

// Conecta el bot a Discord usando el token. Todo lo anterior es setup — esto lo activa.
client.login(TOKEN_BOT_RECEPTOR);
