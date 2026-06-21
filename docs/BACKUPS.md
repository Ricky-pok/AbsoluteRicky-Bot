# Database Backups

`bot.db` is backed up automatically to Google Cloud Storage every day at 4 AM UTC.

## Setup

| Component | Where |
|-----------|-------|
| Script | `/usr/local/bin/backup-bot-db.sh` (on the VM, root-owned) |
| Cron job | `/etc/cron.d/bot-backup` |
| Output log | `/var/log/bot-backup.log` |
| Service Account | `bot-backup-sa@soulhunter-bot.iam.gserviceaccount.com` |
| SA key | `/etc/bot-backup/sa.json` (600, root) |
| Bucket | `gs://absolutericky-bot-backups` (Standard, us-central1) |
| Retention | 14 days (script auto-deletes older backups) |
| Naming | `bot.db.YYYYMMDD_HHMMSS.gz` |

## How it works

1. `sqlite3 bot.db ".backup '$BACKUP_FILE'"` — uses SQLite's **online backup API**, atomic and safe while the bot is writing (WAL mode handles this transparently).
2. `gzip` — compresses ~75%.
3. `gcloud storage cp` — uploads to the bucket using the dedicated service account.
4. Sweep — lists all `.gz` files in the bucket, parses the timestamp from the filename, deletes anything older than 14 days.

## Manual backup

```bash
sudo /usr/local/bin/backup-bot-db.sh
```

## List backups

```bash
gcloud storage ls gs://absolutericky-bot-backups/
```

## Restore a specific backup

**Stop the bot first** so writes don't conflict:

```bash
# 1. Stop the bot
sudo -u josenriquefelix pm2 stop bot-receptor-http

# 2. Download the backup you want (replace timestamp)
cd /tmp
gcloud storage cp gs://absolutericky-bot-backups/bot.db.20260620_040000.gz .

# 3. Decompress
gunzip bot.db.20260620_040000.gz

# 4. Backup current DB (in case you need to roll back the restore)
sudo cp /home/josenriquefelix/bot-receptor-http/bot.db \
        /home/josenriquefelix/bot-receptor-http/bot.db.pre-restore-bak

# 5. Replace
sudo cp bot.db.20260620_040000 /home/josenriquefelix/bot-receptor-http/bot.db
sudo chown josenriquefelix:josenriquefelix /home/josenriquefelix/bot-receptor-http/bot.db

# 6. Remove old WAL/SHM (they belong to the old DB)
sudo rm -f /home/josenriquefelix/bot-receptor-http/bot.db-wal
sudo rm -f /home/josenriquefelix/bot-receptor-http/bot.db-shm

# 7. Start the bot
sudo -u josenriquefelix pm2 start bot-receptor-http

# 8. Verify
sudo -u josenriquefelix pm2 logs bot-receptor-http --lines 20 --nostream
```

## Test the latest backup is valid

```bash
# Download latest
gcloud storage cp $(gcloud storage ls gs://absolutericky-bot-backups/ | sort | tail -1) /tmp/test.db.gz
gunzip /tmp/test.db.gz

# Open it and check tables
sqlite3 /tmp/test.db "SELECT
  (SELECT COUNT(*) FROM events) AS events,
  (SELECT COUNT(*) FROM logs) AS logs,
  (SELECT COUNT(*) FROM automod_config) AS automod;"

rm /tmp/test.db
```

## Cost

| Item | Cost |
|------|------|
| Storage (14 × 20KB ≈ 280KB) | ~$0.000006/month |
| Class A ops (~30/month) | ~$0.00015/month |
| Egress (only when restoring) | $0 within GCP |
| **Total** | **< $0.01/month** |

## Troubleshooting

**Backup didn't run last night**

```bash
# Check log
sudo tail -30 /var/log/bot-backup.log

# Check cron is running
sudo systemctl status cron

# Run manually to surface the error
sudo /usr/local/bin/backup-bot-db.sh
```

**Permission denied to bucket**

The service account key may have been rotated or revoked. Regenerate:

```bash
gcloud iam service-accounts keys create /tmp/new-sa.json \
  --iam-account=bot-backup-sa@soulhunter-bot.iam.gserviceaccount.com

# Copy to VM (from laptop)
gcloud compute scp /tmp/new-sa.json instance-20251225-003337:/tmp/new-sa.json --zone=us-central1-c

# On VM
sudo mv /tmp/new-sa.json /etc/bot-backup/sa.json
sudo chmod 600 /etc/bot-backup/sa.json
sudo chown root:root /etc/bot-backup/sa.json
```

**SQLite says "database is locked" during backup**

This shouldn't happen since `.backup` uses the online backup API. If it does:
- Confirm WAL mode is enabled: `sqlite3 bot.db "PRAGMA journal_mode;"` should return `wal`
- Check there isn't a stuck transaction: `sqlite3 bot.db "PRAGMA wal_checkpoint(TRUNCATE);"`
