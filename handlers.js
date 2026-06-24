// Handlers de eventos de Discord (clientReady, messageCreate, interactionCreate,
// guildCreate, guildDelete, guildMemberUpdate) + helpers de broadcast (sendAlert,
// broadcastEvent, handleAlert). Centraliza toda la interacción del bot con Discord.
const { PermissionFlagsBits } = require('discord.js');
const { client } = require('./client');
const { db, stmts } = require('./db');
const { state, addEvent, addLog, setImmune } = require('./state');
const { env, PREFIX, PREFIX_SHORT } = require('./config');
const { normalizeContent } = require('./lib');
const { refreshLiveBlocklist, checkAutomod } = require('./automod');
const { rebuildMuteTimers } = require('./mutes');
const { dispatchCommand } = require('./commands');
const { registerSlashCommands, handleSlashCommand } = require('./slash');

// ── Estado interno ──────────────────────────────────────────────────────────
let BOT_READY_AT = 0;
const _processedMsgIds = new Set();   // dedup gateway resends
const _processedMsgQueue = [];
const _recentEventTypes = new Map();  // tipo → ts. Dedup broadcast en 30s

// ── Clasificación + filtros de mensajes monitoreados ────────────────────────

// Detecta si un mensaje Discord es un evento de Graal Online Era.
function classifyDiscordMessage(text) {
  const normalized = normalizeContent(text);
  const lower = normalized.toLowerCase();
  if (lower.includes('double coins')) return { type: 'doublecoins', title: 'Double Coins', body: normalized };
  if (lower.includes('antimatter pvp arena') || lower.includes('pvp arena has opened')) return { type: 'pvp_normal', title: 'PvP Normal', body: normalized };
  if (lower.includes('plasma events are being hosted') || lower.includes('join to win some shiny plasma coins')) return { type: 'plasma_event', title: 'Plasma Event', body: normalized };
  return null;
}

// Decide si el bot debe importar un mensaje Discord como evento.
function shouldImportDiscordMessage(message) {
  if (!env.IMPORT_BOT_MESSAGES) return false;
  if (!message?.author) return false;
  if (message.channelId !== env.MONITORED_CHANNEL_ID) return false;
  if (env.OLD_BOT_USER_ID && message.author.id !== env.OLD_BOT_USER_ID) return false;
  if (!env.OLD_BOT_USER_ID && !message.author.bot) return false;
  if (state.seenDiscordMessageIds.has(message.id)) return false;
  return true;
}

// ── Broadcast: send + alerts ─────────────────────────────────────────────────

// Envía un mensaje al canal principal (ID_CANAL_DESTINO), opcionalmente menciona rol
async function sendAlert(roleId, content) {
  const canal = await client.channels.fetch(env.ID_CANAL_DESTINO);
  if (!canal) throw new Error('Canal destino no encontrado');
  const prefix = roleId ? `<@&${roleId}> ` : '';
  await canal.send(prefix + content);
}

// Broadcast a TODOS los canales suscritos a un eventType
async function broadcastEvent(eventType, content) {
  const targets = state.subscribedChannels.filter(c => c.events.includes(eventType));
  await Promise.all(targets.map(async (target) => {
    try {
      const channel = await client.channels.fetch(target.channelId).catch(() => null);
      if (channel) await channel.send(content);
    } catch (err) {
      console.error(`❌ Failed to broadcast to channel ${target.channelId}:`, err.message);
    }
  }));
}

// Ventana anti-duplicado para HTTP alerts (los bots fuente a veces envían 2x)
const HTTP_ALERT_DEDUP_MS = { doublecoins: 60_000, pvp_normal: 60_000 };

// Pipeline completo para una alerta HTTP API:
// 1. sendAlert al canal principal
// 2. Marca _recentEventTypes (dedupe del messageCreate handler)
// 3. broadcastEvent a canales suscritos
// 4. addEvent en SQLite
async function handleAlert({ type, title, body, roleId, decorate }) {
  const dedupWindow = HTTP_ALERT_DEDUP_MS[type];
  if (dedupWindow) {
    const lastSeen = _recentEventTypes.get(type);
    if (lastSeen && Date.now() - lastSeen < dedupWindow) {
      console.log(`⏭️ Skipped duplicate HTTP alert ${type} (within ${dedupWindow / 1000}s window)`);
      return { skipped: true, reason: 'duplicate', type };
    }
  }
  const content = decorate ? decorate(body) : body;
  await sendAlert(roleId, content);
  _recentEventTypes.set(type, Date.now());
  await broadcastEvent(type, content);
  return addEvent(type, title, body, { source: 'http-api' });
}

// ── Discord event: clientReady (antes 'ready' — renombrado en discord.js v15) ─
client.on('clientReady', () => {
  BOT_READY_AT = Date.now();
  console.log(`✅ Bot receptor HTTP conectado como ${client.user.tag}`);
  refreshLiveBlocklist();
  setInterval(refreshLiveBlocklist, 6 * 60 * 60 * 1000);

  // Reconstruir timers de mutes que sobrevivieron al restart
  rebuildMuteTimers();

  // Registrar slash commands globalmente (propagación ~5 min Discord-side)
  registerSlashCommands();

  // Migración: renombrar roles "Muted" → "ABSOLUTE RICKY MUTE ROLE" en todos los guilds
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
    if (renamed > 0) console.log(`Renamed ${renamed} muted role(s) to new names across all guilds`);
  }, 3000);

  console.log(`👀 Watching channel ${env.MONITORED_CHANNEL_ID} for Discord alerts`);
  if (env.OLD_BOT_USER_ID) console.log(`🤖 Filtering to old bot user ID ${env.OLD_BOT_USER_ID}`);
  else console.log('🤖 OLD_BOT_USER_ID not set; importing matching messages from any bot in the monitored channel');
});

// ── Discord event: messageCreate ────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (_processedMsgIds.has(message.id)) return;
  _processedMsgIds.add(message.id);
  _processedMsgQueue.push(message.id);
  if (_processedMsgQueue.length > 500) _processedMsgIds.delete(_processedMsgQueue.shift());
  // Drop replayed events del session resume
  if (message.createdTimestamp < BOT_READY_AT) return;

  try {
    // AutoMod siempre primero
    await checkAutomod(message);

    // Comandos de prefijo $ricky / $r
    const contentLower = message.content.toLowerCase();
    const usedPrefix = contentLower.startsWith(PREFIX.toLowerCase())
      ? PREFIX
      : contentLower.startsWith(PREFIX_SHORT.toLowerCase() + ' ') || contentLower === PREFIX_SHORT.toLowerCase()
        ? PREFIX_SHORT
        : null;

    if (!message.author.bot && usedPrefix) {
      const args = message.content.slice(usedPrefix.length).trim().split(/\s+/);
      const command = args.shift().toLowerCase();
      await dispatchCommand(message, command, args);
      return;
    }

    // Import de eventos desde el canal monitoreado
    if (!shouldImportDiscordMessage(message)) return;
    const classified = classifyDiscordMessage(message.content);
    if (!classified) return;

    const event = addEvent(classified.type, classified.title, classified.body, {
      id: `discord_${message.id}`,
      source: `discord:${message.author.id}`,
      createdAt: message.createdAt.toISOString(),
      discordMessageId: message.id,
    });

    // Dedup broadcast en ventana de 30s
    const lastSeen = _recentEventTypes.get(classified.type);
    if (lastSeen && Date.now() - lastSeen < 30000) {
      console.log(`⏭️ Skipped duplicate ${classified.type} (within 30s window)`);
      return;
    }
    _recentEventTypes.set(classified.type, Date.now());
    await broadcastEvent(classified.type, classified.body);
    console.log(`📥 Imported Discord event ${event.type} from message ${message.id}`);
  } catch (err) {
    console.error('❌ Error in messageCreate:', err);
  }
});

// ── Discord event: interactionCreate (slash commands + botones AutoMod panel) ─
client.on('interactionCreate', async (interaction) => {
  // Slash commands
  if (interaction.isChatInputCommand()) {
    return handleSlashCommand(interaction);
  }
  // Botones (panel de AutoMod: Unmute / Ban)
  if (!interaction.isButton()) return;
  const { customId, guild, member } = interaction;
  if (!customId.startsWith('automod_unmute_') && !customId.startsWith('automod_ban_')) return;

  if (!member.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.reply({ content: '❌ You need the **Manage Roles** permission to do this.', ephemeral: true });
  }

  const parts = customId.split('_'); // ['automod','unmute'|'ban', userId, guildId]
  const action = parts[1];
  const userId = parts[2];

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
      // Limpiar mute activo (memoria + DB)
      const btnKey = userId + '_' + guild.id;
      if (state.muteTimers.has(btnKey)) { clearTimeout(state.muteTimers.get(btnKey)); state.muteTimers.delete(btnKey); }
      state.activeMutes.delete(btnKey);
      stmts.deleteMute.run(btnKey);
      setImmune(userId, guild.id);
      const immuneUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const oldEmbed = interaction.message.embeds[0]?.data ?? {};
      await interaction.update({
        embeds: [{ ...oldEmbed, color: 0x00cc66, description: `✅ **Unmuted** by <@${member.user.id}>
🛡️ 2h immunity active — cannot be auto-muted until <t:${Math.floor(immuneUntil.getTime()/1000)}:t>` }],
        components: [],
      });
      // Log en el canal configurado
      const guildConfig = state.automodConfig[guild.id];
      if (guildConfig?.logChannelId) {
        const logCh = await client.channels.fetch(guildConfig.logChannelId).catch(() => null);
        if (logCh) {
          await logCh.send({ embeds: [{
            color: 0x00cc66,
            title: '🛡️ Manual Unmute + Immunity',
            fields: [
              { name: '👤 Unmuted user',     value: `<@${userId}> (${targetMember.user.tag})`, inline: true },
              { name: '👮 Por',              value: `<@${member.user.id}> (${member.user.tag})`, inline: true },
              { name: '⏱️ Immunity until',  value: `<t:${Math.floor(immuneUntil.getTime()/1000)}:F> (<t:${Math.floor(immuneUntil.getTime()/1000)}:R>)`, inline: false },
              { name: 'ℹ️ Note',            value: 'The bot **will not auto-mute** this user for 2 hours. Only a manual mute will apply.', inline: false },
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

// ── Discord event: guildCreate (mensaje de bienvenida) ──────────────────────
client.on('guildCreate', async (guild) => {
  try {
    const channel = guild.systemChannel ??
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
          `Thanks for adding me to **${guild.name}**!`,
          '',
          'Use `$ricky help` (or `$r help`) to see available commands.',
          'To enable the scam/NSFW link filter: `$ricky linkguard on`',
        ].join('\n'),
        footer: { text: 'Bot Receptor • $ricky help to get started' },
        timestamp: new Date().toISOString(),
      }],
    });
    console.log(`✅ Joined guild: ${guild.name} (${guild.id})`);
  } catch (err) {
    console.error(`❌ guildCreate message failed in ${guild.name}:`, err.message);
  }
});

// ── Discord event: guildDelete (limpia datos del server cuando nos sacan) ────
// Cuando el bot es removido de un guild (kick/ban/server deleted), borramos:
//  - automod_config para ese guild
//  - subscribed_channels (CASCADE limpia channel_event_subscriptions)
//  - active_mutes (memoria + DB)
//  - estado en memoria (state.automodConfig, state.subscribedChannels, etc.)
// Si no, la DB se va llenando de configs huérfanas con el tiempo.
client.on('guildDelete', (guild) => {
  try {
    const guildId = guild.id;

    // 1. AutoMod config
    const automodDel = db.prepare('DELETE FROM automod_config WHERE guild_id = ?').run(guildId);
    delete state.automodConfig[guildId];

    // 2. Subscribed channels (CASCADE limpia channel_event_subscriptions)
    const channelsDel = db.prepare('DELETE FROM subscribed_channels WHERE guild_id = ?').run(guildId);
    state.subscribedChannels = state.subscribedChannels.filter(c => c.guildId !== guildId);

    // 3. Active mutes para ese guild
    const mutesDel = db.prepare('DELETE FROM active_mutes WHERE guild_id = ?').run(guildId);
    for (const [key, info] of [...state.activeMutes]) {
      if (key.endsWith('_' + guildId)) {
        state.activeMutes.delete(key);
        if (state.muteTimers.has(key)) {
          clearTimeout(state.muteTimers.get(key));
          state.muteTimers.delete(key);
        }
      }
    }

    addLog('mod', {
      action: 'guild_delete_cleanup',
      guild: guild.name,
      guildId,
      automodCleared: automodDel.changes,
      channelsCleared: channelsDel.changes,
      mutesCleared: mutesDel.changes,
    });

    console.log(`🧹 Cleaned up guild ${guild.name} (${guildId}): ${automodDel.changes} automod, ${channelsDel.changes} channels, ${mutesDel.changes} mutes`);
  } catch (err) {
    console.error(`❌ guildDelete cleanup failed for ${guild.name}:`, err.message);
  }
});

// ── Discord event: guildMemberUpdate (detecta unmute manual del rol) ────────
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    const mutedRoleNames = ['absolute ricky mute role', 'absolute ricky mute role | nsfw', 'muted', 'muted | nsfw'];
    const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
    const lostMutedRole = removedRoles.find(r => mutedRoleNames.includes(r.name.toLowerCase()));
    if (!lostMutedRole) return;
    const key = newMember.id + '_' + newMember.guild.id;
    const hadRecord = state.activeMutes.has(key) || state.muteTimers.has(key);
    if (state.muteTimers.has(key)) { clearTimeout(state.muteTimers.get(key)); state.muteTimers.delete(key); }
    state.activeMutes.delete(key);
    stmts.deleteMute.run(key);
    if (hadRecord) {
      console.log(`Role muted removed manually from ${newMember.user.tag} in ${newMember.guild.name} -- records cleared`);
    }
  } catch (err) {
    console.error('guildMemberUpdate handler error:', err.message);
  }
});

module.exports = { handleAlert };
