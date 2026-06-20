// Helpers puros (sin estado). Importables desde cualquier módulo.
const fs = require('fs');
const { MAX_MUTE_MS } = require('./config');

// Carga un array desde un archivo JSON. Retorna [] si no existe o está corrupto.
function loadJsonArray(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Parsea una duración en cualquier combinación de unidades.
// Ejemplos: "5m", "1h 30m", "2d 4h", "3mo", "1w 2d 3h 15m"
// Unidades: mo (mes), w (semana), d (día), h (hora), m/min (minuto), s (segundo)
// Cap máximo: 3 meses (MAX_MUTE_MS). Retorna ms o null si no se pudo parsear.
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
  return [d&&`${d}d`, h&&`${h}h`, m&&`${m}m`, s&&`${s}s`].filter(Boolean).join(' ');
}

// Limpia un mensaje Discord: quita menciones de rol, colapsa espacios.
function normalizeContent(text) {
  return String(text || '')
    .replace(/<@&\d+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normaliza un dominio (NFKC, leetspeak → letras, elimina invisibles)
// "d1sc0rd.com" → "discord.com"
function normalizeDomain(domain) {
  return domain
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[​-‍؜᠎﻿­]/g, '')
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/@/g, 'a');
}

// Distancia de Levenshtein — para detección de typosquatting.
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

module.exports = {
  loadJsonArray,
  parseDuration, formatDuration,
  normalizeContent, normalizeDomain, levenshtein,
};
