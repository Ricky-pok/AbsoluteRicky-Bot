// Capa de persistencia SQLite (better-sqlite3, síncrono).
// Define schema, prepared statements y la migración one-shot JSON → SQLite.
const fs = require('fs');
const Database = require('better-sqlite3');
const {
  DB_FILE, EVENTS_FILE, CHANNELS_FILE, LOGS_FILE, AUTOMOD_FILE,
} = require('./config');
const { loadJsonArray } = require('./lib');

// ── Inicialización ──────────────────────────────────────────────────────────
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');     // escrituras rápidas, lecturas no bloquean
db.pragma('foreign_keys = ON');      // necesario para CASCADE

// ── Schema ──────────────────────────────────────────────────────────────────
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

// ── Prepared statements ─────────────────────────────────────────────────────
const stmts = {
  upsertEvent: db.prepare(`
    INSERT OR REPLACE INTO events (id, type, title, body, source, created_at, discord_message_id)
    VALUES (@id, @type, @title, @body, @source, @createdAt, @discordMessageId)
  `),
  trimEvents: db.prepare(`
    DELETE FROM events WHERE id NOT IN (
      SELECT id FROM events ORDER BY created_at DESC LIMIT ?
    )
  `),
  upsertChannel: db.prepare(`
    INSERT OR IGNORE INTO subscribed_channels (channel_id, guild_id, guild_name, channel_name, added_at)
    VALUES (@channelId, @guildId, @guildName, @channelName, @addedAt)
  `),
  addSub: db.prepare(`
    INSERT OR IGNORE INTO channel_event_subscriptions (channel_id, event_type) VALUES (?, ?)
  `),
  removeSub: db.prepare(`
    DELETE FROM channel_event_subscriptions WHERE channel_id = ? AND event_type = ?
  `),
  deleteChannel: db.prepare(`DELETE FROM subscribed_channels WHERE channel_id = ?`),
  insertLog: db.prepare(`
    INSERT INTO logs (type, at, action, target, target_id, guild, guild_id, extra)
    VALUES (@type, @at, @action, @target, @targetId, @guild, @guildId, @extra)
  `),
  trimLogs: db.prepare(`
    DELETE FROM logs WHERE id NOT IN (
      SELECT id FROM logs ORDER BY at DESC LIMIT ?
    )
  `),
  upsertAutomod: db.prepare(`
    INSERT INTO automod_config (guild_id, enabled, log_channel_id, mod_alert_channel_id, mute_duration)
    VALUES (@guildId, @enabled, @logChannelId, @modAlertChannelId, @muteDuration)
    ON CONFLICT(guild_id) DO UPDATE SET
      enabled              = excluded.enabled,
      log_channel_id       = excluded.log_channel_id,
      mod_alert_channel_id = excluded.mod_alert_channel_id,
      mute_duration        = excluded.mute_duration
  `),
  upsertMute: db.prepare(`
    INSERT OR REPLACE INTO active_mutes (key, user_id, guild_id, reason, muted_by, muted_at, expires_at)
    VALUES (@key, @userId, @guildId, @reason, @mutedBy, @mutedAt, @expiresAt)
  `),
  deleteMute: db.prepare(`DELETE FROM active_mutes WHERE key = ?`),
};

// ── Migración one-shot JSON → SQLite ────────────────────────────────────────
// Solo corre si las tablas están vacías. Idempotente, safety net si bot.db fue eliminado.
function runJsonMigration() {
  const tablesEmpty =
    db.prepare('SELECT COUNT(*) AS c FROM events').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM logs').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM automod_config').get().c === 0 &&
    db.prepare('SELECT COUNT(*) AS c FROM subscribed_channels').get().c === 0;

  if (!tablesEmpty) return;

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

  if (!hasJsonData) return;

  console.log('🔄 Iniciando migración one-shot JSON → SQLite...');

  if (jsonEvents.length > 0) {
    db.transaction((rows) => {
      for (const e of rows) {
        stmts.upsertEvent.run({
          id: e.id, type: e.type, title: e.title, body: e.body,
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
        stmts.upsertChannel.run({
          channelId: c.channelId, guildId: c.guildId,
          guildName: c.guildName, channelName: c.channelName,
          addedAt: c.addedAt,
        });
        for (const evType of (c.events || [])) {
          stmts.addSub.run(c.channelId, evType);
        }
      }
    })(jsonChannels);
    console.log(`  ✅ subscribed_channels: ${jsonChannels.length} migrados`);
  }

  if (jsonLogs.length > 0) {
    db.transaction((rows) => {
      for (const l of rows) {
        const { type, at, action, target, targetId, guild, guildId, ...rest } = l;
        stmts.insertLog.run({
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
        stmts.upsertAutomod.run({
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

module.exports = { db, stmts };
