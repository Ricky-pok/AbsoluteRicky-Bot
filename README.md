# AbsoluteRicky Bot

[![Version](https://img.shields.io/badge/version-1.7.2-blue.svg)]()
[![License](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)]()
[![Discord.js](https://img.shields.io/badge/discord.js-v14-7289DA.svg)]()

Discord bot for the **Plasma Survival / Graal Online Era** community. Combines a real-time event notification system, multi-server moderation, and a 10-layer AutoMod (LinkGuard) that detects NSFW content, scams, phishing, and typosquatting.

> Prefix commands: `$ricky` (or `$r`). Slash commands coming in v2.0.

## Features

### 🛡️ LinkGuard AutoMod (per-server)
- NSFW / adult content detection (80+ domains, TLDs, URL keywords)
- Scam pattern detection (Free Nitro, fake giveaways, crypto scams, …)
- Phishing / typosquatting via Levenshtein distance
- Live blocklist (~39k domains, refreshed every 6h from public lists)
- Google Safe Browsing integration (optional)
- NSFW Discord invite detection via Discord API
- Image OCR (Google Cloud Vision) for screenshots
- Forwarded-message inspection via raw Discord API
- Auto-mute with configurable duration (1m → 3 months) or permanent
- Mod action panel with Unmute/Ban buttons + 2h immunity after manual unmute

### 🎮 Graal Online Era event system
- Real-time notifications for Double Coins, AntiMatter PvP Arena, and Plasma Events
- Per-channel subscription system (`$ricky subscribe pvp`)
- Auto-import from a monitored Discord channel
- Built-in countdown commands (`$ricky dc`, `$ricky pvp`)
- HTTP API for external triggers (iOS app, scheduled job, etc.)

### 🔨 Moderation
- `mute`, `unmute`, `mutes` (with persistent mute storage in SQLite + auto-restore on restart)
- `kick`, `ban`, `purge`
- Flexible duration parsing: `30m`, `1h 30m`, `2d 4h`, `3mo`, `1w 2d 3h 15m`
- Per-server `Muted` role auto-created with permission overrides on all channels

### 🌐 HTTP API
- `GET /health` — uptime + monitored channel
- `GET /events` — recent events with pagination + filter by date
- `POST /alerts/{doublecoins|pvp-normal|plasma-event}` — trigger broadcast
- `POST /messages/send` — send plain text to main channel
- Bearer token authentication (`ALERT_API_TOKEN` env var)

## Architecture

```
bot-receptor-http/
├── index.js          ← entry point + Express HTTP API
├── config.js         ← env vars + constants
├── db.js             ← SQLite schema + prepared statements + migration
├── state.js          ← in-memory state (events, logs, mutes, …)
├── client.js         ← Discord + Google Vision singletons
├── lib.js            ← pure helpers (parseDuration, Levenshtein, …)
├── mutes.js          ← mute role + timer helpers + rebuild on startup
├── automod.js        ← LinkGuard detection engine (10 layers)
├── commands.js       ← all $ricky / $r commands + dispatcher
└── handlers.js       ← Discord event handlers + broadcast pipeline
```

Persistence is **SQLite** (`better-sqlite3`) — events, logs, automod config, subscribed channels, and active mutes all survive restarts. JSON files are preserved as a one-shot migration safety net.

## Setup

### Requirements
- Node.js ≥ 20
- A Discord bot application with `MESSAGE_CONTENT` and `GUILD_MEMBERS` privileged intents
- (Optional) Google Cloud Vision API for OCR
- (Optional) Google Safe Browsing API key

### Installation

```bash
git clone https://github.com/Ricky-pok/AbsoluteRicky-Bot.git
cd AbsoluteRicky-Bot
npm install
cp .env.example .env       # fill in your tokens
node index.js              # or with PM2: pm2 start index.js --name bot-receptor-http
```

### Required env vars
See [.env.example](./.env.example) for the complete list. The bot will refuse to start without `TOKEN_BOT_RECEPTOR` and `ID_CANAL_DESTINO`.

## Commands

See [docs/COMMANDS.md](./docs/COMMANDS.md) for the full command reference with examples.

Quick reference:
- **Public:** `ping`, `help`, `stats`, `avatar`, `dc`, `pvp`, `subscriptions`
- **Moderation** (perms required): `mute`, `unmute`, `mutes`, `kick`, `ban`, `purge`
- **Admin/owner-only:** `logs`, `linkguard`, `subscribe`, `unsubscribe`, `helpricky`

## Deployment notes

- The author runs this on a Google Cloud Compute Engine `e2-micro` (Debian 12) with `pm2` for process management and `nginx` + Certbot for SSL termination.
- VM is hardened with UFW (deny incoming, only 22/80/443) and fail2ban.
- See git tags `v1.4.0` (SQLite migration) and `v1.5.0` (iOS cleanup + VM hardening) for the persistence and security history.

## License

[MIT](./LICENSE) © Jose Felix (Ricky)
