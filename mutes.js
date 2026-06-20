// Helpers para mutear: crear el rol Muted, programar expiración, reconstruir
// timers después de un restart. El estado vive en state.activeMutes/muteTimers,
// la persistencia en active_mutes (DB).
const { ChannelType } = require('discord.js');
const { client } = require('./client');
const { stmts } = require('./db');
const { state } = require('./state');
const { env } = require('./config');

// Crea (o devuelve existente) el rol "ABSOLUTE RICKY MUTE ROLE | NSFW".
// Si encuentra el viejo "Muted | NSFW", lo renombra. Al crear, aplica override
// de permisos en todos los canales texto/voz para bloquear SendMessages.
async function getOrCreateNSFWMutedRole(guild) {
  let role = guild.roles.cache.find(
    (r) => r.name === 'ABSOLUTE RICKY MUTE ROLE | NSFW' || r.name === 'Muted | NSFW'
  );
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
          SendMessages: false, AddReactions: false,
        }).catch(() => {});
      }
    }
  }
  return role;
}

// Crea (o devuelve existente) el rol "ABSOLUTE RICKY MUTE ROLE".
// Si MUTED_ROLE_ID está en .env, busca por ID; si no, por nombre.
// Renombra el viejo "Muted" si lo encuentra.
async function getOrCreateMutedRole(guild) {
  let role = env.MUTED_ROLE_ID
    ? guild.roles.cache.get(env.MUTED_ROLE_ID)
    : guild.roles.cache.find((r) => r.name === 'ABSOLUTE RICKY MUTE ROLE' || r.name.toLowerCase() === 'muted');

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
    for (const [, channel] of guild.channels.cache) {
      if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        await channel.permissionOverwrites.create(role, {
          SendMessages: false, AddReactions: false,
        }).catch(() => {});
      }
    }
  }

  return role;
}

// Programa la remoción automática del rol muted después de durationMs.
// Si ya había un timer para ese usuario, lo cancela primero para evitar doble unmute.
function scheduleMuteExpiry(member, role, durationMs) {
  const key = member.id + '_' + member.guild.id;
  if (state.muteTimers.has(key)) clearTimeout(state.muteTimers.get(key));
  const timer = setTimeout(async () => {
    state.muteTimers.delete(key);
    state.activeMutes.delete(key);
    stmts.deleteMute.run(key);
    try {
      await member.guild.members.fetch(member.id);
      const freshMember = member.guild.members.cache.get(member.id);
      if (freshMember && freshMember.roles.cache.has(role.id)) {
        await freshMember.roles.remove(role, 'Mute duration expired');
        console.log(`⏱️ Auto-unmuted ${member.user.tag} in ${member.guild.name} (duration expired)`);
      }
    } catch (err) {
      console.error('❌ Auto-unmute failed:', err.message);
    }
  }, durationMs);
  state.muteTimers.set(key, timer);
}

// Reconstruye los setTimeout de mutes activos después de un restart.
// Lee activeMutes (cargado desde DB en state.js) y vuelve a programar la expiración.
async function rebuildMuteTimers() {
  const now = Date.now();
  let rebuilt = 0, expired = 0, cleaned = 0;

  for (const [key, info] of state.activeMutes) {
    if (!info.expiresAt) continue; // mute permanente — no hay timer

    const remaining = info.expiresAt - now;
    if (remaining <= 0) {
      state.activeMutes.delete(key);
      stmts.deleteMute.run(key);
      expired++;
      continue;
    }

    const [userId, guildId] = key.split('_');
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) { cleaned++; continue; }
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        state.activeMutes.delete(key);
        stmts.deleteMute.run(key);
        cleaned++;
        continue;
      }
      const mutedRole = await getOrCreateMutedRole(guild);
      if (!member.roles.cache.has(mutedRole.id)) {
        state.activeMutes.delete(key);
        stmts.deleteMute.run(key);
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

module.exports = {
  getOrCreateMutedRole,
  getOrCreateNSFWMutedRole,
  scheduleMuteExpiry,
  rebuildMuteTimers,
};
