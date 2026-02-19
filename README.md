# OpenClaw B2 Sync Backup

Automatic backup and sync of [OpenClaw](https://github.com/openclaw/openclaw) state to [Backblaze B2](https://www.backblaze.com/cloud-storage). Install the plugin, set 3 fields, restart your gateway — backups happen automatically.

## Why

If you've used OpenClaw for more than a week, you've probably hit one of these:

- **Rebuilt from scratch** after a broken config or busted channel integration, losing sessions and memory in the process
- **Lost agent memory** after compaction fired and your agent forgot everything you taught it
- **Accidentally deleted MEMORY.md** (or had your agent do it) with no way to get it back
- **Wanted to move to a new machine** but couldn't figure out what to copy
- **Worried about compromise** from a bad skill and wanted a known-good restore point

This plugin fixes all of that. It snapshots your entire OpenClaw state — config, workspace, sessions, memory, cron, hooks — and stores timestamped copies in B2. Restore is one pull. No scripts, no manual tarball management, no stopping the gateway.

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

Everything that makes your OpenClaw instance *yours*:

| Data | Path | Why |
|------|------|-----|
| Config | `openclaw.json` (+`.bak` rotation) | Your setup — channels, models, agent bindings |
| Workspace | `workspace/**`, `workspace-*/**` | SOUL.md, AGENTS.md, MEMORY.md, custom instructions |
| Sessions | `agents/*/sessions/*.jsonl` | Conversation history |
| Session store | `agents/*/sessions/sessions.json` | Routing metadata |
| Memory DB | `agents/*/memory/*.sqlite` | Long-term knowledge (vector search index) |
| Agent state | `agents/*/agent/**` | Agent runtime config (minus auth profiles) |
| Cron jobs | `cron/**` | Scheduled tasks |
| Hooks | `hooks/**` | Custom hook scripts |

### Not Synced (by design)

- **`credentials/`** and **`auth-profiles.json`** — secrets stay per-machine; re-auth on new machines
- **`media/`** — ephemeral (2-min TTL), not worth syncing
- **`extensions/`** — install plugins independently per machine
- **`*.lock`**, **`*.tmp`**, **`*-wal`**, **`*-shm`** — transient files

## Common Scenarios

### Your agent forgot everything after compaction

Compaction rewrites your session transcript to save context window space. If important context lived only in the chat history and wasn't captured in MEMORY.md or the memory DB, it's gone.

With this plugin, you can roll back to the snapshot taken before compaction fired and recover the full session transcript.

### You (or your agent) deleted MEMORY.md

OpenClaw memory is plain Markdown files on disk. A single misinterpreted instruction can permanently delete them. With daily snapshots in B2, you restore MEMORY.md from the last known-good version.

### Config got corrupted or you broke a channel integration

OpenClaw config is described by users as "really brittle." One bad edit and you're rebuilding from scratch — re-onboarding channels, re-pairing devices, re-teaching your agent. With this plugin, you restore the entire state directory from a snapshot instead.

### You suspect a malicious skill compromised your setup

Restore from a pre-compromise snapshot, rotate your secrets, and you're back to a known-good state. The timestamped snapshots in B2 give you a clear timeline of what your state looked like before and after the incident.

### Moving to a new machine

```bash
openclaw plugins install @openclaw/b2-backup
# Add the same 3 config fields to openclaw.json
openclaw gateway restart
# Plugin detects existing snapshots in bucket and pulls the latest
```

Your new machine has the same memory, sessions, config, and personality as the old one.

## How Sync Works

### Push (your machine -> B2)

Each sync creates a timestamped snapshot (e.g., `openclaw-backup/2026-02-19T00-00-00Z/`):

1. Walk the state directory, collect files matching include patterns
2. Create safe SQLite snapshots via `.backup()` API (no half-written databases)
3. Compute SHA-256 hashes, diff against last push
4. Upload only changed/new files (incremental)
5. Upload `manifest.json` with file list and hashes
6. Prune old snapshots beyond `keepSnapshots` limit

Unlike external backup tools (Restic, rclone), this plugin runs *inside* the gateway process. It uses SQLite's `.backup()` API for consistent database snapshots and doesn't require stopping the gateway.

### Pull (B2 -> your machine)

Download and restore from a snapshot:

1. Fetch the manifest from the selected snapshot
2. Compare against local files by SHA-256 hash
3. Download only files that differ or are missing
4. Verify hashes before writing

## Advanced Config

All optional — defaults work for most setups:

| Setting | Default | Description |
|---------|---------|-------------|
| `region` | Auto-detected | B2 region (derived from your key) |
| `prefix` | `"openclaw-backup"` | Object key prefix in the bucket |
| `schedule` | `"daily"` | `daily`, `weekly`, or a cron expression |
| `encrypt` | `true` | AES-256-GCM encryption before upload (Phase 2) |
| `keepSnapshots` | `10` | Number of snapshots retained; oldest auto-pruned |

## Storage

Backblaze B2 includes [10 GB of free storage](https://www.backblaze.com/cloud-storage/pricing) — more than enough for most OpenClaw setups. Typical state is 50-500 MB, so even with 10 snapshots retained you'll comfortably stay within the free tier.

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

## License

MIT
