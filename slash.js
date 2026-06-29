// Slash commands — registrados globalmente al arrancar.
// Coexisten con los prefix commands $ricky/$r. Comparten lógica con state/mutes/db.
const {
  SlashCommandBuilder, PermissionFlagsBits, MessageFlags, REST, Routes,
  ChannelType,
} = require('discord.js');
const { client } = require('./client');
const { db, stmts } = require('./db');
const { state, addLog, persistAutomodConfig, persistActiveMute, logAutomodAudit, getLatestAutomodAudit } = require('./state');
const { parseDuration, formatDuration } = require('./lib');
const { getOrCreateMutedRole, scheduleMuteExpiry } = require('./mutes');
const { env, MAX_MUTE_MS } = require('./config');

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

const EVENT_CHOICES = [
  { name: 'Double Coins', value: 'doublecoins' },
  { name: 'PvP Arena',    value: 'pvp_normal' },
  { name: 'Plasma Event', value: 'plasma_event' },
  { name: 'All events',   value: 'all' },
];
const ALL_EVENT_TYPES = ['doublecoins', 'pvp_normal', 'plasma_event'];
const EVENT_LABELS = {
  doublecoins: 'Double Coins',
  pvp_normal:  'PvP Normal',
  plasma_event: 'Plasma Event',
};

// ── Definiciones (~15 comandos) ──────────────────────────────────────────────
// Orden de registro = orden en el menú "Use App" del perfil del bot en mobile.
// Discord IGNORA este orden en el autocomplete `/` (siempre alfabético).
const commandDefs = [
  // ⚡ Graal Timers (primero — el prefijo "a-" los pone arriba alfabéticamente)
  new SlashCommandBuilder().setName('a-dc').setDescription('Countdown to next Double Coins event'),
  new SlashCommandBuilder().setName('a-pvp').setDescription('Countdown to next PvP Arena event'),

  // 🤖 General
  new SlashCommandBuilder().setName('ping').setDescription('Check bot latency'),
  new SlashCommandBuilder().setName('help').setDescription('Show command list'),
  new SlashCommandBuilder().setName('stats').setDescription('Server member + bot count'),
  new SlashCommandBuilder().setName('avatar').setDescription('Show a user avatar')
    .addUserOption(o => o.setName('user').setDescription('Target user (default: yourself)')),
  new SlashCommandBuilder().setName('purge').setDescription('Delete recent messages (1-50)')
    .addIntegerOption(o => o.setName('amount').setDescription('How many to delete').setRequired(true).setMinValue(1).setMaxValue(50))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  // 🎮 Graal Events (subscripciones)
  new SlashCommandBuilder().setName('subscribe').setDescription('Subscribe this channel to Graal events')
    .addStringOption(o => o.setName('event').setRequired(true).setDescription('Event type').addChoices(...EVENT_CHOICES))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('unsubscribe').setDescription('Unsubscribe this channel from Graal events')
    .addStringOption(o => o.setName('event').setRequired(true).setDescription('Event type').addChoices(...EVENT_CHOICES))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('subscriptions').setDescription('Show current channel subscriptions'),

  // 🔗 LinkGuard / AutoMod — single command (action dropdown + optional params)
  // Para que aparezca como 1 sola entrada en el panel "Use this App" en vez de 6.
  new SlashCommandBuilder().setName('linkguard').setDescription('Configure AutoMod / LinkGuard')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o => o.setName('action').setDescription('What to do').setRequired(true).addChoices(
      { name: 'Status (show config)',       value: 'status' },
      { name: 'On (enable)',                 value: 'on' },
      { name: 'Off (disable)',               value: 'off' },
      { name: 'Set log channel',             value: 'logchannel' },
      { name: 'Set mod alert channel',       value: 'modchannel' },
      { name: 'Set auto-mute duration',      value: 'muteduration' },
    ))
    .addChannelOption(o => o.setName('channel').setDescription('Channel (only for logchannel / modchannel)').addChannelTypes(ChannelType.GuildText))
    .addStringOption(o => o.setName('duration').setDescription('Duration (only for muteduration). Use "off" for permanent. e.g. 30m, 1h, 3mo')),

  // 🛡️ Moderation
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
    .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
    .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName('mute').setDescription('Mute a member')
    .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
    .addStringOption(o => o.setName('duration').setDescription('e.g. 30m, 1h 30m, 1d, 3mo. Omit for permanent.'))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  new SlashCommandBuilder().setName('unmute').setDescription('Remove mute from a member')
    .addUserOption(o => o.setName('user').setDescription('Target').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  new SlashCommandBuilder().setName('mutes').setDescription('List active mutes in this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),

  // 🔧 Owner-only
  new SlashCommandBuilder().setName('logs').setDescription('View recent bot logs (owner only)')
    .addStringOption(o => o.setName('filter').setDescription('Type').addChoices(
      { name: 'Moderation', value: 'mod' },
      { name: 'Commands',   value: 'cmd' },
    )),
];

// ── Registro global (REST) ───────────────────────────────────────────────────
async function registerSlashCommands() {
  if (!env.TOKEN_BOT_RECEPTOR) return;
  try {
    const rest = new REST({ version: '10' }).setToken(env.TOKEN_BOT_RECEPTOR);
    const body = commandDefs.map(c => c.toJSON());
    await rest.put(Routes.applicationCommands(client.application.id), { body });
    console.log(`✅ Registered ${body.length} slash commands globally`);
  } catch (err) {
    console.error('❌ Failed to register slash commands:', err.message);
  }
}

// ── Handlers ─────────────────────────────────────────────────────────────────
async function slashPing(i) {
  return i.reply(`🏓 Pong! Latency: **${client.ws.ping}ms**`);
}

async function slashHelp(i) {
  const embed = {
    color: 0x5865f2,
    title: '📋 AbsoluteRicky Bot — Slash Commands',
    description: 'Both `/commands` and `$ricky commands` work.',
    fields: [
      { name: '⚡  Graal Timers', value: '`/a-dc` `/a-pvp`', inline: false },
      { name: '🤖  General',      value: '`/ping` `/help` `/stats` `/avatar` `/purge`', inline: false },
      { name: '🎮  Graal Events', value: '`/subscribe` `/unsubscribe` `/subscriptions`', inline: false },
      { name: '🔗  LinkGuard',    value: '`/linkguard action:<status|on|off|logchannel|modchannel|muteduration>`', inline: false },
      { name: '🛡️  Moderation',  value: '`/kick` `/ban` `/mute` `/unmute` `/mutes`', inline: false },
      { name: '🔧  Owner',        value: '`/logs`', inline: false },
    ],
    footer: { text: 'AbsoluteRicky Bot' },
  };
  return i.reply({ embeds: [embed] });
}

async function slashStats(i) {
  await i.deferReply();
  await i.guild.members.fetch();
  const total = i.guild.memberCount;
  const bots = i.guild.members.cache.filter(m => m.user.bot).size;
  const humans = total - bots;
  return i.editReply({ embeds: [{
    color: 0x5865f2,
    title: `📊 ${i.guild.name}`,
    thumbnail: { url: i.guild.iconURL() || '' },
    fields: [
      { name: '👥 Members', value: humans.toLocaleString(), inline: true },
      { name: '🤖 Bots',    value: bots.toLocaleString(),   inline: true },
      { name: '🌐 Total',   value: total.toLocaleString(),  inline: true },
    ],
  }] });
}

async function slashAvatar(i) {
  const target = i.options.getUser('user') || i.user;
  const url = target.displayAvatarURL({ size: 4096, extension: 'png', forceStatic: false });
  return i.reply({ embeds: [{
    color: 0x5865f2,
    author: { name: target.tag, icon_url: target.displayAvatarURL({ size: 64 }) },
    image: { url },
    footer: { text: 'Click the image to view full size.' },
  }] });
}

async function slashPurge(i) {
  const amount = i.options.getInteger('amount');
  await i.deferReply(EPHEMERAL);
  const fetched = await i.channel.messages.fetch({ limit: amount });
  const deletable = fetched.filter(m => (Date.now() - m.createdTimestamp) < 14 * 24 * 60 * 60 * 1000);
  if (!deletable.size) return i.editReply('⚠️ No messages to delete (>14 days cannot be bulk deleted).');
  await i.channel.bulkDelete(deletable, true);
  addLog('mod', { action: 'purge', moderator: i.user.tag, moderatorId: i.user.id, count: deletable.size, guild: i.guild.name, guildId: i.guild.id, channel: i.channel.name });
  return i.editReply(`🗑️ Deleted **${deletable.size}** message${deletable.size !== 1 ? 's' : ''}.`);
}

async function slashDC(i) {
  const DC_INTERVAL_MS = 18000000;
  const dcEvents = state.events.filter(e => e.type === 'doublecoins');
  if (!dcEvents.length) return i.reply({ content: '❌ No Double Coins events recorded yet.', ...EPHEMERAL });
  const lastMs = new Date(dcEvents[0].createdAt).getTime();
  const now = Date.now();
  const fmt = (ms) => {
    const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
    return `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
  };
  const toTs = (ms) => `<t:${Math.floor(ms/1000)}:R>`;
  const startMs = lastMs + 2 * 60 * 60 * 1000;
  const endMs = startMs + 60 * 60 * 1000;
  const active = now >= startMs && now < endMs;
  if (active) {
    return i.reply({ embeds: [{
      color: 0x00cc66,
      title: '⚡ Double Coins — ACTIVE NOW!',
      description: `💰 Double Coins is live! Ends ${toTs(endMs)} (**${fmt(endMs-now)}** left)`,
      timestamp: new Date().toISOString(),
    }] });
  }
  let next = startMs;
  while (next <= now) next += DC_INTERVAL_MS;
  return i.reply({ embeds: [{
    color: 0xf5a623,
    title: '⚡ Double Coins — Plasma Survival',
    description: `⏰ **${fmt(next - now)}** until Double Coins starts — ${toTs(next)}`,
    timestamp: new Date().toISOString(),
  }] });
}

async function slashPvP(i) {
  const PVP_INTERVAL_MS = 18000000;
  const PVP_DURATION_MS = 30 * 60 * 1000;
  const pvpEvents = state.events.filter(e => e.type === 'pvp_normal');
  if (!pvpEvents.length) return i.reply({ content: 'No PvP events recorded yet.', ...EPHEMERAL });
  const lastMs = new Date(pvpEvents[0].createdAt).getTime();
  const now = Date.now();
  const fmt = (ms) => { const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h > 0 ? h+'h '+String(m).padStart(2,'0')+'m '+String(sec).padStart(2,'0')+'s' : String(m).padStart(2,'0')+'m '+String(sec).padStart(2,'0')+'s'; };
  const toTs = (ms) => `<t:${Math.floor(ms/1000)}:R>`;
  const endMs = lastMs + PVP_DURATION_MS;
  if (now >= lastMs && now < endMs) {
    return i.reply({ embeds: [{
      color: 0xff4444,
      title: '⚔️ AntiMatter PvP Arena — 🟢 LIVE',
      description: `The arena is open! Join now! Closes ${toTs(endMs)} (${fmt(endMs-now)} left)`,
      timestamp: new Date().toISOString(),
    }] });
  }
  let next = lastMs;
  while (next <= now) next += PVP_INTERVAL_MS;
  return i.reply({ embeds: [{
    color: 0xff4444,
    title: '⚔️ AntiMatter PvP Arena — Next Round',
    description: `Arena opens in **${fmt(next-now)}** — ${toTs(next)}`,
    timestamp: new Date().toISOString(),
  }] });
}

async function slashSubscribe(i) {
  const input = i.options.getString('event');
  const eventTypes = input === 'all' ? ALL_EVENT_TYPES : [input];
  let entry = state.subscribedChannels.find(c => c.channelId === i.channel.id);
  if (!entry) {
    entry = {
      channelId: i.channel.id, guildId: i.guild.id,
      guildName: i.guild.name, channelName: i.channel.name,
      events: [], addedAt: new Date().toISOString(),
    };
    state.subscribedChannels.push(entry);
  }
  const added = eventTypes.filter(t => !entry.events.includes(t));
  entry.events = [...new Set([...entry.events, ...eventTypes])];
  stmts.upsertChannel.run(entry);
  for (const t of added) stmts.addSub.run(entry.channelId, t);
  const labels = added.map(t => EVENT_LABELS[t]).join(', ');
  if (!added.length) return i.reply({ content: '⚠️ This channel is already subscribed to those events.', ...EPHEMERAL });
  return i.reply(`✅ This channel will now receive **${labels}** notifications.`);
}

async function slashUnsubscribe(i) {
  const input = i.options.getString('event');
  const eventTypes = input === 'all' ? ALL_EVENT_TYPES : [input];
  const entry = state.subscribedChannels.find(c => c.channelId === i.channel.id);
  if (!entry || !entry.events.length) return i.reply({ content: '⚠️ This channel has no active subscriptions.', ...EPHEMERAL });
  const removed = eventTypes.filter(t => entry.events.includes(t));
  entry.events = entry.events.filter(t => !eventTypes.includes(t));
  for (const t of removed) stmts.removeSub.run(entry.channelId, t);
  if (!entry.events.length) {
    state.subscribedChannels = state.subscribedChannels.filter(c => c.channelId !== i.channel.id);
    stmts.deleteChannel.run(entry.channelId);
  }
  const labels = removed.map(t => EVENT_LABELS[t]).join(', ');
  if (!removed.length) return i.reply({ content: '⚠️ This channel was not subscribed to those events.', ...EPHEMERAL });
  return i.reply(`✅ Unsubscribed from **${labels}** notifications.`);
}

async function slashSubscriptions(i) {
  const entry = state.subscribedChannels.find(c => c.channelId === i.channel.id);
  if (!entry || !entry.events.length) return i.reply({ content: '📭 This channel has no active subscriptions. Use `/subscribe` to add one.', ...EPHEMERAL });
  const labels = entry.events.map(t => `• **${EVENT_LABELS[t] || t}**`).join('\n');
  return i.reply(`📬 This channel is subscribed to:\n${labels}`);
}

async function slashKick(i) {
  const target = i.options.getMember('user');
  if (!target) return i.reply({ content: '❌ User not found in this server.', ...EPHEMERAL });
  if (!target.kickable) return i.reply({ content: '❌ I cannot kick this user (higher role).', ...EPHEMERAL });
  const reason = i.options.getString('reason') || 'No reason provided';
  await target.kick(reason);
  addLog('mod', { action: 'kick', moderator: i.user.tag, moderatorId: i.user.id, target: target.user.tag, targetId: target.id, reason, guild: i.guild.name, guildId: i.guild.id });
  return i.reply(`✅ **${target.user.tag}** has been kicked. Reason: ${reason}`);
}

async function slashBan(i) {
  const target = i.options.getMember('user');
  if (!target) return i.reply({ content: '❌ User not found in this server.', ...EPHEMERAL });
  if (!target.bannable) return i.reply({ content: '❌ I cannot ban this user (higher role).', ...EPHEMERAL });
  const reason = i.options.getString('reason') || 'No reason provided';
  await target.ban({ reason });
  addLog('mod', { action: 'ban', moderator: i.user.tag, moderatorId: i.user.id, target: target.user.tag, targetId: target.id, reason, guild: i.guild.name, guildId: i.guild.id });
  return i.reply(`✅ **${target.user.tag}** has been banned. Reason: ${reason}`);
}

async function slashMute(i) {
  const target = i.options.getMember('user');
  if (!target) return i.reply({ content: '❌ User not found in this server.', ...EPHEMERAL });
  await i.deferReply();
  const mutedRole = await getOrCreateMutedRole(i.guild);
  if (target.roles.cache.has(mutedRole.id)) return i.editReply(`⚠️ **${target.user.tag}** is already muted.`);
  const durationStr = i.options.getString('duration');
  const rawDur = durationStr ? parseDuration(durationStr) : null;
  const muteDuration = rawDur ? Math.min(rawDur, MAX_MUTE_MS) : null;
  const capped = rawDur && rawDur > MAX_MUTE_MS;
  const reason = i.options.getString('reason') || 'No reason provided';
  await target.roles.add(mutedRole, reason);
  if (muteDuration) scheduleMuteExpiry(target, mutedRole, muteDuration);
  const muteKey = target.id + '_' + i.guild.id;
  const muteInfo = {
    reason, mutedBy: i.user.tag, mutedAt: Date.now(),
    expiresAt: muteDuration ? Date.now() + muteDuration : null,
  };
  state.activeMutes.set(muteKey, muteInfo);
  persistActiveMute(muteKey, muteInfo);
  addLog('mod', { action: 'mute', moderator: i.user.tag, moderatorId: i.user.id, target: target.user.tag, targetId: target.id, reason, duration: muteDuration ? formatDuration(muteDuration) : 'permanent', guild: i.guild.name, guildId: i.guild.id });
  const durationNote = muteDuration ? ` Duration: **${formatDuration(muteDuration)}**${capped ? ' *(max 3 months)*' : ''}.` : '';
  return i.editReply(`🔇 **${target.user.tag}** has been muted.${durationNote} Reason: ${reason}`);
}

async function slashUnmute(i) {
  const target = i.options.getMember('user');
  if (!target) return i.reply({ content: '❌ User not found in this server.', ...EPHEMERAL });
  await i.deferReply();
  const mutedRole = await getOrCreateMutedRole(i.guild);
  if (!target.roles.cache.has(mutedRole.id)) return i.editReply(`⚠️ **${target.user.tag}** is not muted.`);
  await target.roles.remove(mutedRole);
  const key = target.id + '_' + i.guild.id;
  if (state.muteTimers.has(key)) { clearTimeout(state.muteTimers.get(key)); state.muteTimers.delete(key); }
  state.activeMutes.delete(key);
  stmts.deleteMute.run(key);
  addLog('mod', { action: 'unmute', moderator: i.user.tag, moderatorId: i.user.id, target: target.user.tag, targetId: target.id, guild: i.guild.name, guildId: i.guild.id });
  return i.editReply(`🔊 **${target.user.tag}** has been unmuted.`);
}

async function slashMutes(i) {
  await i.deferReply();
  const mutedRole = await getOrCreateMutedRole(i.guild).catch(() => null);
  if (!mutedRole) return i.editReply('❌ No Muted role found.');
  await i.guild.members.fetch();
  const mutedMembers = i.guild.members.cache.filter(m => m.roles.cache.has(mutedRole.id));
  if (!mutedMembers.size) return i.editReply('✅ No active mutes in this server.');
  const now = Date.now();
  const fields = [];
  for (const [, m] of mutedMembers) {
    const info = state.activeMutes.get(m.id + '_' + i.guild.id);
    let timeLeft = '—';
    if (info?.expiresAt) {
      const remaining = info.expiresAt - now;
      timeLeft = remaining > 0 ? formatDuration(remaining) : 'expiring soon';
    } else if (info) timeLeft = 'Permanent';
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
  // Discord embeds max 25 fields — truncar y avisar
  const shown = fields.slice(0, 25);
  return i.editReply({ embeds: [{
    color: 0xff6600,
    title: `🔇 Active Mutes — ${i.guild.name} (${mutedMembers.size})${fields.length > 25 ? ` — first 25` : ''}`,
    fields: shown,
    timestamp: new Date().toISOString(),
    footer: { text: `Requested by ${i.user.tag}` },
  }] });
}

async function slashLinkguard(i) {
  const action = i.options.getString('action');
  const cfg = state.automodConfig[i.guild.id] || {};

  if (action === 'on') {
    state.automodConfig[i.guild.id] = { ...cfg, enabled: true };
    persistAutomodConfig(i.guild.id);
    logAutomodAudit({
      guildId: i.guild.id, guildName: i.guild.name,
      action: 'enabled', actorId: i.user.id, actorTag: i.user.tag,
    });
    return i.reply('✅ AutoMod is now **enabled** for this server.');
  }
  if (action === 'off') {
    state.automodConfig[i.guild.id] = { ...cfg, enabled: false };
    persistAutomodConfig(i.guild.id);
    logAutomodAudit({
      guildId: i.guild.id, guildName: i.guild.name,
      action: 'disabled', actorId: i.user.id, actorTag: i.user.tag,
    });
    return i.reply('✅ AutoMod is now **disabled** for this server.');
  }
  if (action === 'logchannel') {
    const ch = i.options.getChannel('channel');
    if (!ch) return i.reply({ content: '❌ Provide a `channel` option for `logchannel`.', ...EPHEMERAL });
    state.automodConfig[i.guild.id] = { ...cfg, logChannelId: ch.id };
    persistAutomodConfig(i.guild.id);
    return i.reply(`✅ AutoMod alerts will be sent to <#${ch.id}>.`);
  }
  if (action === 'modchannel') {
    const ch = i.options.getChannel('channel');
    if (!ch) return i.reply({ content: '❌ Provide a `channel` option for `modchannel`.', ...EPHEMERAL });
    state.automodConfig[i.guild.id] = { ...cfg, modAlertChannelId: ch.id };
    persistAutomodConfig(i.guild.id);
    return i.reply(`✅ Mod alert panel configured in <#${ch.id}>.`);
  }
  if (action === 'muteduration') {
    const durStr = i.options.getString('duration');
    if (!durStr) return i.reply({ content: '❌ Provide a `duration` option for `muteduration` (e.g. `30m`, `1h`, `3mo`, or `off`).', ...EPHEMERAL });
    if (['off','none','0'].includes(durStr.toLowerCase())) {
      state.automodConfig[i.guild.id] = { ...cfg, muteDuration: null };
      persistAutomodConfig(i.guild.id);
      return i.reply('✅ Auto-mute duration removed (permanent until manual unmute).');
    }
    const rawMs = parseDuration(durStr);
    if (!rawMs) return i.reply({ content: '❌ Invalid duration. Examples: `30m`, `1h`, `12h`, `1d`, `3mo`. Use `off` for permanent.', ...EPHEMERAL });
    const ms = Math.min(rawMs, MAX_MUTE_MS);
    const capped = rawMs > MAX_MUTE_MS;
    state.automodConfig[i.guild.id] = { ...cfg, muteDuration: ms };
    persistAutomodConfig(i.guild.id);
    return i.reply(`✅ Auto-mute duration set to **${formatDuration(ms)}**${capped ? ' *(capped at 3 months)*' : ''}.`);
  }
  if (action === 'status') {
    const lastAudit = getLatestAutomodAudit(i.guild.id);
    const lastChange = lastAudit
      ? `${lastAudit.action} by ${lastAudit.actorTag || 'unknown'} <t:${Math.floor(new Date(lastAudit.at).getTime()/1000)}:R>`
      : 'No changes recorded';
    return i.reply({ embeds: [{
      color: cfg.enabled ? 0x00cc66 : 0xff3333,
      title: '🛡️ AutoMod Status',
      fields: [
        { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true },
        { name: 'Log Channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not configured', inline: true },
        { name: 'Mod Alert Channel', value: cfg.modAlertChannelId ? `<#${cfg.modAlertChannelId}>` : 'Not configured', inline: true },
        { name: 'Auto-mute Duration', value: cfg.muteDuration ? formatDuration(cfg.muteDuration) : 'Permanent', inline: true },
        { name: 'Last change', value: lastChange, inline: false },
        { name: 'Detects', value: '• NSFW / Adult sites\n• Scam links\n• NSFW Discord invites', inline: false },
      ],
    }] });
  }
}

async function slashLogs(i) {
  if (!env.OWNER_ID || i.user.id !== env.OWNER_ID) {
    return i.reply({ content: '🔒 Owner only.', ...EPHEMERAL });
  }
  const filter = (i.options.getString('filter') || '').toLowerCase();
  let entries = state.botLogs;
  if (filter === 'mod') entries = state.botLogs.filter(l => l.type === 'mod');
  else if (filter === 'cmd') entries = state.botLogs.filter(l => l.type === 'command');
  if (!entries.length) return i.reply({ content: '📭 No logs found.', ...EPHEMERAL });
  const lines = entries.slice(0, 15).map(l => {
    const time = new Date(l.at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (l.type === 'mod') return `\`${time}\` **${l.action.toUpperCase()}** ${l.moderator} → ${l.target}${l.reason ? ` | ${l.reason}` : ''} *(${l.guild})*`;
    return `\`${time}\` **${l.command}** by ${l.user}${l.args?.length ? ' ' + l.args.join(' ') : ''} *(${l.guild})*`;
  });
  return i.reply({ embeds: [{
    color: 0x2b2d31,
    title: filter === 'mod' ? '🔨 Moderation Logs' : filter === 'cmd' ? '⌨️ Command Logs' : '📋 Recent Logs',
    description: lines.join('\n'),
    footer: { text: `Showing ${lines.length} of ${entries.length}` },
  }], ...EPHEMERAL });
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
async function handleSlashCommand(interaction) {
  try {
    switch (interaction.commandName) {
      case 'ping':          return slashPing(interaction);
      case 'help':          return slashHelp(interaction);
      case 'stats':         return slashStats(interaction);
      case 'avatar':        return slashAvatar(interaction);
      case 'purge':         return slashPurge(interaction);
      case 'a-dc':          return slashDC(interaction);
      case 'a-pvp':         return slashPvP(interaction);
      case 'subscribe':     return slashSubscribe(interaction);
      case 'unsubscribe':   return slashUnsubscribe(interaction);
      case 'subscriptions': return slashSubscriptions(interaction);
      case 'kick':          return slashKick(interaction);
      case 'ban':           return slashBan(interaction);
      case 'mute':          return slashMute(interaction);
      case 'unmute':        return slashUnmute(interaction);
      case 'mutes':         return slashMutes(interaction);
      case 'linkguard':     return slashLinkguard(interaction);
      case 'logs':          return slashLogs(interaction);
    }
  } catch (err) {
    console.error(`❌ Slash command /${interaction.commandName} failed:`, err);
    const reply = { content: `❌ Error: ${err.message}`, ...EPHEMERAL };
    if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
}

module.exports = { registerSlashCommands, handleSlashCommand };
