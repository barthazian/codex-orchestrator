# Contributing

## Development Setup

### Prerequisites

| Dependency | Version | Install |
|-----------|---------|---------|
| [Bun](https://bun.sh) | latest | `curl -fsSL https://bun.sh/install \| bash` |
| [OpenAI Codex CLI](https://github.com/openai/codex) | latest | `npm install -g @openai/codex` |
| sqlite3 | any | Pre-installed on macOS/Linux; `winget install sqlite` on Windows. Only needed for the SKILL.md orchestration protocol, not the CLI itself. |

### Clone and Install

```bash
git clone https://github.com/barthazian/codex-orchestrator.git ~/.codex-orchestrator
cd ~/.codex-orchestrator
bun install
```

### Authenticate with OpenAI

```bash
codex --login
```

### Add CLI to PATH

```bash
export PATH="$HOME/.codex-orchestrator/bin:$PATH"
```

Add this line to `~/.bashrc` or `~/.zshrc` for persistence.

## Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `bun build src/cli.ts --outdir dist --target node` | Build CLI to `dist/` for Node.js distribution |

Run with: `bun run build`

## Project Structure

```
src/
  cli.ts       # CLI entry point, command routing, argument parsing
  config.ts    # Configuration constants (model, timeouts, paths)
  exec.ts      # codex exec --json process spawning, JSONL parsing
  files.ts     # File loading, glob matching, token estimation
  jobs.ts      # Job lifecycle, persistence, status tracking
bin/
  codex-agent  # Shell wrapper (invokes cli.ts via Bun)
plugins/
  codex-orchestrator/  # Claude Code plugin package
    skills/            # SKILL.md (orchestration protocol)
    commands/          # Command trigger definitions
    scripts/           # Cross-platform installer
```

## Development Workflow

1. Edit TypeScript source in `src/`
2. Test directly with `bun run src/cli.ts <command>`
3. Or use the shell wrapper: `./bin/codex-agent <command>`
4. Verify with `codex-agent health`

No build step needed for development — Bun runs TypeScript natively.

## Environment Variables

No `.env` file required. Configuration is in `src/config.ts`:

| Setting | Default | Description |
|---------|---------|-------------|
| `model` | `gpt-5.3-codex` | Default Codex model |
| `defaultReasoningEffort` | `xhigh` | Default reasoning depth |
| `defaultSandbox` | `workspace-write` | Default file access level |
| `jobsDir` | `~/.codex-agent/jobs` | Job storage directory |
| `defaultTimeout` | `60` (minutes) | Inactivity timeout for running jobs |
| `jobsListLimit` | `20` | Default job listing limit |

OpenAI authentication is handled via `codex --login` (stored by the Codex CLI, not this project).

## Testing

No test suite currently exists. To verify functionality:

```bash
# Health check
codex-agent health

# Dry run (no API call)
codex-agent start "test prompt" --dry-run

# Start a real agent
codex-agent start "List files in the current directory"

# Monitor
codex-agent jobs --json
codex-agent events <jobId>
```

## Code Conventions

- TypeScript with Bun runtime (not Node.js)
- No classes — functional style with exported functions
- Errors propagated, not swallowed (catch blocks return null only for expected "file not found" cases)
- Cross-platform: macOS, Linux, Windows (MINGW/Git Bash)
- JSONL as the event stream format from `codex exec --json`

## Plugin Development

The `plugins/codex-orchestrator/` directory is the Claude Code plugin package:

- `SKILL.md` is the core orchestration protocol — changes here affect how Claude uses the tool
- `commands/codex-orchestrator.md` defines trigger phrases
- `scripts/install.sh` is the cross-platform dependency installer
- Test plugin changes by restarting Claude Code after modification
