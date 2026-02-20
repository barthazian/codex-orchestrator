# Codex Orchestrator

CLI tool for delegating tasks to GPT Codex agents via `codex exec --json`. Designed for Claude Code orchestration.

**Stack**: TypeScript, Bun, OpenAI Codex CLI

**Structure**: Shell wrapper -> CLI entry point -> Job management -> codex exec --json processes

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).

## Development

```bash
# Run directly
bun run src/cli.ts --help

# Or via shell wrapper
./bin/codex-agent --help

# Health check
bun run src/cli.ts health
```

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI commands and argument parsing |
| `src/jobs.ts` | Job lifecycle and persistence |
| `src/exec.ts` | codex exec --json process management |
| `src/config.ts` | Configuration constants |
| `src/files.ts` | File loading for context injection |
| `plugins/` | Claude Code plugin (marketplace structure) |

## Plugin Structure

This repo doubles as a Claude Code plugin marketplace:

```
.claude-plugin/marketplace.json     # marketplace registry
plugins/codex-orchestrator/         # the plugin
  .claude-plugin/plugin.json        # plugin metadata
  skills/codex-orchestrator/        # the orchestration skill
    SKILL.md                        # skill instructions
  scripts/install.sh                # dependency installer
```

## Dependencies

- **Runtime**: Bun, codex CLI
- **NPM**: glob (file matching)

## Notes

- Jobs stored in `~/.codex-agent/jobs/`
- Each agent runs as a detached `codex exec --json` process
- JSONL output captured to `<jobId>.jsonl` for event parsing
- Completion detected via JSONL `turn.completed` event (NOT `task.completed` — that doesn't exist in the Codex CLI protocol)
- Bun is the TypeScript runtime - never use npm/yarn/pnpm for running
- Cross-platform: macOS, Linux, Windows (MINGW/Git Bash)

## Codex CLI Event Protocol

- Terminal event: `thread.started → turn.started → item.started/item.completed (×N) → turn.completed`
- `task.completed`/`response.completed` do NOT exist — `turn.completed` is the terminal success event
- File changes: `item.completed` with `item.type === "file_change"`, paths in `item.changes[].path`
- Token usage: inside `turn.completed` event's `usage` field
- Session ID: `thread_id` field in `thread.started` event

## Windows/MINGW Gotchas

- **PID namespace mismatch**: Bash `$!` returns MINGW PIDs. Bun's `process.kill(pid, 0)` checks Windows native PIDs. They are DIFFERENT namespaces. Use `bash kill -0 <pid>` for process detection, not `process.kill()`.
- **Codex CLI requires git repo**: `codex exec` fails with "Not inside a trusted directory" unless the target dir has `git init` or `--skip-git-repo-check` is passed.
- **PowerShell execution policy**: Agents using `npx` may fail because `npx.ps1` is blocked. Prefer `bunx` or direct `bun run`.
- **bunx tempdir access**: `bunx` may fail with `AccessDenied` on Windows temp directories.

## Key Files (Controller)

| File | Purpose |
|------|---------|
| `src/controller/stateStore.ts` | SQLite state management via `bun:sqlite` for multi-agent coordination |
