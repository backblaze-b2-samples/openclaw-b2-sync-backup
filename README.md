# OpenClaw B2 Sync Backup

Automatic backup and sync of [OpenClaw](https://github.com/openclaw/openclaw) state to [Backblaze B2](https://www.backblaze.com/cloud-storage). Install the plugin, set 3 fields, restart your gateway — backups happen automatically.

- **Sync across machines** — set up OpenClaw on machine A, point machine B at the same bucket, pull the latest snapshot
- **Rollback** — bad config or corrupted memory? Roll back to a previous snapshot
- **Backup** — your Pi's SD card dies, your VM gets nuked — your OpenClaw state survives in B2

## Setup

### 1. Install

```bash
openclaw plugins install @openclaw/b2-backup
```

### 2. Configure

Add to your `openclaw.json` (or use the Control UI):

```json
{
  "plugins": {
    "entries": {
      "b2-backup": {
        "enabled": true,
        "config": {
          "keyId": "004a...",
          "applicationKey": "K004...",
          "bucket": "my-openclaw-backups"
        }
      }
    }
  }
}
```

### 3. Restart

```bash
openclaw gateway restart
```

That's it. The plugin auto-detects your B2 region, syncs daily at midnight, and triggers a final backup when the gateway shuts down.

## What Gets Synced

| Data | Path | Why |
|------|------|-----|
| Config | `openclaw.json` | Your setup |
| Workspace | `workspace/**` | SOUL.md, AGENTS.md, custom instructions |
| Sessions | `agents/*/sessions/*.jsonl` | Conversation history |
| Session store | `agents/*/sessions/sessions.json` | Routing metadata |
| Memory | `agents/*/memory/*.sqlite` | Long-term knowledge (vector DB) |
| Cron jobs | `cron/**` | Scheduled tasks |
| Hooks | `hooks/**` | Custom hook scripts |

### Not Synced (by design)

- **`credentials/`** and **`auth-profiles.json`** — secrets stay per-machine; re-auth on new machines
- **`media/`** — ephemeral (short TTL), not worth syncing
- **`extensions/`** — install plugins independently per machine
- **`*.lock`**, **`*.tmp`**, **`*-wal`**, **`*-shm`** — transient files

## How Sync Works

### Push (your machine -> B2)

Each sync creates a timestamped snapshot (e.g., `openclaw-backup/2026-02-19T00-00-00Z/`):

1. Walk the state directory, collect files matching include patterns
2. Create safe SQLite snapshots via `.backup()` API (no half-written databases)
3. Compute SHA-256 hashes, diff against last push
4. Upload only changed/new files (incremental)
5. Upload `manifest.json` with file list and hashes
6. Prune old snapshots beyond `keepSnapshots` limit

### Pull (B2 -> your machine)

Download and restore from a snapshot:

1. Fetch the manifest from the selected snapshot
2. Compare against local files by SHA-256 hash
3. Download only files that differ or are missing
4. Verify hashes before writing

## Restoring on a New Machine

```bash
openclaw plugins install @openclaw/b2-backup
# Add the same 3 config fields to openclaw.json
openclaw gateway restart
# Plugin detects existing snapshots in bucket and pulls the latest
```

## Advanced Config

All optional — defaults work for most setups:

| Setting | Default | Description |
|---------|---------|-------------|
| `region` | Auto-detected | B2 region (derived from your key) |
| `prefix` | `"openclaw-backup"` | Object key prefix in the bucket |
| `schedule` | `"daily"` | `daily`, `weekly`, or a cron expression |
| `encrypt` | `true` | AES-256-GCM encryption before upload (Phase 2) |
| `keepSnapshots` | `10` | Number of snapshots retained; oldest auto-pruned |

## Cost

Typical OpenClaw state is 50-500 MB. B2 pricing: [$6/TB/month storage](https://www.backblaze.com/cloud-storage/pricing), free uploads, 2,500 free downloads/day.

| State Size | 10 Snapshots | Monthly Cost |
|-----------|-------------|-------------|
| 50 MB | ~500 MB | < $0.01 |
| 200 MB | ~2 GB | ~$0.01 |
| 500 MB | ~5 GB | ~$0.03 |

## Architecture

Zero external dependencies beyond what OpenClaw already ships:

| Need | Solution |
|------|----------|
| S3 API calls | Hand-rolled AWS Sig V4 signing (`node:crypto`) |
| Scheduling | `croner` (already in OpenClaw core) |
| SQLite snapshots | `node:sqlite` `.backup()` API (Node 22+) |
| File locking | `withFileLock` from plugin SDK |
| JSON persistence | `readJsonFileWithFallback` / `writeJsonFileAtomically` from plugin SDK |

```
src/
  types.ts            # Config + manifest types
  b2-client.ts        # S3-compatible B2 client with Sig V4 signing
  gatherer.ts         # Walk state dir, collect syncable files
  sqlite-snapshot.ts  # Safe .backup() wrapper
  manifest.ts         # SHA-256 hashing + diff logic
  snapshots.ts        # List, prune, select snapshots in B2
  push.ts             # Upload changed files to B2
  pull.ts             # Download + restore from B2
  service.ts          # Background scheduler (croner)
index.ts              # Plugin entry point
openclaw.plugin.json  # Plugin manifest
```

## Development

### Local install (from the monorepo)

```bash
openclaw plugins install -l ./extensions/b2-backup
openclaw plugins list  # should show b2-backup
```

### Run tests

```bash
pnpm test
```

### Keeping in sync with the monorepo

This repo mirrors `extensions/b2-backup/` in the [openclaw monorepo](https://github.com/openclaw/openclaw). A sync script keeps both copies aligned:

```bash
# Pull latest from the monorepo extension into this repo
./scripts/sync.sh pull

# Push changes from this repo back to the monorepo extension
./scripts/sync.sh push
```

## Roadmap

### Phase 1 (current)
- Plugin scaffold + manifest
- B2 client (Sig V4)
- File gathering with include/exclude patterns
- SQLite `.backup()` snapshots
- Incremental push with manifest diffing
- Pull latest / pull by timestamp
- Snapshot listing + auto-prune
- Daily scheduler + `gateway_stop` hook

### Phase 2
- AES-256-GCM encryption
- Gzip compression before upload
- `agent_end` + `before_compaction` triggers with debounce
- Session store merge on pull (don't lose local-only sessions)
- Safety snapshot before rollback
- First-pull auto-restore (detect empty state + existing snapshots)
- Agent tool for conversational rollback ("roll back to yesterday")

### Phase 3
- `openclaw doctor` integration
- Diagnostic events on sync failure
- B2 Event Notifications for integrity verification
- Docs page at docs.openclaw.ai

## License

MIT
