# Runbook

## Deployment

### As Claude Code Plugin (Primary)

1. Ensure the plugin is registered in the marketplace:
   ```
   /plugin marketplace add barthazian/codex-orchestrator
   /plugin install codex-orchestrator
   ```

2. Restart Claude Code to load the plugin

3. Run the installer to set up dependencies:
   ```
   /codex-orchestrator init
   ```
   Or manually: `bash plugins/codex-orchestrator/scripts/install.sh`

4. Verify: `codex-agent health`

### Manual / CLI-Only

```bash
git clone https://github.com/barthazian/codex-orchestrator.git ~/.codex-orchestrator
cd ~/.codex-orchestrator && bun install
export PATH="$HOME/.codex-orchestrator/bin:$PATH"
codex --login
codex-agent health
```

### Build for Distribution

```bash
bun run build
# Output: dist/cli.js (Node.js compatible)
```

## Monitoring

### Check Agent Status

```bash
# All jobs with structured metadata
codex-agent jobs --json

# Specific job status
codex-agent status <jobId>

# Live event stream
codex-agent events <jobId>

# Watch output in real-time
codex-agent watch <jobId>
```

### SQLite State (Project-Level)

When used via the SKILL.md orchestration protocol, agents coordinate through `.codex/state.db`:

```bash
# Mission status
sqlite3 -header -column .codex/state.db "SELECT stage, mission, progress FROM mission WHERE id=1;"

# Agent status
sqlite3 -header -column .codex/state.db "SELECT id, task, status, summary FROM agents;"

# Recent events
sqlite3 -header -column .codex/state.db "SELECT timestamp, source, message FROM events ORDER BY id DESC LIMIT 10;"

# Active file locks
sqlite3 -header -column .codex/state.db "SELECT file_path, agent_id FROM file_locks;"

# Progress checkpoints
sqlite3 -header -column .codex/state.db "SELECT agent_id, timestamp, message FROM checkpoints ORDER BY id DESC LIMIT 20;"
```

## Common Issues

### "codex CLI not found"

**Cause:** Codex CLI not installed or not in PATH.

**Fix:**
```bash
npm install -g @openai/codex
codex --version  # verify
```

### "codex-agent: command not found"

**Cause:** Shell wrapper not in PATH.

**Fix:**
```bash
export PATH="$HOME/.codex-orchestrator/bin:$PATH"
# Add to ~/.bashrc or ~/.zshrc for persistence
```

### Agent stuck / no output

**Cause:** Process may have silently exited, or JSONL buffering delay.

**Diagnose:**
```bash
codex-agent status <jobId>   # Check PID and status
codex-agent events <jobId>   # Check for events
```

**Fix:**
- If status shows "running" but PID is dead: `codex-agent kill <jobId>` then retry
- If no events after 5+ minutes: check stderr output in `~/.codex-agent/jobs/<jobId>.stderr`

### Agent timed out

**Cause:** No JSONL activity for 60 minutes (configurable in `src/config.ts`).

**Fix:** The job is auto-marked as failed. Retry with a simpler prompt or higher reasoning effort:
```bash
codex-agent start "simplified prompt" -r xhigh --map
```

### Multiple agents conflicting on files

**Cause:** Two agents modifying the same file simultaneously.

**Diagnose:**
```bash
sqlite3 -header -column .codex/state.db "SELECT file_path, agent_id FROM file_locks;"
```

**Fix:** The SKILL.md protocol uses `file_locks` table to prevent this. If locks are stale (agent crashed without releasing):
```bash
sqlite3 .codex/state.db "DELETE FROM file_locks WHERE agent_id='<crashed-agent-id>';"
```

### "windows sandbox: not enough space on disk"

**Cause:** Codex sandbox ran out of disk space during execution.

**Fix:**
- Clean old jobs: `codex-agent clean`
- Free disk space on the system
- Retry the agent

### OpenAI authentication expired

**Cause:** Codex CLI token expired.

**Fix:**
```bash
codex --login
```

### Post-compaction recovery (Claude context compressed)

After Claude's context compacts mid-orchestration, recover state from SQLite:

```bash
sqlite3 -header -column .codex/state.db "SELECT * FROM mission;"
sqlite3 -header -column .codex/state.db "SELECT * FROM agents;"
sqlite3 -header -column .codex/state.db "SELECT * FROM events WHERE source='claude' ORDER BY id;"
sqlite3 -header -column .codex/state.db "SELECT file_path, agent_id FROM file_locks;"
sqlite3 -header -column .codex/state.db "SELECT agent_id, timestamp, message FROM checkpoints ORDER BY id DESC LIMIT 20;"
codex-agent jobs --json
```

Resume orchestration from the database state.

## Rollback

### Undo agent file changes

If an agent made bad changes to your project:

```bash
# See what the agent modified
sqlite3 .codex/state.db "SELECT files_modified FROM agents WHERE id='<agent-id>';"

# Revert with git
git checkout -- <file1> <file2>

# Or revert all uncommitted changes
git checkout .
```

### Revert plugin to previous version

```bash
cd ~/.codex-orchestrator
git log --oneline -5          # Find the commit to revert to
git checkout <commit-hash>    # Revert
```

Restart Claude Code after reverting.

### Clean all state

```bash
# Remove all job data
rm -rf ~/.codex-agent/jobs/*

# Remove project-level orchestration state
rm -rf .codex/

# Rebuild from scratch
codex-agent health
```

## Job Storage

All job data is in `~/.codex-agent/jobs/`:

```
<jobId>.json    # Job metadata (status, model, timestamps)
<jobId>.prompt  # Original prompt text
<jobId>.jsonl   # JSONL event stream from codex exec
<jobId>.stderr  # Stderr output
<jobId>.pid     # Process ID file
```

Auto-cleanup: `codex-agent clean` removes jobs older than 7 days.
