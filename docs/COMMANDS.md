# Command Reference

All commands work with both prefixes: **`$ricky`** (full) and **`$r`** (short).

---

## 🤖 General

### `$ricky ping`
Latency check. Returns the Discord gateway ping.
```
$ricky ping
→ 🏓 Pong! Latency: 42ms
```

### `$ricky help`
Show the public command list.

### `$ricky stats`
Member + bot count for the current server.

### `$ricky avatar [@user]`
Show your avatar (or another user's) in full resolution.
```
$ricky avatar
$ricky avatar @someone
```

### `$ricky purge [1-50]`
Delete up to 50 recent messages in the current channel. **Requires `Manage Messages`**. Messages older than 14 days cannot be bulk-deleted (Discord API limit).
```
$ricky purge 10
```

---

## 🛡️ Moderation

All moderation commands require the appropriate Discord permission.

### `$ricky kick @user [reason]`
**Requires `Kick Members`**.
```
$ricky kick @baduser repeated spamming
```

### `$ricky ban @user [reason]`
**Requires `Ban Members`**.
```
$ricky ban @scammer phishing links
```

### `$ricky mute @user [duration] [reason]`
**Requires `Manage Roles`**. Duration is optional — omit for permanent.

**Duration format:** any combination of units up to 3 months max.

| Unit | Aliases |
|------|---------|
| Months | `mo` `month` `months` |
| Weeks | `w` `week` `weeks` |
| Days | `d` `day` `days` |
| Hours | `h` `hour` `hours` |
| Minutes | `m` `min` `minute` `minutes` |
| Seconds | `s` `second` `seconds` |

Examples:
```
$ricky mute @user 30m harassment
$ricky mute @user 1h 30m flooding
$ricky mute @user 2d
$ricky mute @user 3mo serious offence
$ricky mute @user spam        # permanent (no duration)
```

The `Muted` role is auto-created per server with `SendMessages` and `AddReactions` denied across all text/voice/stage channels.

### `$ricky unmute @user`
**Requires `Manage Roles`**.

### `$ricky mutes`
**Requires `Manage Roles`**. Lists every currently muted member with reason, who muted them, and time remaining.

---

## 🎮 Graal Online Era event system

### `$ricky dc`
Countdown to the next **Double Coins** event (or shows it's currently active). DC events run from 2h after notification until 3h after notification, with a 5h interval between cycles.

### `$ricky pvp`
Countdown to the next **AntiMatter PvP Arena** event. PvP runs for 30 minutes immediately on notification, with a 5h interval between cycles.

### `$ricky subscribe <event>`
**Requires `Manage Channels`**. Subscribe the current channel to receive event broadcasts.

Events: `doublecoins` / `dc`, `pvp` / `pvp_normal`, `plasma` / `plasma_event`, or `all` for everything.

```
$ricky subscribe all
$ricky subscribe pvp
```

### `$ricky unsubscribe <event>`
Same arguments as `subscribe`. Removing the last subscription from a channel deletes the channel record completely.

### `$ricky subscriptions`
Show which events the current channel is subscribed to.

---

## 🔧 Owner-only (for OWNER_ID in .env)

### `$ricky helpricky`
Show the admin/setup command list (visible only to the owner).

### `$ricky logs [mod|cmd]`
View the last 15 log entries.

- No filter — both moderation actions and command usage
- `mod` — moderation actions only (mute, kick, ban, automod, …)
- `cmd` — command invocations only

---

## 🔗 LinkGuard / AutoMod (admin-level)

**Requires `Manage Server`**. Per-server configuration.

### `$ricky linkguard on`
Enable the scam/phishing/NSFW link scanner.

### `$ricky linkguard off`
Disable.

### `$ricky linkguard logchannel #channel`
Set the channel where AutoMod alerts and audit logs are posted.

### `$ricky linkguard modchannel #channel`
Set the **mod action channel** — posts a panel with Unmute/Ban buttons on every auto-mute. Unmuting from this panel grants the user **2 hours of immunity** (the bot will detect violations but not act on them).

### `$ricky linkguard muteduration <time|off>`
Configure how long auto-mutes last. Same duration format as `$ricky mute`. Use `off` for permanent.

### `$ricky linkguard status`
Show current AutoMod config: enabled, log channel, mod channel, mute duration.

---

## HTTP API

All `POST` endpoints require `Authorization: Bearer <ALERT_API_TOKEN>` if the env var is set.

### `GET /health`
Uptime + monitored channel + import flag.

### `GET /events?limit=N&since=ISO`
Recent events with optional pagination and date filter.

### `GET /events/latest`
The most recent event (or `null`).

### `POST /alerts/doublecoins`
Body: `{ "content": "optional preamble text" }`. Broadcasts to main channel + all subscribed channels.

### `POST /alerts/pvp-normal`
No body required.

### `POST /alerts/plasma-event`
No body required.

### `POST /messages/send`
Body: `{ "text": "plain message" }`. Sends to `ID_CANAL_DESTINO`.
