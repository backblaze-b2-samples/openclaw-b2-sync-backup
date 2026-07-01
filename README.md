# OpenClaw B2 Backup

> Automatic encrypted backup and sync of [OpenClaw](https://github.com/openclaw/openclaw) state to [Backblaze B2](https://www.backblaze.com/cloud-storage?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=openclaw). Install the plugin, set your B2 S3 settings, restart your gateway — backups happen automatically.

## What Is OpenClaw B2 Backup?

OpenClaw B2 Backup is a plugin that snapshots your entire OpenClaw state directory to Backblaze B2 on a schedule. It uses incremental SHA-256 diffing and AES-256-GCM encryption so only changed files are uploaded and everything is encrypted at rest. It runs inside the gateway process, uses SQLite's `.backup()` API for consistent database snapshots, and pushes incremental encrypted diffs to B2.

If you've used OpenClaw for more than a week, you've probably hit one of these:

- **Rebuilt from scratch** after a broken config or busted channel integration, losing sessions and memory in the process
- **Lost agent memory** after compaction fired and your agent forgot everything you taught it
- **Accidentally deleted MEMORY.md** (or had your agent do it) with no way to get it back
- **Wanted to move to a new machine** but couldn't figure out what to copy
- **Worried about compromise** from a bad skill and wanted a known-good restore point

This plugin fixes all of that. It snapshots your entire OpenClaw state — config, workspace, sessions, memory, cron, hooks — and stores encrypted, timestamped copies in B2. **Backup** happens automatically on schedule, before compaction, and on shutdown. **Sync** to a new machine is automatic on first start. **Rollback** is one agent command from chat. No scripts, no manual tarball management, no stopping the gateway.


### Who Should Use This

Anyone running OpenClaw who wants automatic off-machine backups without managing scripts, cron jobs, or external tools like restic/rclone.

## Key Features

- **Encrypted by default** — AES-256-GCM with per-file random salt/IV, key derived from your B2 application key via scrypt
- **Incremental sync** — SHA-256 manifest diffing; only changed files are uploaded
- **Safe SQLite snapshots** — uses `.backup()` API, no half-written databases
- **Auto-restore on new machines** — detects empty state dir on start, pulls latest snapshot automatically
- **Safety snapshots before rollback** — creates a restore point before any pull, stored out-of-band and never auto-pruned
- **Compaction protection** — triggers a push before compaction fires (5-minute debounce to prevent rapid-fire)
- **Conversational rollback** — `b2_rollback` agent tool lets you list and restore snapshots from chat
- **Zero runtime dependencies** — hand-rolled S3 Sig V4 client, uses only `node:crypto` and OpenClaw's bundled `croner`
- **Backward-compatible decryption** — auto-detects unencrypted data and passes through, so enabling encryption doesn't break old snapshots

## Quick Start

### 1. Install

```bash
openclaw plugins install openclaw-b2-backup
```

### 2. Configure

Open `~/.openclaw/openclaw.json` and add a `config` block to the `openclaw-b2-backup` entry the installer created:

```json
"openclaw-b2-backup": {
  "enabled": true,
  "config": {
    "keyId": "004a...",
    "applicationKey": "K004...",
    "bucket": "my-openclaw-backups",
    "region": "your-b2-region"
  }
}
```

You can also configure these fields in the Control UI under plugin settings.

### 3. Restart

```bash
openclaw gateway restart
```

That's it. The plugin uses Backblaze B2's S3-compatible API, encryption is on by default, and the first backup runs at midnight.

Need a snapshot immediately before a risky change? Run the standalone push command:

```bash
openclaw-b2-backup-push
```

The command reads `~/.openclaw/openclaw.json` by default and uses the same push implementation as the gateway hooks. It is independent of the running gateway, so it also works when the daemon is stopped.

## Configuration

Runtime requires the B2 key ID, application key, bucket, and region. They can come from plugin config or the standardized environment variables below. Existing three-field plugin configs still load, but backups pause with a clear warning until `region` or `B2_REGION` is added.

| Setting | Type | Default | Required | Description |
|---------|------|---------|----------|-------------|
| `keyId` | string | — | Yes | B2 application key ID |
| `applicationKey` | string | — | Yes | B2 application key (also used as encryption key source) |
| `bucket` | string | — | Yes | B2 bucket name |
| `region` | string | — | Yes | B2 region used for S3 request signing |
| `endpoint` | string | Derived from `region` | No | B2 S3-compatible endpoint |
| `prefix` | string | `"openclaw-backup"` | No | Object key prefix in the bucket |
| `schedule` | string | `"daily"` | No | `"daily"`, `"weekly"`, or a cron expression |
| `encrypt` | boolean | `true` | No | AES-256-GCM encryption before upload |
| `keepSnapshots` | number | `10` | No | Snapshots retained; oldest auto-pruned |
| `keepSafetySnapshots` | number | Same as `keepSnapshots` | No | Safety snapshots retained; oldest safety prefixes auto-pruned separately |

For environment-based deployments, use the standardized names shown in `.env.example`:

```bash
B2_ENDPOINT=https://s3.your-b2-region.backblazeb2.com
B2_REGION=your-b2-region
B2_APPLICATION_KEY_ID=your_key_id
B2_APPLICATION_KEY=your_application_key
B2_BUCKET_NAME=your-bucket-name
```

### Region migration

Native B2 authorize-based region discovery was removed so the runtime uses only the S3-compatible API for B2 storage operations. Existing configs that only include `keyId`, `applicationKey`, and `bucket` should add `region`; library callers of `createB2Client` should pass the region explicitly. Omitting region is still accepted at the type boundary for compatibility, but it fails fast before any network request.

## Manual Push CLI

`openclaw-b2-backup-push` forces an immediate snapshot without waiting for cron, shutdown, or compaction hooks:

```bash
openclaw-b2-backup-push
openclaw-b2-backup-push --dry-run
openclaw-b2-backup-push --config /path/to/openclaw.json --json
```

The config path defaults to `~/.openclaw/openclaw.json`. Override it with `--config`, `OPENCLAW_CONFIG`, or `OPENCLAW_CONFIG_PATH`. `OPENCLAW_STATE_DIR` is honored when set; otherwise the state directory is resolved from the config location.

Exit codes:

| Code | Meaning |
|------|---------|
| `0` | Push or dry-run succeeded |
| `1` | B2 auth/check/upload failed |
| `64` | CLI usage error |
| `65` | Config file or plugin config is malformed |

Options:

| Option | Behavior |
|--------|----------|
| `--dry-run` | Auth-checks bucket access with no upload |
| `--json` | Emits machine-readable JSON |
| `--quiet` | Suppresses human-readable success and progress output; failures still print one stderr diagnostic |

JSON output is a stable CLI contract:

```json
{"ok":true,"mode":"push","configPath":"/home/me/.openclaw/openclaw.json","stateDir":"/home/me/.openclaw","bucket":"my-openclaw-backups","prefix":"openclaw-backup"}
```

`mode` is `push` or `dry-run`. Failure output uses:

```json
{"ok":false,"code":"push_failure","error":"upload failed"}
```

`code` is `usage`, `config_malformed`, or `push_failure`.

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

With this plugin, a snapshot is automatically taken *before* compaction fires. Roll back from chat:

> "Show me my B2 backup snapshots and restore the one from before compaction"

### You (or your agent) deleted MEMORY.md

OpenClaw memory is plain Markdown files on disk. A single misinterpreted instruction can permanently delete them. With daily snapshots in B2, you restore MEMORY.md from the last known-good version.

### Config got corrupted or you broke a channel integration

One bad edit and you're rebuilding from scratch — re-onboarding channels, re-pairing devices, re-teaching your agent. With this plugin, you restore the entire state directory from a snapshot instead.

### You suspect a malicious skill compromised your setup

Restore from a pre-compromise snapshot, rotate your secrets, and you're back to a known-good state. The timestamped snapshots in B2 give you a clear timeline of what your state looked like before and after the incident.

### Moving to a new machine

```bash
openclaw plugins install openclaw-b2-backup
# Add your B2 config (keyId, applicationKey, bucket, region) to the openclaw-b2-backup entry in openclaw.json
openclaw gateway restart
# Plugin detects empty state + existing snapshots → auto-restores latest
```

Your new machine has the same memory, sessions, config, and personality as the old one. No manual file copying.

## How It Works

### Sync Triggers

| Trigger | When | Behavior |
|---------|------|----------|
| Cron schedule | Midnight daily (default) | Full incremental push |
| `gateway_stop` | Gateway shutdown | Final push before exit |
| `before_compaction` | Before session compaction | Push with 5-min debounce to prevent rapid-fire |
| `openclaw-b2-backup-push` | Manual operator command | Immediate push from outside the gateway process |
| Auto-restore | Service start, empty state dir | Pull latest snapshot (no safety snapshot created) |

### Push (your machine -> B2)

Each sync creates a timestamped snapshot (e.g., `openclaw-backup/2026-02-19T00-00-00Z/`):

1. Walk the state directory, collect files matching include patterns
2. Create safe SQLite snapshots via `.backup()` API (no half-written databases)
3. Compute SHA-256 hashes on **plaintext**, diff against last push
4. Encrypt changed files with AES-256-GCM (if enabled)
5. Upload changed files + unencrypted manifest
6. Prune old snapshots beyond `keepSnapshots` and safety snapshots beyond `keepSafetySnapshots`

Manifest hashes are always computed on plaintext so incremental diffing works regardless of encryption (random IV/salt means identical plaintext produces different ciphertext).

Unlike external backup tools (Restic, rclone), this plugin runs *inside* the gateway process and doesn't require stopping the gateway.

### Pull (B2 -> your machine)

1. Push a **safety snapshot** to `{prefix}/safety-{timestamp}/` (preserves current state before overwriting)
2. Fetch manifest from the selected snapshot
3. Compare local files by SHA-256 hash
4. Download + decrypt (if encrypted) only changed/missing files
5. Verify hashes against plaintext before writing

Safety snapshots are stored out-of-band from regular snapshots and pruned only by their own `keepSafetySnapshots` retention setting. Cleanup deletes whole `safety-*` prefixes, including failed or partial safety uploads.

## Agent Tool

The plugin registers a `b2_rollback` tool that lets you manage backups conversationally:

**List snapshots:**
> "Show me my B2 backup snapshots"

Returns all regular snapshots and safety snapshots with timestamps.

**Restore a snapshot:**
> "Roll back to the snapshot from February 15th"

Creates a safety snapshot of current state, then restores the selected snapshot.

The tool is registered as optional so it only appears when the agent needs it.

## Architecture

Zero external dependencies beyond what OpenClaw already ships:

| Need | Solution |
|------|----------|
| S3 API calls | Hand-rolled Sig V4 signing against the B2 S3-compatible API (`node:crypto`) |
| Encryption | AES-256-GCM, scrypt key derivation from `applicationKey` |
| Scheduling | `croner` (already in OpenClaw core) |
| SQLite snapshots | `node:sqlite` `.backup()` API (Node 22+) |
| Push debounce | Shared timer prevents rapid-fire from overlapping triggers |
| JSON persistence | `readJsonFileWithFallback` / `writeJsonFileAtomically` from plugin SDK |

```
src/
  types.ts            # Config + manifest types, SAFETY_PREFIX
  b2-client.ts        # S3-compatible B2 client with Sig V4 signing
  gatherer.ts         # Walk state dir, collect syncable files
  sqlite-snapshot.ts  # Safe .backup() wrapper
  manifest.ts         # SHA-256 hashing + diff logic
  encryption.ts       # AES-256-GCM encrypt/decrypt/isEncrypted
  config.ts           # Shared B2 config normalization
  cli.ts              # Standalone manual push command
  debounce.ts         # Push rate limiter
  snapshots.ts        # List, prune, filter snapshots in B2
  push.ts             # Upload changed files to B2 (with PushOptions)
  pull.ts             # Download + restore from B2 (with PullOptions)
  service.ts          # Background scheduler + auto-restore
index.ts              # Plugin entry: hooks, tool registration, debounce wiring
openclaw.plugin.json  # Plugin manifest
```

## Storage

Backblaze B2 includes [10 GB of free storage](https://www.backblaze.com/cloud-storage/pricing?utm_source=github&utm_medium=referral&utm_campaign=ai_artifacts&utm_content=openclaw) — more than enough for most OpenClaw setups. Typical state is 50-500 MB, so even with 10 encrypted snapshots retained you'll comfortably stay within the free tier.

## Security

- **Encryption at rest** — all file data is AES-256-GCM encrypted before leaving your machine (manifests stay unencrypted as they contain only paths and hashes)
- **Per-file random salt/IV** — identical files produce different ciphertext
- **Key derivation** — encryption key is derived from your `applicationKey` via scrypt (never stored separately)
- **Credentials** and **auth profiles** are excluded from sync by design
- Use B2 application keys scoped to a single bucket for least-privilege access

## Development

### Local install (from the monorepo)

```bash
openclaw plugins install -l ./extensions/b2-backup
openclaw plugins list  # should show openclaw-b2-backup
```

### Run tests

```bash
pnpm test
```

130 tests across 11 test files covering encryption round-trips, manifest diffing, snapshot filtering, file gathering, B2 client signing, debounce timing, CLI behavior, push coordination, and plugin registration.

## License

MIT
