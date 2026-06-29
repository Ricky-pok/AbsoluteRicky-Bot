// Motor de AutoMod: detección de NSFW, scam, phishing, typosquatting, malicious
// links, NSFW invites, OCR de imágenes, integración con Google Safe Browsing.
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { client, visionClient } = require('./client');
const { env } = require('./config');
const { state, addLog, isImmune, persistActiveMute } = require('./state');
const { normalizeDomain, levenshtein } = require('./lib');
const { getOrCreateMutedRole, getOrCreateNSFWMutedRole, scheduleMuteExpiry } = require('./mutes');

// ── Listas de dominios y patrones ──────────────────────────────────────────
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

const ADULT_TLD_PATTERN = /\.(?:xxx|porn|adult|sex|sexy|nude)(?:[/?#]|$)/i;
const NSFW_URL_KEYWORDS = ['porn','xxx','hentai','nsfw','nude','naked','onlyfan','chaturbat','camgirl'];

const SCAM_DOMAIN_FRAGMENTS = [
  'discordnitro','discord-nitro','free-nitro','nitro-discord','discord-gift',
  'discordgift','nitro-free','freenitro','claimnitro','nitroclaim','getnitro',
  'steamgift','steam-gift','freegift','free-steam','steamtrade','steamtrd',
  'csgo-skins','csgoskins','csgofree','free-robux','freerobux','robux-free',
  'epicfree','free-vbucks','vbucks-free','roblox-free',
  'rexawin','crypto-casino','cryptocasino','casinocrypto','casino-crypto',
];

const TRUSTED_DOMAINS = [
  'discord.com','discordapp.com','discord.gg',
  'steamcommunity.com','steampowered.com',
];

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

// ── Live blocklist (~39k dominios, refresca cada 6h) ───────────────────────
let liveBlocklist = new Set();

async function refreshLiveBlocklist() {
  try {
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

function isInLiveBlocklist(hostname) {
  if (liveBlocklist.has(hostname)) return true;
  const parts = hostname.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (liveBlocklist.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

// ── Google Safe Browsing (opcional, requiere SAFE_BROWSING_API_KEY) ──────
async function checkSafeBrowsingBatch(urls) {
  if (!env.SAFE_BROWSING_API_KEY || !urls.length) return [];
  try {
    const res = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${env.SAFE_BROWSING_API_KEY}`,
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

// ── Typosquatting ──────────────────────────────────────────────────────────
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

// ── Discord invite check (NSFW server detection) ───────────────────────────
const inviteCache = new Map();
const INVITE_CACHE_TTL = 5 * 60 * 1000;

async function checkDiscordInvite(code) {
  const cached = inviteCache.get(code);
  if (cached && Date.now() - cached.ts < INVITE_CACHE_TTL) return cached.result;
  try {
    const invite = await client.fetchInvite(code);
    let result = null;
    if (invite.guild) {
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

// ── detectViolation — motor principal (10 capas) ───────────────────────────
async function detectViolation(content) {
  const urls = content.match(/https?:\/\/[^\s<>"']+/gi) || [];
  const safeBrowsingCandidates = [];
  for (const rawUrl of urls) {
    let parsed, hostname;
    try { parsed = new URL(rawUrl); hostname = parsed.hostname.toLowerCase(); } catch { continue; }
    const normHost = normalizeDomain(hostname);

    if (ADULT_TLD_PATTERN.test(rawUrl)) return { type: 'nsfw', label: 'NSFW / Adult TLD', url: rawUrl };

    const urlPath = (hostname + parsed.pathname).toLowerCase();
    if (NSFW_URL_KEYWORDS.some((kw) => urlPath.includes(kw))) return { type: 'nsfw', label: 'NSFW / Adult Content', url: rawUrl };

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

    safeBrowsingCandidates.push(rawUrl);
  }

  if (safeBrowsingCandidates.length > 0) {
    const matches = await checkSafeBrowsingBatch(safeBrowsingCandidates);
    if (matches.length > 0) {
      return { type: 'scam', label: `Threat Detected: ${matches[0].threatType}`, url: matches[0].threat.url };
    }
  }

  for (const { re, label } of SCAM_TEXT_PATTERNS) {
    if (re.test(content)) return { type: 'scam', label, url: null };
  }

  const plainDomains = content.match(/\b[\w-]+\.(?:com|net|org|io|gg|win|xyz|site|online|app)\b/gi) || [];
  for (const domain of plainDomains) {
    const normD = normalizeDomain(domain);
    for (const frag of SCAM_DOMAIN_FRAGMENTS) {
      if (normD.includes(frag)) return { type: 'scam', label: 'Scam Domain', url: domain };
    }
    if (isInLiveBlocklist(domain)) return { type: 'scam', label: 'Known Malicious Domain', url: domain };
  }

  const inviteRegex = /discord(?:(?:app)?\.com\/invite|\.gg(?:\/invite)?)\/([a-zA-Z0-9\-]{2,32})/gi;
  let m;
  while ((m = inviteRegex.exec(content)) !== null) {
    const result = await checkDiscordInvite(m[1]);
    if (result) return result;
  }

  return null;
}

// ── OCR para imágenes (Google Cloud Vision) ────────────────────────────────
async function extractTextFromImage(imageUrl) {
  try {
    const [result] = await visionClient.textDetection({ image: { source: { imageUri: imageUrl } } });
    return result.textAnnotations?.[0]?.description || '';
  } catch (err) {
    console.error('❌ Vision OCR failed:', err.message);
    return '';
  }
}

// Versión para OCR: chequea dominios primero. Como fallback, aplica
// SCAM_TEXT_PATTERNS con regla híbrida — un solo patrón da falsos positivos
// (ej: "Claim your reward" en Graal Online), pero ≥2 patrones distintos, o 1
// patrón + dominio en TLD sospechoso, son señal alta de scam.
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

  const patternHits = SCAM_TEXT_PATTERNS.filter(p => p.re.test(text));
  if (patternHits.length >= 2) {
    const labels = patternHits.slice(0, 3).map(p => p.label).join(', ');
    return {
      type: 'scam',
      label: `OCR Scam Patterns (${patternHits.length}): ${labels}`,
      url: plainDomains[0] || urls[0] || null,
    };
  }
  if (patternHits.length === 1) {
    const SUSPICIOUS_TLDS = /\.(win|xyz|site|online|app)$/i;
    const suspDomain = plainDomains.find(d => SUSPICIOUS_TLDS.test(d));
    if (suspDomain) {
      return {
        type: 'scam',
        label: `OCR Scam Pattern + Suspicious TLD: ${patternHits[0].label}`,
        url: suspDomain,
      };
    }
  }

  return null;
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

// ── checkAutomod — entry point que conecta detección con acciones ──────────
async function checkAutomod(message) {
  if (message.author.bot) return;
  if (!message.guild) return;

  const config = state.automodConfig[message.guild.id];
  if (!config?.enabled) return;

  let violation = await detectViolation(message.content);
  if (!violation && message.attachments.size > 0) {
    violation = await detectViolationInImages([...message.attachments.values()]);
  }
  // Mensajes forwarded: fetch raw desde la API de Discord
  if (!violation && message.messageSnapshots?.size > 0) {
    try {
      const rawRes = await fetch(
        `https://discord.com/api/v10/channels/${message.channelId}/messages/${message.id}`,
        { headers: { Authorization: `Bot ${env.TOKEN_BOT_RECEPTOR}` }, signal: AbortSignal.timeout(5000) }
      );
      if (rawRes.ok) {
        const rawData = await rawRes.json();
        const snapMsg = rawData.message_snapshots?.[0]?.message;
        if (snapMsg) {
          if (snapMsg.content) violation = await detectViolation(snapMsg.content);
          if (!violation && snapMsg.attachments?.length > 0) {
            violation = await detectViolationInImages(snapMsg.attachments.map(a => ({
              url: a.url, contentType: a.content_type ?? 'image/jpeg',
            })));
          }
        }
      }
    } catch (err) {
      console.error('❌ Failed to fetch forwarded message raw data:', err.message);
    }
  }
  if (!violation) return;

  // Si el usuario tiene inmunidad activa: pasa, no se mutea, solo log
  if (isImmune(message.author.id, message.guild.id)) {
    const immuneKey = message.author.id + '_' + message.guild.id;
    const immuneUntil = state.immuneUsers.get(immuneKey);
    addLog('mod', {
      action: 'automod_skipped_immunity',
      target: message.author.tag, targetId: message.author.id,
      violationType: violation.type, label: violation.label,
      url: violation.url || 'N/A',
      guild: message.guild.name, guildId: message.guild.id,
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
      const autoMuteDuration = config.muteDuration;
      if (autoMuteDuration) scheduleMuteExpiry(message.member, mutedRole, autoMuteDuration);
      const muteKey = message.author.id + '_' + message.guild.id;
      const muteInfo = {
        reason: violation.label,
        mutedBy: 'AutoMod',
        mutedAt: Date.now(),
        expiresAt: autoMuteDuration ? Date.now() + autoMuteDuration : null,
      };
      state.activeMutes.set(muteKey, muteInfo);
      persistActiveMute(muteKey, muteInfo);
    }
  } catch (err) {
    console.error('❌ AutoMod mute failed:', err.message);
  }

  addLog('mod', {
    action: 'automod',
    target: message.author.tag, targetId: message.author.id,
    violationType: violation.type, label: violation.label,
    url: violation.url || 'N/A',
    guild: message.guild.name, guildId: message.guild.id,
  });

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

module.exports = {
  refreshLiveBlocklist,
  checkAutomod,
};
