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
- Completion detected via JSONL events or process exit
- Bun is the TypeScript runtime - never use npm/yarn/pnpm for running
- Cross-platform: macOS, Linux, Windows (MINGW/Git Bash)
