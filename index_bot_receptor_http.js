require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const visionClient = new ImageAnnotatorClient();

const app = express();
const port = Number(process.env.PORT || 3100);
app.use(express.json());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const TOKEN_BOT_RECEPTOR = process.env.TOKEN_BOT_RECEPTOR;
const ID_CANAL_DESTINO = process.env.ID_CANAL_DESTINO;
const ID_DEL_ROL = process.env.ID_DEL_ROL;
const ID_PVP_NORMAL_ROL = process.env.ID_PVP_NORMAL_ROL;
const ID_PVP_EVENT_ROL = process.env.ID_PVP_EVENT_ROL;
const ALERT_API_TOKEN = process.env.ALERT_API_TOKEN;
const MONITORED_CHANNEL_ID = process.env.MONITORED_CHANNEL_ID || ID_CANAL_DESTINO;
const OLD_BOT_USER_ID = process.env.OLD_BOT_USER_ID || '';
const MUTED_ROLE_ID = process.env.MUTED_ROLE_ID || '';
const OWNER_ID = process.env.OWNER_ID || '';
const SAFE_BROWSING_API_KEY = process.env.SAFE_BROWSING_API_KEY || '';
const IMPORT_BOT_MESSAGES = String(process.env.IMPORT_BOT_MESSAGES || 'true').toLowerCase() !== 'false';

const PREFIX = '$ricky';
const PREFIX_SHORT = '$r';

if (!TOKEN_BOT_RECEPTOR || !ID_CANAL_DESTINO) {
  console.error('❌ Missing required environment variables: TOKEN_BOT_RECEPTOR and ID_CANAL_DESTINO are required.');
  process.exit(1);
}

const EVENTS_FILE = path.join(__dirname, 'events.json');
const DEVICES_FILE = path.join(__dirname, 'devices.json');
const CHANNELS_FILE = path.join(__dirname, 'channels.json');
const LOGS_FILE = path.join(__dirname, 'logs.json');
const AUTOMOD_FILE = path.join(__dirname, 'automod.json');
const MAX_EVENTS = 100;
const _htmlCache = {};
const MAX_DEVICES = 200;

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW   = 60_000;  // ventana de 60 segundos
const RATE_LIMIT_MAX      = 10;      // máximo 10 comandos por ventana
const RATE_LIMIT_COOLDOWN = 60_000;  // bloqueado 60s si supera el límite
const _rateLimits = new Map();

// Limpia entradas expiradas cada 5 minutos para no acumular memoria
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

  // Si está en cooldown activo, rechazar
  if (entry.blockedUntil > now) return true;

  // Ventana expirada — reiniciar contador
  if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
    _rateLimits.set(userId, { count: 1, windowStart: now, blockedUntil: 0 });
    return false;
  }

  // Incrementar dentro de la ventana
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    entry.blockedUntil = now + RATE_LIMIT_COOLDOWN;
    _rateLimits.set(userId, entry);
    return true;
  }

  _rateLimits.set(userId, entry);
  return false;
}
// ── Fin Rate Limiting ─────────────────────────────────────────────────────────


// Debounced async file writer — avoids blocking the event loop on every mutation
const _saveTimers = {};
function debouncedWrite(key, file, getData, delay = 800) {
  clearTimeout(_saveTimers[key]);
  _saveTimers[key] = setTimeout(() => {
    fs.writeFile(file, JSON.stringify(getData(), null, 2), (err) => {
      if (err) console.error(`❌ Failed to save ${key}:`, err.message);
    });
  }, delay);
}

function loadJsonArray(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let events = loadJsonArray(EVENTS_FILE);
let registeredDevices = loadJsonArray(DEVICES_FILE);
let subscribedChannels = loadJsonArray(CHANNELS_FILE);

let botLogs = loadJsonArray(LOGS_FILE);
const MAX_LOGS = 200;

function saveLogs() {
  debouncedWrite('logs', LOGS_FILE, () => botLogs);
}

// Registra un evento de comando o moderación
function addLog(type, data) {
  botLogs = [{ type, ...data, at: new Date().toISOString() }, ...botLogs].slice(0, MAX_LOGS);
  saveLogs();
}

let automodConfig = (() => {
  try { const r = fs.readFileSync(AUTOMOD_FILE, 'utf8'); const p = JSON.parse(r); return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {}; } catch { return {}; }
})();

// userId_guildId -> timestamp when immunity expires (set after manual unmute via button)
const immuneUsers = new Map();
function isImmune(userId, guildId) {
  const key = userId + '_' + guildId;
  const until = immuneUsers.get(key);
  if (!until) return false;
  if (Date.now() >= until) { immuneUsers.delete(key); return false; }
  return true;
}
function setImmune(userId, guildId) {
  immuneUsers.set(userId + '_' + guildId, Date.now() + 2 * 60 * 60 * 1000);
}

// Parsea strings de duración: "30s", "5m", "2h", "1d", "1h30m", etc.
// Retorna milisegundos o null si el formato no es válido
const MAX_MUTE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function parseDuration(str) {
  if (!str) return null;
  const re = /^(?:(d+)d)?(?:(d+)h)?(?:(d+)m)?(?:(d+)s)?$/i;
  const m = str.trim().match(re);
  if (!m || !str.trim()) return null;
  const [, d, h, min, s] = m.map(Number);
  const ms = ((d||0)*86400 + (h||0)*3600 + (min||0)*60 + (s||0)) * 1000;
  return ms > 0 ? Math.min(ms, MAX_MUTE_MS) : null;
}

// Formatea milisegundos a string legible: "1h 30m", "2d", "45m", etc.
function formatDuration(ms) {
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return [d&&`${d}d`, h&&`${h}h`, m&&`${m}m`, s&&`${s}s`].filter(Boolean).join(' ');
}

// userId_guildId -> timeoutId. Permite cancelar un mute temporal si se desmutea antes.
const muteTimers = new Map();

// userId_guildId -> { reason, mutedBy, mutedAt, expiresAt|null }. Registro de mutes activos.
const activeMutes = new Map();

// Programa la remoción automática del rol muted después de durationMs
function scheduleMuteExpiry(member, role, durationMs) {
  const key = member.id + '_' + member.guild.id;
  if (muteTimers.has(key)) clearTimeout(muteTimers.get(key));
  const timer = setTimeout(async () => {
    muteTimers.delete(key);
    activeMutes.delete(key);
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
  muteTimers.set(key, timer);
}

function saveAutomod() {
  debouncedWrite('automod', AUTOMOD_FILE, () => automodConfig);
}

function saveChannels() {
  debouncedWrite('channels', CHANNELS_FILE, () => subscribedChannels);
}
const seenDiscordMessageIds = new Set(
  events.map((event) => event.discordMessageId).filter(Boolean)
);

function saveEvents() {
  debouncedWrite('events', EVENTS_FILE, () => events);
}

function saveDevices() {
  debouncedWrite('devices', DEVICES_FILE, () => registeredDevices);
}

function addEvent(type, title, body, extra = {}) {
  const event = {
    id: extra.id || `evt_${Date.now()}`,
    type,
    title,
    body,
    source: extra.source || 'http-api',
    createdAt: extra.createdAt || new Date().toISOString(),
    discordMessageId: extra.discordMessageId || null,
  };

  if (event.discordMessageId) {
    seenDiscordMessageIds.add(event.discordMessageId);
  }

  events = [event, ...events.filter((existing) => existing.id !== event.id)].slice(0, MAX_EVENTS);
  saveEvents();
  return event;
}

function registerDevice({ token, platform, appBundleId, environment }) {
  const now = new Date().toISOString();
  const device = {
    token,
    platform: platform || 'unknown',
    appBundleId: appBundleId || 'unknown',
    environment: environment || 'unknown',
    registeredAt: now,
    updatedAt: now,
  };

  registeredDevices = [
    { ...device, ...(registeredDevices.find((existing) => existing.token === token) || {}), updatedAt: now },
    ...registeredDevices.filter((existing) => existing.token !== token),
  ].slice(0, MAX_DEVICES);

  saveDevices();
  return registeredDevices[0];
}

function requireAuth(req, res, next) {
  if (!ALERT_API_TOKEN) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (token !== ALERT_API_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

async function sendAlert(roleId, content) {
  const canal = await client.channels.fetch(ID_CANAL_DESTINO);
  if (!canal) throw new Error('Canal destino no encontrado');
  const prefix = roleId ? `<@&${roleId}> ` : '';
  await canal.send(`${prefix}${content}`.trim());
}

async function handleAlert({ type, title, body, roleId, decorate }) {
  const content = decorate ? decorate(body) : body;
  // Envía al canal principal con mención de rol
  await sendAlert(roleId, content);
  // Broadcast a canales suscritos (sin mención de rol, son otros servidores)
  await broadcastEvent(type, content);
  return addEvent(type, title, body, { source: 'http-api' });
}

function normalizeContent(text) {
  return String(text || '')
    .replace(/<@&\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyDiscordMessage(text) {
  const normalized = normalizeContent(text);
  const lower = normalized.toLowerCase();

  if (lower.includes('double coins')) {
    return {
      type: 'doublecoins',
      title: 'Double Coins',
      body: normalized,
    };
  }

  if (lower.includes('antimatter pvp arena') || lower.includes('pvp arena has opened')) {
    return {
      type: 'pvp_normal',
      title: 'PvP Normal',
      body: normalized,
    };
  }

  if (lower.includes('plasma events are being hosted') || lower.includes('join to win some shiny plasma coins')) {
    return {
      type: 'plasma_event',
      title: 'Plasma Event',
      body: normalized,
    };
  }

  return null;
}

function shouldImportDiscordMessage(message) {
  if (!IMPORT_BOT_MESSAGES) return false;
  if (!message?.author) return false;
  if (message.channelId !== MONITORED_CHANNEL_ID) return false;
  if (OLD_BOT_USER_ID && message.author.id !== OLD_BOT_USER_ID) return false;
  if (!OLD_BOT_USER_ID && !message.author.bot) return false;
  if (seenDiscordMessageIds.has(message.id)) return false;
  return true;
}

// Mapeo de aliases de eventos a tipos internos
const EVENT_ALIASES = {
  doublecoins: 'doublecoins',
  dc: 'doublecoins',
  pvp: 'pvp_normal',
  pvpnormal: 'pvp_normal',
  plasma: 'plasma_event',
  'plasma-event': 'plasma_event',
};
const ALL_EVENT_TYPES = ['doublecoins', 'pvp_normal', 'plasma_event'];
const EVENT_LABELS = {
  doublecoins: 'Double Coins',
  pvp_normal: 'PvP Normal',
  plasma_event: 'Plasma Event',
};

// Envía un mensaje a todos los canales suscritos a ese tipo de evento
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

// TLDs exclusivos de contenido adulto
const ADULT_TLD_PATTERN = /\.(?:xxx|porn|adult|sex|sexy|nude)(?:[/?#]|$)/i;

// Palabras clave NSFW en subdominio o ruta de la URL
const NSFW_URL_KEYWORDS = ['porn','xxx','hentai','nsfw','nude','naked','onlyfan','chaturbat','camgirl'];

// Lista viva de dominios maliciosos (cargada desde GitHub cada 6h)
let liveBlocklist = new Set();

async function refreshLiveBlocklist() {
  try {
    const FETCH_TIMEOUT = AbortSignal.timeout(10000);
    const [scamRes, phishRes] = await Promise.all([
      fetch('https://raw.githubusercontent.com/Discord-AntiScam/scam-links/main/list.json', { signal: AbortSignal.timeout(10000) }),
      fetch('https://raw.githubusercontent.com/nikolaischunk/discord-phishing-links/main/domain-list.json', { signal: AbortSignal.timeout(10000) }),
    ]);
    const scamList  = await scamRes.json();
    const phishData = await phishRes.json();
    liveBlocklist = new Set([
      ...(Array.isArray(scamList) ? scamList : []),
      ...(Array.isArray(phishData.domains) ? phishData.domains : []),
    ]);
    console.log(`🛡️ Live blocklist refreshed: ${liveBlocklist.size} domains`);
  } catch (err) {
    console.error('❌ Live blocklist refresh failed:', err.message);
  }
}

// Verifica si un hostname está en la lista viva (exacto o subdominio)
function isInLiveBlocklist(hostname) {
  if (liveBlocklist.has(hostname)) return true;
  const parts = hostname.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (liveBlocklist.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// Consulta Google Safe Browsing API (solo si SAFE_BROWSING_API_KEY está configurado)
// Batch Safe Browsing: checks all URLs in a single API call
async function checkSafeBrowsingBatch(urls) {
  if (!SAFE_BROWSING_API_KEY || !urls.length) return [];
  try {
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${SAFE_BROWSING_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({
          client: { clientId: 'discord-bot', clientVersion: '1.0' },
          threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: urls.map(url => ({ url })),
          },
        }),
      }
    );
    const data = await res.json();
    return data.matches || [];
  } catch { return []; }
}

// Fragmentos de dominio asociados a scam
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

// Caché de invites revisados para no spamear la API de Discord
const inviteCache = new Map();
const INVITE_CACHE_TTL = 5 * 60 * 1000;

// Normaliza un hostname para detectar leetspeak y unicode obfuscation
function normalizeDomain(domain) {
  return domain
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[​-‍؜᠎﻿­]/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/@/g, 'a');
}

// Levenshtein para detectar typosquatting
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

// Verifica si un hostname hace typosquatting de un dominio confiable
function checkTyposquatting(hostname) {
  const norm = normalizeDomain(hostname);
  for (const trusted of TRUSTED_DOMAINS) {
    const normTrusted = normalizeDomain(trusted);
    if (norm === normTrusted) return null;
    if (levenshtein(norm, normTrusted) <= 2) {
      return { type: 'phishing', label: `Phishing — spoofing ${trusted}`, url: hostname };
    }
  }
  return null;
}

// Verifica un invite de Discord via API (con caché de 5 min)
async function checkDiscordInvite(code) {
  const cached = inviteCache.get(code);
  if (cached && Date.now() - cached.ts < INVITE_CACHE_TTL) return cached.result;
  try {
    const invite = await client.fetchInvite(code);
    let result = null;
    if (invite.guild) {
      // nsfwLevel: DEFAULT=0, EXPLICIT=1, SAFE=2, AGE_RESTRICTED=3
      if (invite.guild.nsfwLevel === 1 || invite.guild.nsfwLevel === 3) {
        result = { type: 'nsfw_invite', label: 'NSFW Discord Server Invite', url: `discord.gg/${code}` };
      }
    }
    if (inviteCache.size >= 500) inviteCache.delete(inviteCache.keys().next().value);
    inviteCache.set(code, { result, ts: Date.now() });
    return result;
  } catch {
    if (inviteCache.size >= 500) inviteCache.delete(inviteCache.keys().next().value);
    inviteCache.set(code, { result: null, ts: Date.now() });
    return null;
  }
}

// Detecta porno o scam en un mensaje
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

async function extractTextFromImage(imageUrl) {
  try {
    const [result] = await visionClient.textDetection({ image: { source: { imageUri: imageUrl } } });
    return result.textAnnotations?.[0]?.description || '';
  } catch (err) {
    console.error('\u274c Vision OCR failed:', err.message);
    return '';
  }
}

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


// Versión restringida para texto extraído por OCR.
// Solo chequea URLs y dominios explícitos — omite patrones de texto para
// evitar falsos positivos con frases legítimas de apps ("Claim your reward", etc.)
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

// Ejecuta acciones automod y notifica al canal de log
async function checkAutomod(message) {
  if (message.author.bot) return;
  if (!message.guild) return;

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
      // Registrar mute activo
      activeMutes.set(message.author.id + '_' + message.guild.id, {
        reason: violation.label,
        mutedBy: 'AutoMod',
        mutedAt: Date.now(),
        expiresAt: autoMuteDuration ? Date.now() + autoMuteDuration : null,
      });
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

// Busca el rol Muted | NSFW o lo crea para violaciones de contenido adulto
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

// Busca el rol Muted o lo crea con permisos en todos los canales
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

client.on('ready', () => {
  BOT_READY_AT = Date.now();
  console.log(`✅ Bot receptor HTTP conectado como ${client.user.tag}`);
  refreshLiveBlocklist();
  setInterval(refreshLiveBlocklist, 6 * 60 * 60 * 1000);

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

const _processedMsgIds = new Set();
const _processedMsgQueue = [];
const _recentEventTypes = new Map();

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
        // Registrar mute activo
        activeMutes.set(target.id + '_' + message.guild.id, {
          reason,
          mutedBy: message.author.tag,
          mutedAt: Date.now(),
          expiresAt: muteDuration ? Date.now() + muteDuration : null,
        });
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
        // Limpiar registro de mute activo y cancelar timer si existe
        const _unmuteKey = target.id + '_' + message.guild.id;
        if (muteTimers.has(_unmuteKey)) { clearTimeout(muteTimers.get(_unmuteKey)); muteTimers.delete(_unmuteKey); }
        activeMutes.delete(_unmuteKey);
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
          saveAutomod();
          await message.reply('✅ AutoMod is now **enabled** for this server.');
        } else if (sub === 'off') {
          automodConfig[message.guild.id] = { ...cfg, enabled: false };
          saveAutomod();
          await message.reply('✅ AutoMod is now **disabled** for this server.');
        } else if (sub === 'logchannel') {
          const logCh = message.mentions.channels.first();
          if (!logCh) {
            await message.reply('❌ Mention a channel. Usage: `$ricky automod logchannel #channel`');
            return;
          }
          automodConfig[message.guild.id] = { ...cfg, logChannelId: logCh.id };
          saveAutomod();
          await message.reply(`✅ AutoMod alerts will be sent to <#${logCh.id}>.`);
        } else if (sub === 'modchannel') {
          const modCh = message.mentions.channels.first();
          if (!modCh) {
            await message.reply('❌ Mention a channel. Usage: `$ricky linkguard modchannel #channel`');
            return;
          }
          automodConfig[message.guild.id] = { ...cfg, modAlertChannelId: modCh.id };
          saveAutomod();
          await message.reply(`✅ Mod alert panel configured in <#${modCh.id}>. Moderators will receive alerts with Unmute and Ban buttons.`);
        } else if (sub === 'muteduration') {
          const durArg = args[1];
          if (durArg === 'off' || durArg === 'none' || durArg === '0') {
            automodConfig[message.guild.id] = { ...cfg, muteDuration: null };
            saveAutomod();
            await message.reply('✅ Auto-mute duration removed. Mutes will be permanent until manually removed.');
          } else {
            const rawMs = parseDuration(durArg);
            if (!rawMs) {
              await message.reply('❌ Invalid duration. Examples: `30m`, `1h`, `12h`, `1d`, `30d`. Use `off` to disable. Max: **30 days**.');
              return;
            }
            const ms = Math.min(rawMs, MAX_MUTE_MS);
            const capped = rawMs > MAX_MUTE_MS;
            automodConfig[message.guild.id] = { ...cfg, muteDuration: ms };
            saveAutomod();
            await message.reply(`✅ Auto-mute duration set to **${formatDuration(ms)}**${capped ? ' *(capped at 30 days)*' : ''}. Users will be automatically unmuted after this time.`);
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
        saveChannels();

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
        // Si no queda ningun evento, elimina la entrada
        if (!entry.events.length) {
          subscribedChannels = subscribedChannels.filter((c) => c.channelId !== message.channel.id);
        }
        saveChannels();

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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    source: 'http-api',
    monitoredChannelId: MONITORED_CHANNEL_ID,
    importBotMessages: IMPORT_BOT_MESSAGES,
    oldBotUserIdConfigured: Boolean(OLD_BOT_USER_ID),
    registeredDeviceCount: registeredDevices.length,
    pushArchitecture: 'registration-only',
  });
});

app.get('/events/latest', (_req, res) => {
  res.json(events[0] ?? null);
});

app.get('/events', (req, res) => {
  const limit = Number(req.query.limit || 20);
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  let result = [...events];
  if (since && !Number.isNaN(since.getTime())) {
    result = result.filter((event) => new Date(event.createdAt) > since);
  }
  res.json(result.slice(0, limit));
});

app.get('/devices', requireAuth, (_req, res) => {
  res.json({
    count: registeredDevices.length,
    devices: registeredDevices,
  });
});

app.post('/devices/register', requireAuth, (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) {
    return res.status(400).json({ error: 'Device token is required' });
  }

  const device = registerDevice({
    token,
    platform: String(req.body?.platform || 'ios'),
    appBundleId: String(req.body?.appBundleId || 'unknown'),
    environment: String(req.body?.environment || 'unknown'),
  });

  console.log(`📱 Registered device ${device.platform} ${device.environment} ${device.appBundleId}`);
  res.status(201).json({ ok: true, device, pushReady: false, note: 'APNs send not wired yet; registration stored.' });
});

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

app.listen(port, () => {
  console.log(`🌐 HTTP API listening on port ${port}`);
});


// ── AutoMod button interactions ───────────────────────────────────────────────
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
      // Limpiar registro de mute activo y cancelar timer si existe
      const _btnUnmuteKey = userId + '_' + guild.id;
      if (muteTimers.has(_btnUnmuteKey)) { clearTimeout(muteTimers.get(_btnUnmuteKey)); muteTimers.delete(_btnUnmuteKey); }
      activeMutes.delete(_btnUnmuteKey);
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
    if (hadRecord) {
      console.log('Role muted removed manually from ' + newMember.user.tag + ' in ' + newMember.guild.name + ' -- records cleared');
    }
  } catch (err) {
    console.error('guildMemberUpdate handler error:', err.message);
  }
});
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

client.login(TOKEN_BOT_RECEPTOR);
