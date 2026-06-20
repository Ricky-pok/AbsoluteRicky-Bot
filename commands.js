// Implementación de todos los comandos $ricky. El dispatcher matchea por nombre
// y llama al handler correspondiente. Cada handler recibe (message, args) y devuelve.
const { client } = require('./client');
const { stmts } = require('./db');
const { state, addLog, persistAutomodConfig, persistActiveMute, isRateLimited } = require('./state');
const { parseDuration, formatDuration } = require('./lib');
const { getOrCreateMutedRole, scheduleMuteExpiry } = require('./mutes');
const { env, MAX_MUTE_MS } = require('./config');

// Aliases para que $ricky subscribe acepte nombres amigables
const EVENT_ALIASES = {
  doublecoins: 'doublecoins', dc: 'doublecoins',
  pvp: 'pvp_normal', pvpnormal: 'pvp_normal',
  plasma: 'plasma_event', 'plasma-event': 'plasma_event',
};
const ALL_EVENT_TYPES = ['doublecoins', 'pvp_normal', 'plasma_event'];
const EVENT_LABELS = {
  doublecoins: 'Double Coins',
  pvp_normal: 'PvP Normal',
  plasma_event: 'Plasma Event',
};

// ── Ping ─────────────────────────────────────────────────────────────────────
async function cmdPing(message) {
  const sent = await message.reply('🏓 Pinging...');
  await sent.edit(`🏓 Pong! Latency: **${client.ws.ping}ms**`);
}

// ── Help público ─────────────────────────────────────────────────────────────
async function cmdHelp(message) {
  const embed = {
    color: 0x5865f2,
    title: '📋 AbsoluteRicky Bot — Commands',
    description: 'Prefix: `$ricky` or `$r`',
    fields: [
      { name: '┌ 🤖  General', value: '​', inline: false },
      { name: '`$ricky ping`',          value: 'Check if the bot is online and show latency.',      inline: true },
      { name: '`$ricky help`',          value: 'Show this command list.',                            inline: true },
      { name: '`$ricky stats`',         value: 'Show member and bot count for this server.',        inline: true },
      { name: '`$ricky avatar [@user]`',value: 'Show your avatar or another user\'s.',              inline: true },
      { name: '`$ricky purge [1-50]`',  value: 'Delete up to 50 messages in this channel.',        inline: true },
      { name: '┌ 🛡️  Moderation', value: '​', inline: false },
      { name: '`$ricky kick @user [reason]`',            value: 'Kick a member from the server.',                                                                     inline: false },
      { name: '`$ricky ban @user [reason]`',             value: 'Ban a member from the server.',                                                                      inline: false },
      { name: '`$ricky mute @user [duration] [reason]`', value: 'Mute a member. Duration: `30m`, `2h`, `1d`, `3mo` (max 3 months). Omit for permanent.',             inline: false },
      { name: '`$ricky unmute @user`',                   value: 'Remove the mute from a member.',                                                                     inline: false },
      { name: '`$ricky mutes`',                          value: 'List every currently muted member — reason, who muted them, and time remaining.',                    inline: false },
      { name: '┌ 🎮  Graal Online Era', value: '​', inline: false },
      { name: '`$ricky dc`',                                    value: 'Show a countdown to the next **Double Coins** event, or confirm it\'s currently active.',     inline: false },
      { name: '`$ricky pvp`',                                    value: 'Show a countdown to the next **PvP Arena** event, or confirm it\'s currently active.',     inline: false },
      { name: '`$ricky subscribe <event>`',                     value: 'Subscribe this channel to get pinged when an event starts.\nEvents: `doublecoins` `pvp` `plasma` `all`', inline: false },
      { name: '`$ricky unsubscribe <event>`',                   value: 'Remove a subscription from this channel.',                                                    inline: false },
      { name: '`$ricky subscriptions`',                         value: 'Show which events this channel is currently subscribed to.',                                  inline: false },
    ],
    footer: { text: 'AbsoluteRicky Bot • $ricky helpricky for admin/setup commands' },
  };
  await message.reply({ embeds: [embed] });
}

// ── HelpRicky (owner-only) ──────────────────────────────────────────────────
async function cmdHelpRicky(message) {
  if (!env.OWNER_ID || message.author.id !== env.OWNER_ID) return;
  const embed = {
    color: 0x2b2d31,
    title: '🔧 Admin & Setup Commands',
    description: 'Prefix: `$ricky` or `$r` — visible only to you',
    fields: [
      { name: '┌ 📁  Logs', value: '​', inline: false },
      { name: '`$ricky logs`',          value: 'View all recent bot logs.',             inline: true },
      { name: '`$ricky logs mod`',       value: 'View moderation actions only.',        inline: true },
      { name: '`$ricky logs cmd`',       value: 'View command usage only.',             inline: true },
      { name: '┌ 🔗  LinkGuard / AutoMod', value: '​', inline: false },
      { name: '`$ricky linkguard on`',                          value: 'Enable the scam/phishing/NSFW link scanner for this server.',                                                                inline: false },
      { name: '`$ricky linkguard off`',                         value: 'Disable the link scanner for this server.',                                                                                  inline: false },
      { name: '`$ricky linkguard logchannel #channel`',         value: 'Set where AutoMod alerts and audit logs are sent.',                                                                          inline: false },
      { name: '`$ricky linkguard modchannel #channel`',         value: 'Set the mod action channel — posts an Unmute/Ban panel on every auto-mute. Unmuting from here grants the user 2h immunity.', inline: false },
      { name: '`$ricky linkguard muteduration <time|off>`',     value: 'How long auto-mutes last: `30m` `1h` `12h` `1d` up to `3mo`. Use `off` for permanent.',                                       inline: false },
      { name: '`$ricky linkguard status`',                      value: 'Show current AutoMod config: enabled, log channel, mod channel, mute duration.',                                            inline: false },
      { name: '┌ 🎮  Graal Online Era — Event Setup', value: '​', inline: false },
      { name: '`$ricky subscribe <event>`',                     value: 'Subscribe this channel to auto-announce events: `doublecoins` `pvp` `plasma` `all`',                                        inline: false },
      { name: '`$ricky unsubscribe <event>`',                   value: 'Remove a subscription from this channel.',                                                                                   inline: false },
      { name: '`$ricky subscriptions`',                         value: 'List all active event subscriptions for this channel.',                                                                      inline: false },
    ],
    footer: { text: 'AbsoluteRicky Bot — admin panel' },
  };
  await message.reply({ embeds: [embed] });
}

// ── Moderación: kick / ban / mute / unmute / mutes ──────────────────────────
async function cmdKick(message, args) {
  if (!message.member.permissions.has('KickMembers')) {
    await message.reply('❌ You do not have permission to kick members.'); return;
  }
  const target = message.mentions.members.first();
  if (!target) { await message.reply('❌ Please mention a user to kick. Usage: `$ricky kick @user [reason]`'); return; }
  if (!target.kickable) { await message.reply('❌ I cannot kick this user. They may have a higher role than me.'); return; }
  const reason = args.slice(1).join(' ') || 'No reason provided';
  await target.kick(reason);
  addLog('mod', { action: 'kick', moderator: message.author.tag, moderatorId: message.author.id, target: target.user.tag, targetId: target.id, reason, guild: message.guild.name, guildId: message.guild.id });
  await message.reply(`✅ **${target.user.tag}** has been kicked. Reason: ${reason}`);
}

async function cmdBan(message, args) {
  if (!message.member.permissions.has('BanMembers')) {
    await message.reply('❌ You do not have permission to ban members.'); return;
  }
  const target = message.mentions.members.first();
  if (!target) { await message.reply('❌ Please mention a user to ban. Usage: `$ricky ban @user [reason]`'); return; }
  if (!target.bannable) { await message.reply('❌ I cannot ban this user. They may have a higher role than me.'); return; }
  const reason = args.slice(1).join(' ') || 'No reason provided';
  await target.ban({ reason });
  addLog('mod', { action: 'ban', moderator: message.author.tag, moderatorId: message.author.id, target: target.user.tag, targetId: target.id, reason, guild: message.guild.name, guildId: message.guild.id });
  await message.reply(`✅ **${target.user.tag}** has been banned. Reason: ${reason}`);
}

async function cmdMute(message, args) {
  if (!message.member.permissions.has('ManageRoles')) {
    await message.reply('❌ You do not have permission to mute members.'); return;
  }
  const target = message.mentions.members.first();
  if (!target) { await message.reply('❌ Please mention a user to mute. Usage: `$ricky mute @user [reason]`'); return; }
  const mutedRole = await getOrCreateMutedRole(message.guild);
  if (target.roles.cache.has(mutedRole.id)) { await message.reply(`⚠️ **${target.user.tag}** is already muted.`); return; }
  const durationStr = args[1];
  const rawDur = parseDuration(durationStr);
  const muteDuration = rawDur ? Math.min(rawDur, MAX_MUTE_MS) : null;
  const durCapped = rawDur && rawDur > MAX_MUTE_MS;
  const reasonStart = muteDuration ? 2 : 1;
  const reason = args.slice(reasonStart).join(' ') || 'No reason provided';
  await target.roles.add(mutedRole, reason);
  if (muteDuration) scheduleMuteExpiry(target, mutedRole, muteDuration);
  const muteKey = target.id + '_' + message.guild.id;
  const muteInfo = {
    reason,
    mutedBy: message.author.tag,
    mutedAt: Date.now(),
    expiresAt: muteDuration ? Date.now() + muteDuration : null,
  };
  state.activeMutes.set(muteKey, muteInfo);
  persistActiveMute(muteKey, muteInfo);
  addLog('mod', { action: 'mute', moderator: message.author.tag, moderatorId: message.author.id, target: target.user.tag, targetId: target.id, reason, duration: muteDuration ? formatDuration(muteDuration) : 'permanent', guild: message.guild.name, guildId: message.guild.id });
  const durationNote = muteDuration ? ` Duration: **${formatDuration(muteDuration)}**${durCapped ? ' *(max 3 months)*' : ''}.` : '';
  await message.reply(`🔇 **${target.user.tag}** has been muted.${durationNote} Reason: ${reason}`);
}

async function cmdUnmute(message) {
  if (!message.member.permissions.has('ManageRoles')) {
    await message.reply('❌ You do not have permission to unmute members.'); return;
  }
  const target = message.mentions.members.first();
  if (!target) { await message.reply('❌ Please mention a user to unmute. Usage: `$ricky unmute @user`'); return; }
  const mutedRole = await getOrCreateMutedRole(message.guild);
  if (!target.roles.cache.has(mutedRole.id)) { await message.reply(`⚠️ **${target.user.tag}** is not muted.`); return; }
  await target.roles.remove(mutedRole);
  const unmuteKey = target.id + '_' + message.guild.id;
  if (state.muteTimers.has(unmuteKey)) { clearTimeout(state.muteTimers.get(unmuteKey)); state.muteTimers.delete(unmuteKey); }
  state.activeMutes.delete(unmuteKey);
  stmts.deleteMute.run(unmuteKey);
  addLog('mod', { action: 'unmute', moderator: message.author.tag, moderatorId: message.author.id, target: target.user.tag, targetId: target.id, guild: message.guild.name, guildId: message.guild.id });
  await message.reply(`🔊 **${target.user.tag}** has been unmuted.`);
}

async function cmdMutes(message) {
  if (!message.member.permissions.has('ManageRoles')) {
    await message.reply('❌ You do not have permission to view active mutes.'); return;
  }
  const mutedRole = await getOrCreateMutedRole(message.guild).catch(() => null);
  if (!mutedRole) { await message.reply('❌ No Muted role found.'); return; }
  await message.guild.members.fetch();
  const mutedMembers = message.guild.members.cache.filter(m => m.roles.cache.has(mutedRole.id));
  if (!mutedMembers.size) { await message.reply('✅ No active mutes in this server.'); return; }
  const now = Date.now();
  const fields = [];
  for (const [, m] of mutedMembers) {
    const key = m.id + '_' + message.guild.id;
    const info = state.activeMutes.get(key);
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
}

// ── Logs (owner-only) ───────────────────────────────────────────────────────
async function cmdLogs(message, args) {
  if (!env.OWNER_ID || message.author.id !== env.OWNER_ID) return;
  const filter = (args[0] || '').toLowerCase();
  let entries = state.botLogs;
  if (filter === 'mod') entries = state.botLogs.filter(l => l.type === 'mod');
  else if (filter === 'cmd') entries = state.botLogs.filter(l => l.type === 'command');
  if (!entries.length) { await message.reply('📭 No logs found.'); return; }
  const lines = entries.slice(0, 15).map(l => {
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
}

// ── Utilidades: avatar, purge, stats ────────────────────────────────────────
async function cmdAvatar(message) {
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
}

async function cmdPurge(message, args) {
  if (!message.member.permissions.has('ManageMessages')) {
    await message.reply('❌ You do not have permission to delete messages.'); return;
  }
  const amount = parseInt(args[0]);
  if (isNaN(amount) || amount < 1 || amount > 50) {
    await message.reply('❌ Provide a number between 1 and 50. Usage: `$ricky purge [1-50]`'); return;
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
}

async function cmdStats(message) {
  await message.guild.members.fetch();
  const total = message.guild.memberCount;
  const bots = message.guild.members.cache.filter(m => m.user.bot).size;
  const humans = total - bots;
  await message.reply({ embeds: [{
    color: 0x5865f2,
    title: `📊 ${message.guild.name}`,
    thumbnail: { url: message.guild.iconURL() || '' },
    fields: [
      { name: '👥 Members', value: humans.toLocaleString(), inline: true },
      { name: '🤖 Bots',    value: bots.toLocaleString(),   inline: true },
      { name: '🌐 Total',   value: total.toLocaleString(),  inline: true },
    ],
  }] });
}

// ── LinkGuard ───────────────────────────────────────────────────────────────
async function cmdLinkGuard(message, args) {
  if (!message.member.permissions.has('ManageGuild')) {
    await message.reply('❌ You need the **Manage Server** permission to configure AutoMod.'); return;
  }
  const sub = (args[0] || '').toLowerCase();
  const cfg = state.automodConfig[message.guild.id] || {};

  if (sub === 'on') {
    state.automodConfig[message.guild.id] = { ...cfg, enabled: true };
    persistAutomodConfig(message.guild.id);
    await message.reply('✅ AutoMod is now **enabled** for this server.');
  } else if (sub === 'off') {
    state.automodConfig[message.guild.id] = { ...cfg, enabled: false };
    persistAutomodConfig(message.guild.id);
    await message.reply('✅ AutoMod is now **disabled** for this server.');
  } else if (sub === 'logchannel') {
    const logCh = message.mentions.channels.first();
    if (!logCh) { await message.reply('❌ Mention a channel. Usage: `$ricky linkguard logchannel #channel`'); return; }
    state.automodConfig[message.guild.id] = { ...cfg, logChannelId: logCh.id };
    persistAutomodConfig(message.guild.id);
    await message.reply(`✅ AutoMod alerts will be sent to <#${logCh.id}>.`);
  } else if (sub === 'modchannel') {
    const modCh = message.mentions.channels.first();
    if (!modCh) { await message.reply('❌ Mention a channel. Usage: `$ricky linkguard modchannel #channel`'); return; }
    state.automodConfig[message.guild.id] = { ...cfg, modAlertChannelId: modCh.id };
    persistAutomodConfig(message.guild.id);
    await message.reply(`✅ Mod alert panel configured in <#${modCh.id}>. Moderators will receive alerts with Unmute and Ban buttons.`);
  } else if (sub === 'muteduration') {
    const durArg = args[1];
    if (durArg === 'off' || durArg === 'none' || durArg === '0') {
      state.automodConfig[message.guild.id] = { ...cfg, muteDuration: null };
      persistAutomodConfig(message.guild.id);
      await message.reply('✅ Auto-mute duration removed. Mutes will be permanent until manually removed.');
    } else {
      const rawMs = parseDuration(durArg);
      if (!rawMs) {
        await message.reply('❌ Invalid duration. Examples: `30m`, `1h`, `12h`, `1d`, `3mo`. Use `off` to disable. Max: **3 months**.'); return;
      }
      const ms = Math.min(rawMs, MAX_MUTE_MS);
      const capped = rawMs > MAX_MUTE_MS;
      state.automodConfig[message.guild.id] = { ...cfg, muteDuration: ms };
      persistAutomodConfig(message.guild.id);
      await message.reply(`✅ Auto-mute duration set to **${formatDuration(ms)}**${capped ? ' *(capped at 3 months)*' : ''}. Users will be automatically unmuted after this time.`);
    }
  } else if (sub === 'status') {
    const status = cfg.enabled ? '🟢 Enabled' : '🔴 Disabled';
    const logCh = cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'Not configured';
    const modChDisplay = cfg.modAlertChannelId ? `<#${cfg.modAlertChannelId}>` : 'Not configured';
    await message.reply({ embeds: [{
      color: cfg.enabled ? 0x00cc66 : 0xff3333,
      title: '🛡️ AutoMod Status',
      fields: [
        { name: 'Status', value: status, inline: true },
        { name: 'Log Channel', value: logCh, inline: true },
        { name: 'Mod Alert Channel', value: modChDisplay, inline: true },
        { name: 'Auto-mute Duration', value: cfg.muteDuration ? formatDuration(cfg.muteDuration) : 'Permanent', inline: true },
        { name: 'Detects', value: '• NSFW / Adult sites\n• Scam links\n• NSFW Discord invites', inline: false },
      ],
    }] });
  } else {
    await message.reply('Usage: `$ricky linkguard <on | off | logchannel #channel | modchannel #channel | muteduration <time|off> | status>`');
  }
}

// ── Suscripciones ───────────────────────────────────────────────────────────
async function cmdSubscribe(message, args) {
  if (!message.member.permissions.has('ManageChannels')) {
    await message.reply('❌ You need the **Manage Channels** permission to subscribe.'); return;
  }
  const input = (args[0] || '').toLowerCase();
  const eventTypes = input === 'all' ? ALL_EVENT_TYPES : [EVENT_ALIASES[input]].filter(Boolean);
  if (!eventTypes.length) {
    await message.reply('❌ Invalid event type. Use: `doublecoins`, `pvp`, `plasma`, or `all`.'); return;
  }
  let entry = state.subscribedChannels.find(c => c.channelId === message.channel.id);
  if (!entry) {
    entry = {
      channelId: message.channel.id,
      guildId: message.guild.id,
      guildName: message.guild.name,
      channelName: message.channel.name,
      events: [],
      addedAt: new Date().toISOString(),
    };
    state.subscribedChannels.push(entry);
  }
  const added = eventTypes.filter(t => !entry.events.includes(t));
  entry.events = [...new Set([...entry.events, ...eventTypes])];
  stmts.upsertChannel.run(entry);
  for (const t of added) stmts.addSub.run(entry.channelId, t);
  const labels = added.map(t => EVENT_LABELS[t]).join(', ');
  if (!added.length) await message.reply('⚠️ This channel is already subscribed to those events.');
  else await message.reply(`✅ This channel will now receive **${labels}** notifications.`);
}

async function cmdUnsubscribe(message, args) {
  if (!message.member.permissions.has('ManageChannels')) {
    await message.reply('❌ You need the **Manage Channels** permission to unsubscribe.'); return;
  }
  const input = (args[0] || '').toLowerCase();
  const eventTypes = input === 'all' ? ALL_EVENT_TYPES : [EVENT_ALIASES[input]].filter(Boolean);
  if (!eventTypes.length) {
    await message.reply('❌ Invalid event type. Use: `doublecoins`, `pvp`, `plasma`, or `all`.'); return;
  }
  const entry = state.subscribedChannels.find(c => c.channelId === message.channel.id);
  if (!entry || !entry.events.length) {
    await message.reply('⚠️ This channel has no active subscriptions.'); return;
  }
  const removed = eventTypes.filter(t => entry.events.includes(t));
  entry.events = entry.events.filter(t => !eventTypes.includes(t));
  for (const t of removed) stmts.removeSub.run(entry.channelId, t);
  if (!entry.events.length) {
    state.subscribedChannels = state.subscribedChannels.filter(c => c.channelId !== message.channel.id);
    stmts.deleteChannel.run(entry.channelId);
  }
  const labels = removed.map(t => EVENT_LABELS[t]).join(', ');
  if (!removed.length) await message.reply('⚠️ This channel was not subscribed to those events.');
  else await message.reply(`✅ Unsubscribed from **${labels}** notifications.`);
}

async function cmdSubscriptions(message) {
  const entry = state.subscribedChannels.find(c => c.channelId === message.channel.id);
  if (!entry || !entry.events.length) {
    await message.reply('📭 This channel has no active subscriptions. Use `$ricky subscribe <event>` to add one.'); return;
  }
  const labels = entry.events.map(t => `• **${EVENT_LABELS[t] || t}**`).join('\n');
  await message.reply(`📬 This channel is subscribed to:\n${labels}`);
}

// ── Timers: dc / pvp ─────────────────────────────────────────────────────────
async function cmdDC(message) {
  const DC_INTERVAL_MS = 18000000; // 5h exactas
  const dcEvents = state.events.filter(e => e.type === 'doublecoins');
  if (!dcEvents.length) { await message.reply('❌ No Double Coins events recorded yet.'); return; }
  const lastMs = new Date(dcEvents[0].createdAt).getTime();
  const now = Date.now();
  const fmt = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`;
  };
  const toTimestamp = (ms) => `<t:${Math.floor(ms/1000)}:R>`;
  // DC inicia 2h después del aviso, dura 1h
  const dcStartMs = lastMs + 2 * 60 * 60 * 1000;
  const dcEndMs = dcStartMs + 60 * 60 * 1000;
  const isActive = now >= dcStartMs && now < dcEndMs;
  let embed;
  if (isActive) {
    const timeLeft = dcEndMs - now;
    embed = {
      color: 0x00cc66,
      title: '⚡ Double Coins — ACTIVE NOW!',
      description: `💰 Double Coins is live! Ends ${toTimestamp(dcEndMs)} (**${fmt(timeLeft)}** left)`,
      timestamp: new Date().toISOString(),
    };
  } else {
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
}

async function cmdPvP(message) {
  const PVP_INTERVAL_MS = 18000000;
  const PVP_DURATION_MS = 30 * 60 * 1000;
  const pvpEvents = state.events.filter(e => e.type === 'pvp_normal');
  if (!pvpEvents.length) { await message.reply('No PvP events recorded yet.'); return; }
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
}

// ── Dispatcher: matchea command → handler ───────────────────────────────────
async function dispatchCommand(message, command, args) {
  // Log de uso del comando (todos los comandos pasan por aquí)
  addLog('command', {
    command,
    args: args.slice(),
    user: message.author.tag,
    userId: message.author.id,
    guild: message.guild?.name || 'DM',
    guildId: message.guild?.id || null,
    channel: message.channel.name || null,
  });

  // Rate limit por usuario (silencioso)
  if (isRateLimited(message.author.id)) return;

  switch (command) {
    case 'ping':         return cmdPing(message);
    case 'help':         return cmdHelp(message);
    case 'helpricky':    return cmdHelpRicky(message);
    case 'kick':         return cmdKick(message, args);
    case 'ban':          return cmdBan(message, args);
    case 'mute':         return cmdMute(message, args);
    case 'unmute':       return cmdUnmute(message);
    case 'mutes':        return cmdMutes(message);
    case 'logs':         return cmdLogs(message, args);
    case 'avatar': case 'av': return cmdAvatar(message);
    case 'purge':        return cmdPurge(message, args);
    case 'stats':        return cmdStats(message);
    case 'linkguard':    return cmdLinkGuard(message, args);
    case 'subscribe':    return cmdSubscribe(message, args);
    case 'unsubscribe':  return cmdUnsubscribe(message, args);
    case 'subscriptions': return cmdSubscriptions(message);
    case 'dctimer': case 'dctime': case 'dc': return cmdDC(message);
    case 'pvptimer': case 'pvptime': case 'pvp': return cmdPvP(message);
  }
}

module.exports = { dispatchCommand, EVENT_ALIASES, ALL_EVENT_TYPES, EVENT_LABELS };
