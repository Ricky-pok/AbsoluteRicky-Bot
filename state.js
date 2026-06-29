// Estado en memoria del bot + funciones de persistencia.
// Todas las arrays/maps se cargan desde SQLite al arrancar y se mantienen
// sincronizados con la DB en cada mutación (sin debounce, escritura síncrona).
const { db, stmts } = require('./db');
const {
  MAX_EVENTS, MAX_LOGS,
  RATE_LIMIT_WINDOW, RATE_LIMIT_MAX, RATE_LIMIT_COOLDOWN,
} = require('./config');

// ── Estado central — mutable via state.X ─────────────────────────────────────
const state = {
  // events: ordenados newest-first
  events: db.prepare(`
    SELECT id, type, title, body, source,
           created_at AS createdAt,
           discord_message_id AS discordMessageId
    FROM events ORDER BY created_at DESC LIMIT ?
  `).all(MAX_EVENTS),

  // subscribedChannels: reconstruye shape con events: [] desde tabla normalizada
  subscribedChannels: [],

  // botLogs: campos fijos + spread de extra JSON
  botLogs: db.prepare(`
    SELECT type, at, action, target,
           target_id AS targetId,
           guild, guild_id AS guildId, extra
    FROM logs ORDER BY at DESC LIMIT ?
  `).all(MAX_LOGS).map(row => {
    let extra = {};
    try { extra = JSON.parse(row.extra || '{}'); } catch { extra = {}; }
    const { extra: _drop, ...base } = row;
    return { ...base, ...extra };
  }),

  // automodConfig: { [guildId]: { enabled, logChannelId, modAlertChannelId, muteDuration } }
  automodConfig: {},

  // userId_guildId → { reason, mutedBy, mutedAt, expiresAt|null }
  activeMutes: new Map(),

  // userId_guildId → setTimeout ID (no se persiste, se reconstruye en ready)
  muteTimers: new Map(),

  // userId_guildId → timestamp expiración (inmunidad post-unmute manual)
  immuneUsers: new Map(),

  // discordMessageId → ya procesado (dedupe de imports)
  seenDiscordMessageIds: new Set(),
};

// Reconstruye subscribedChannels desde las dos tablas
{
  const rawChannels = db.prepare(`
    SELECT channel_id AS channelId, guild_id AS guildId,
           guild_name AS guildName, channel_name AS channelName,
           added_at AS addedAt
    FROM subscribed_channels
  `).all();
  const subs = db.prepare(`
    SELECT channel_id AS channelId, event_type AS eventType
    FROM channel_event_subscriptions
  `).all();
  const subsByChannel = {};
  for (const s of subs) {
    if (!subsByChannel[s.channelId]) subsByChannel[s.channelId] = [];
    subsByChannel[s.channelId].push(s.eventType);
  }
  state.subscribedChannels = rawChannels.map(c => ({
    ...c, events: subsByChannel[c.channelId] || [],
  }));
}

// Reconstruye automodConfig
for (const row of db.prepare('SELECT * FROM automod_config').all()) {
  state.automodConfig[row.guild_id] = {
    enabled:           Boolean(row.enabled),
    logChannelId:      row.log_channel_id      || null,
    modAlertChannelId: row.mod_alert_channel_id || null,
    muteDuration:      row.mute_duration       || null,
  };
}

// Reconstruye activeMutes desde DB
for (const row of db.prepare('SELECT * FROM active_mutes').all()) {
  state.activeMutes.set(row.key, {
    reason:    row.reason,
    mutedBy:   row.muted_by,
    mutedAt:   row.muted_at,
    expiresAt: row.expires_at,
  });
}

// Inicializa seenDiscordMessageIds desde los eventos cargados
for (const e of state.events) {
  if (e.discordMessageId) state.seenDiscordMessageIds.add(e.discordMessageId);
}

// ── Funciones de persistencia ───────────────────────────────────────────────

// Persiste la config de AutoMod de un servidor en la DB
function persistAutomodConfig(guildId) {
  const cfg = state.automodConfig[guildId] || {};
  stmts.upsertAutomod.run({
    guildId,
    enabled:           cfg.enabled ? 1 : 0,
    logChannelId:      cfg.logChannelId      || null,
    modAlertChannelId: cfg.modAlertChannelId || null,
    muteDuration:      cfg.muteDuration      || null,
  });
}

// Registra un cambio de enable/disable de AutoMod (no se trimea — historial completo)
function logAutomodAudit({ guildId, guildName, action, actorId, actorTag }) {
  stmts.insertAutomodAudit.run({
    guildId,
    guildName: guildName || null,
    action,
    actorId:  actorId  || null,
    actorTag: actorTag || null,
    at: new Date().toISOString(),
  });
}

function getLatestAutomodAudit(guildId) {
  return stmts.getLatestAutomodAudit.get(guildId) || null;
}

// Persiste un mute activo en la DB
function persistActiveMute(key, info) {
  const [userId, guildId] = key.split('_');
  stmts.upsertMute.run({
    key, userId, guildId,
    reason:    info.reason,
    mutedBy:   info.mutedBy,
    mutedAt:   info.mutedAt,
    expiresAt: info.expiresAt || null,
  });
}

// Agrega un evento a memoria + DB. Mantiene MAX_EVENTS y dedup por id.
function addEvent(type, title, body, extra = {}) {
  const event = {
    id: extra.id || `evt_${Date.now()}`,
    type, title, body,
    source: extra.source || 'http-api',
    createdAt: extra.createdAt || new Date().toISOString(),
    discordMessageId: extra.discordMessageId || null,
  };
  if (event.discordMessageId) state.seenDiscordMessageIds.add(event.discordMessageId);
  state.events = [event, ...state.events.filter(e => e.id !== event.id)].slice(0, MAX_EVENTS);
  stmts.upsertEvent.run(event);
  stmts.trimEvents.run(MAX_EVENTS);
  return event;
}

// Agrega un log a memoria + DB. type: 'mod' | 'command'.
function addLog(type, data) {
  const entry = { type, ...data, at: new Date().toISOString() };
  state.botLogs = [entry, ...state.botLogs].slice(0, MAX_LOGS);

  const { type: _t, at, action, target, targetId, guild, guildId, ...rest } = entry;
  stmts.insertLog.run({
    type: type || 'unknown',
    at,
    action:   action   || null,
    target:   target   || null,
    targetId: targetId || null,
    guild:    guild    || null,
    guildId:  guildId  || null,
    extra: JSON.stringify(rest),
  });
  stmts.trimLogs.run(MAX_LOGS);
}

// ── Inmunidad post-unmute ───────────────────────────────────────────────────
function isImmune(userId, guildId) {
  const key = userId + '_' + guildId;
  const until = state.immuneUsers.get(key);
  if (!until) return false;
  if (Date.now() >= until) { state.immuneUsers.delete(key); return false; }
  return true;
}

function setImmune(userId, guildId) {
  state.immuneUsers.set(userId + '_' + guildId, Date.now() + 2 * 60 * 60 * 1000);
}

// ── Rate limiting ───────────────────────────────────────────────────────────
const _rateLimits = new Map();

// Limpia entradas expiradas cada 5 min
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _rateLimits) {
    if (entry.blockedUntil < now && (now - entry.windowStart) > RATE_LIMIT_WINDOW) {
      _rateLimits.delete(id);
    }
  }
}, 5 * 60 * 1000);

function isRateLimited(userId) {
  const now = Date.now();
  const entry = _rateLimits.get(userId) || { count: 0, windowStart: now, blockedUntil: 0 };
  if (entry.blockedUntil > now) return true;
  if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
    _rateLimits.set(userId, { count: 1, windowStart: now, blockedUntil: 0 });
    return false;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    entry.blockedUntil = now + RATE_LIMIT_COOLDOWN;
    _rateLimits.set(userId, entry);
    return true;
  }
  _rateLimits.set(userId, entry);
  return false;
}

module.exports = {
  state,
  persistAutomodConfig, persistActiveMute,
  logAutomodAudit, getLatestAutomodAudit,
  addEvent, addLog,
  isImmune, setImmune,
  isRateLimited,
};
