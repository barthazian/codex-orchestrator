---
name: codex-orchestrator
description: Army model — Claude decomposes tasks and spawns N focused Codex agents directly via codex exec --json. No single-lead bottleneck. Claude manages all coordination via .codex/state.db, makes strategic decisions, and orchestrates dual-model code reviews. Cross-platform (macOS, Linux, Windows). Trigger on ANY task involving code, file modifications, codebase research, multi-step work, or implementation. Only skip if the user explicitly asks you to do something yourself.
triggers:
  - codex-orchestrator
  - spawn codex
  - use codex
  - delegate to codex
  - start agent
  - codex agent
  - init
  - setup codex
---

# Codex Orchestrator

## 1. The Command Structure

```
USER — sets vision and approves strategy
    |
    v
CLAUDE (Opus) — strategy, decomposition, coordination, review orchestration
    |
    ├── Codex agent (task A)   — focused coder
    ├── Codex agent (task B)   — focused coder
    ├── Codex agent (task C)   — focused coder
    └── ...up to 5 concurrent
```

Two roles:

- **User**: Vision, strategic decisions, plan approval.
- **Claude**: Strategy, task decomposition, PRD creation, agent spawning, coordination via `.codex/state.db`, synthesis, dual-model review orchestration.

Claude decomposes tasks and spawns up to 5 focused Codex agents in parallel. Each agent receives a single, self-contained task. Agents are fire-and-forget coders — they execute their task and exit. Claude handles all coordination.

## 2. Critical Rules

### Rule 1: Claude Decomposes, Agents Execute

Claude breaks work into focused, independent tasks and spawns a Codex agent for each. Agents do NOT decompose work further or spawn sub-agents. They just code.

### Rule 2: Claude Is Orchestrator AND Coordinator

**Claude's job:**
- Discuss strategy with user
- Write PRDs and specs
- Decompose tasks into agent-sized work units
- Spawn Codex agents (up to 5 concurrent)
- Initialize and manage `.codex/state.db`
- Register agents in the `agents` table (status `pending`)
- Monitor agent completion via `codex-agent jobs --json` and SQLite queries
- Make course corrections via `events` table
- Synthesize results
- Run dual-model reviews (Stage 6)

**Not Claude's job:**
- Implementing code directly (agents do this)
- Doing extensive file reads for delegation context

**Agent's job:**
- Run ALL Mission Context Header sqlite3 queries FIRST (mission, agents, events, file_locks, checkpoints)
- Transition own status from `pending` to `running` and write `agent_start` event
- Check file_locks — do NOT touch files locked by other agents
- Claim files via file_locks INSERT before modifying them
- Write progress checkpoints during work
- Execute the focused task from Claude
- Write clean code following existing patterns
- Stay within scope — do not modify files outside the task
- On completion: update own agents row (status, files_modified, summary), write completion event, release file locks
- Exit when done — output captured automatically via JSONL

### Rule 3: Claude Subagents for Review

Use Claude subagents (Task tool) during Stage 6 (Review) for dual-model code review. Claude subagents return results in-memory — they do NOT write to disk. All code execution goes to Codex agents.

### Rule 4: Write Ownership Is Strict

See Section 5 for the full ownership table and rules. In summary: Claude owns the `mission` table and agent registration. Agents own their own row updates, file locks, and checkpoints. No writer ever modifies another writer's rows.

## 3. Prerequisites

Before codex-agent can run, three things must be installed:

1. **Bun** — JavaScript runtime (runs the CLI)
2. **sqlite3** — Database CLI (state bus for coordination)
3. **OpenAI Codex CLI** — The coding agent being orchestrated

The user must also be **authenticated with OpenAI** (`codex --login`) so agents can make API calls.

### Quick Check

```bash
codex-agent health    # checks codex is available
```

### If Not Installed

If the user says "init", "setup", or codex-agent is not found, **run the install script**:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"
```

**Always use the install script.** Do NOT manually check dependencies or try to install things yourself step-by-step. The script handles everything: detects the platform, checks each dependency, installs what's missing via official package managers, clones the repo, and adds `codex-agent` to PATH. No sudo required. Cross-platform (macOS, Linux, Windows/MINGW).

If `${CLAUDE_PLUGIN_ROOT}` is not available (manual skill install), the user can run:

```bash
bash ~/.codex-orchestrator/plugins/codex-orchestrator/scripts/install.sh
```

After installation, the user must authenticate with OpenAI if they haven't already:

```bash
codex --login
```

**All dependencies use official sources only.** Bun from bun.sh, Codex CLI from npm. No third-party scripts or unknown URLs.

## 4. The Factory Pipeline

```
USER'S REQUEST
     |
     v
1. IDEATION        (Claude + User)
     |
2. RESEARCH        (Claude spawns N read-only agents)
     |
3. SYNTHESIS       (Claude)
     |
4. PRD             (Claude + User)
     |
5. IMPLEMENTATION  (Claude spawns N workspace-write agents)
     |
6. REVIEW          (DUAL-MODEL: Codex agents + 5 Claude agents + confidence scoring)
     |
7. TESTING         (Claude spawns N workspace-write agents)
```

**Claude** handles all stages directly — decomposing work and spawning agents for stages 2, 5, 6, 7.

### Pipeline Stage Detection

| Signal | Stage | Action |
|--------|-------|--------|
| New feature request, vague problem | IDEATION | Discuss with user, clarify scope |
| "investigate", "research", "understand" | RESEARCH | Spawn read-only Codex agents |
| Agent findings ready, need synthesis | SYNTHESIS | Claude reviews, filters, combines |
| "let's plan", "create PRD", synthesis done | PRD | Claude writes PRD to docs/prds/ |
| PRD exists, "implement", "build" | IMPLEMENTATION | Spawn workspace-write Codex agents |
| Implementation done, "review" | REVIEW | DUAL-MODEL: Codex + Claude review agents |
| "test", "verify", review passed | TESTING | Spawn workspace-write Codex agents |

### Stage 1: Ideation (Claude + User)

Talk through the problem with the user. Understand what they want. Plan how to decompose the work into agent-sized tasks. Even seemingly simple tasks go to Codex agents — you are the orchestrator, not the implementer.

### Stage 2: Research (Claude spawns read-only agents)

Decompose the research into focused questions. Spawn a Codex agent for each question/area with `-s read-only`.

### Stage 3: Synthesis (Claude)

Review agent outputs via `codex-agent jobs --json` and `codex-agent events <id>`. Filter signal from noise:

- Agent suggests splitting a 9k token file — likely good
- Agent suggests adding rate limiting — good, we want quality
- Agent suggests types for code we didn't touch — skip, over-engineering
- Agent contradicts itself — investigate further
- Agent misunderstands the codebase — discount that finding

Write synthesis decision to `events` table in `.codex/state.db`.

### Stage 4: PRD Creation (Claude + User)

For significant changes, create PRD in `docs/prds/`:

```markdown
# [Feature/Fix Name]

## Problem
[What's broken or missing]

## Solution
[High-level approach]

## Requirements
- [Specific requirement 1]
- [Specific requirement 2]

## Implementation Plan
### Phase 1: [Name]
- [ ] Task 1
- [ ] Task 2

### Phase 2: [Name]
- [ ] Task 3

## Files to Modify
- path/to/file.ts — [what changes]

## Testing
- [ ] Unit tests for X
- [ ] Integration test for Y

## Success Criteria
- [How we know it's done]
```

Review PRD with user before implementation.

### Stage 5: Implementation (Claude spawns workspace-write agents)

Decompose the PRD into independent, parallelizable tasks. Spawn a Codex agent for each task. Each agent gets a specific task, relevant file paths, and the working directory.

**Artifact Gate (before advancing to Stage 6):** Claude MUST verify all implementation agents completed and file locks are released:

```bash
sqlite3 -header -column .codex/state.db "SELECT id, task, status FROM agents WHERE status NOT IN ('completed','failed');"
sqlite3 -header -column .codex/state.db "SELECT file_path, agent_id FROM file_locks;"
```

If any agents are still running or file locks remain, do NOT advance to review.

### Stage 6: Review (DUAL-MODEL) — Complete Protocol

This is the only stage that uses both Codex and Claude review agents. Follow this protocol exactly.

**Step 1: Codex Review Agents**

Spawn read-only Codex agents, each focused on a specific concern. Each writes findings to `.codex/reviews/codex-{focus}.md`. Choose review concerns based on the codebase and changes (e.g., security, error handling, data integrity).

```bash
codex-agent start "Review the implementation for [CONCERN].
Write your findings to .codex/reviews/codex-[focus].md in markdown format.
Focus on: [specific checklist]." -s read-only --map
```

**Step 2: Claude Review Agents (5 Sonnet Agents in Parallel)**

Launch 5 parallel Sonnet agents via the Task tool. Each independently reviews the implementation and returns a list of issues with reasons:

| Agent | Focus | What to check |
|-------|-------|---------------|
| #1 | CLAUDE.md compliance | Audit changes against project CLAUDE.md guidelines. Only flag rules directly relevant to the changes. |
| #2 | Bug scan | Shallow scan of files modified by implementation agents. Focus on large bugs only. Ignore nitpicks and issues linters would catch. |
| #3 | Git blame/history | Read git blame and history of modified files. Identify bugs in light of historical context. |
| #4 | Cross-agent conflicts | Check files modified by multiple agents for consistency. Verify no contradictory changes. Check pattern adherence. |
| #5 | Error handling + edge cases | Swallowed errors, missing validation, raw errors exposed to clients, unhandled edge cases. |

Each agent returns findings in-memory (NOT to disk).

**Step 3: Confidence Scoring**

For each issue from Step 2, launch a parallel Haiku agent that scores confidence 0-100:

| Score | Meaning |
|-------|---------|
| 0 | False positive. Does not stand up to scrutiny, or is pre-existing. |
| 25 | Might be real, but may be false positive. Agent could not verify. |
| 50 | Real issue, but minor/nitpick. Not important relative to the mission. |
| 75 | Very likely real. Verified. Important, will impact functionality, or directly mentioned in CLAUDE.md. |
| 100 | Definitely real. Confirmed. Will happen frequently. Evidence directly confirms. |

For CLAUDE.md-flagged issues: the scoring agent MUST double-check that CLAUDE.md actually mentions the concern.

**Filter threshold: 80.** Discard all issues scoring below 80.

**False positives to filter** (give this list to review and scoring agents):
- Pre-existing issues not introduced by this mission's agents
- Issues that linters, typecheckers, or compilers would catch
- Pedantic nitpicks a senior engineer wouldn't flag
- General quality issues unless explicitly required by CLAUDE.md
- Intentional functionality changes related to the mission
- Issues on lines not modified by agents

**Step 4: Cross-Model Synthesis**

Read Codex findings from `.codex/reviews/codex-*.md`. Combine with Claude findings (filtered at threshold 80). Write synthesis to `.codex/reviews/synthesis.md`:

- Issues flagged by BOTH Codex and Claude = **HIGH CONFIDENCE** (prioritize these)
- Issues flagged by Codex only
- Issues flagged by Claude only (scored >=80)
- Recommended actions

**Step 5: PR Review (Optional)**

If the work is on a PR branch and a PR exists, ALSO invoke `code-review:code-review` for PR-specific analysis (prior PR comments, `gh` integration, GitHub comment posting). If no PR exists, skip this step.

### Stage 7: Testing (Claude spawns workspace-write agents)

Spawn Codex agents for test writing, test execution, and verification. Each agent gets a focused testing task.

## 5. SQLite State Protocol (.codex/state.db)

The `.codex/state.db` SQLite database is the coordination bus. It lives in the project root under `.codex/`.

### Directory Structure

```
.codex/
├── state.db                # SQLite database (WAL mode)
├── state.db-wal            # WAL file (auto-created)
├── state.db-shm            # Shared memory file (auto-created)
└── reviews/
    ├── codex-{focus}.md    # Codex review agent findings
    └── synthesis.md        # Claude writes final synthesis
```

### SQL Schema

```sql
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS mission (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  stage TEXT NOT NULL,
  mission TEXT NOT NULL,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  progress TEXT DEFAULT '',
  blockers TEXT DEFAULT '[]',
  next_steps TEXT DEFAULT '[]',
  summary TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  sandbox TEXT DEFAULT 'workspace-write',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  completed_at TEXT,
  files_modified TEXT DEFAULT '[]',
  summary TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  type TEXT NOT NULL CHECK (type IN (
    'course_correction', 'approval', 'abort', 'info',
    'stage_change', 'agent_spawn', 'agent_start', 'agent_complete', 'agent_fail'
  )),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT
);

CREATE TABLE IF NOT EXISTS file_locks (
  file_path TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  locked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  message TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_checkpoints_agent ON checkpoints(agent_id);
```

### Write Ownership Table

| Table/File | Writer | Reader |
|------------|--------|--------|
| `mission` table | Claude only | Claude, Codex agents |
| `agents` table (INSERT) | Claude only | Claude, Codex agents |
| `agents` table (UPDATE own row) | Each agent by ID | Claude, Codex agents |
| `events` table | Claude (source='claude'), Agents (source='agent-{id}') | Claude, Codex agents |
| `file_locks` table | Codex agents (claim on start, release on finish) | Claude, Codex agents |
| `checkpoints` table | Codex agents (progress updates during work) | Claude, Codex agents |
| `reviews/codex-*.md` | Codex review agents (file writes) | Claude |
| `reviews/synthesis.md` | Claude | User |

**Agent write rules:**
- Agents READ all tables via SELECT queries in the Mission Context Header
- Agents UPDATE only their OWN row in `agents` (`status`, `completed_at`, `files_modified`, `summary`)
- Agents INSERT into `file_locks` to claim files before modifying them
- Agents INSERT into `checkpoints` to report incremental progress
- Agents INSERT one completion/failure event in `events` (source='agent-{their-id}')
- Agents DELETE only their OWN rows from `file_locks` when done
- Agents NEVER write to the `mission` table
- Agents NEVER modify other agents' rows or delete other agents' file locks

**Why this is conflict-free**: SQLite WAL mode allows concurrent reads with sequential writes. `busy_timeout=5000` queues writes if two hit simultaneously. Since writes are small (single INSERT/UPDATE) and infrequent, contention is near-zero.

### Initialization

Claude initializes the database when starting a mission:

```bash
mkdir -p .codex/reviews
sqlite3 .codex/state.db <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS mission (id INTEGER PRIMARY KEY CHECK (id = 1), stage TEXT NOT NULL, mission TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, progress TEXT DEFAULT '', blockers TEXT DEFAULT '[]', next_steps TEXT DEFAULT '[]', summary TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')), sandbox TEXT DEFAULT 'workspace-write', started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), completed_at TEXT, files_modified TEXT DEFAULT '[]', summary TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), type TEXT NOT NULL CHECK (type IN ('course_correction', 'approval', 'abort', 'info', 'state_change', 'agent_spawn', 'agent_start', 'agent_complete', 'agent_fail')), source TEXT NOT NULL, message TEXT NOT NULL, context TEXT);
CREATE TABLE IF NOT EXISTS file_locks (file_path TEXT PRIMARY KEY, agent_id TEXT NOT NULL, locked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), FOREIGN KEY (agent_id) REFERENCES agents(id));
CREATE TABLE IF NOT EXISTS checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), message TEXT NOT NULL, FOREIGN KEY (agent_id) REFERENCES agents(id));
CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_checkpoints_agent ON checkpoints(agent_id);
INSERT OR REPLACE INTO mission (id, stage, mission, started_at, updated_at) VALUES (1, '{stage}', '{mission}', strftime('%Y-%m-%dT%H:%M:%SZ','now'), strftime('%Y-%m-%dT%H:%M:%SZ','now'));
SQL
```

## 6. Spawning Agents — Mandatory Prompt Template

Every agent prompt MUST include the **Mission Context Header** below. This is NON-NEGOTIABLE. Claude uses this exact template every time, filling in only the bracketed placeholders. No improvisation. No shortcuts. No "simplified" versions.

### The Template

```bash
codex-agent start "
=== MISSION CONTEXT (read before starting) ===

Before you begin, run ALL of these commands to understand the current mission state:

sqlite3 -header -column .codex/state.db \"SELECT stage, mission, progress, blockers, next_steps FROM mission WHERE id=1;\"
sqlite3 -header -column .codex/state.db \"SELECT id, task, status, files_modified FROM agents ORDER BY rowid;\"
sqlite3 -header -column .codex/state.db \"SELECT timestamp, type, message FROM events WHERE source='claude' ORDER BY id DESC LIMIT 10;\"
sqlite3 -header -column .codex/state.db \"SELECT file_path, agent_id FROM file_locks;\"
sqlite3 -header -column .codex/state.db \"SELECT agent_id, timestamp, message FROM checkpoints ORDER BY id DESC LIMIT 15;\"

Read the output carefully. Understand:
1. What is the overall mission and what stage it is in
2. What other agents have already done (completed) or are currently doing (running)
3. What decisions Claude has made recently
4. Which files are currently LOCKED by other agents — do NOT touch locked files
5. What progress other agents have reported via checkpoints

Do NOT redo work that completed agents already finished.
Do NOT modify files that are locked by other agents.

Then mark yourself as running:

sqlite3 .codex/state.db \"UPDATE agents SET status='running' WHERE id='[jobId]';\"
sqlite3 .codex/state.db \"INSERT INTO events (type, source, message) VALUES ('agent_start', 'agent-[jobId]', 'Starting: [task summary]');\"

=== YOUR TASK ===

TASK: [Specific task description]

WORKSPACE: [cwd]

YOUR AGENT ID: [jobId]

CONSTRAINTS:
- Only modify these files: [list specific files]
- Follow existing code patterns
- Do not modify files outside your scope

[If UI work: Build production-grade UI. Use refined typography, spacing, micro-interactions, and visual hierarchy. The result should look like a shipped SaaS product, not a prototype.]

=== BEFORE YOU START CODING ===

Claim the files you will modify so other agents avoid them:

sqlite3 .codex/state.db \"INSERT OR IGNORE INTO file_locks (file_path, agent_id) VALUES ('[file1]', '[jobId]');\"
sqlite3 .codex/state.db \"INSERT OR IGNORE INTO file_locks (file_path, agent_id) VALUES ('[file2]', '[jobId]');\"

(Run one INSERT per file you plan to modify. INSERT OR IGNORE means it will not fail if another agent already claimed it — in that case, do NOT modify that file.)

=== DURING YOUR WORK ===

After completing each significant step, write a checkpoint:

sqlite3 .codex/state.db \"INSERT INTO checkpoints (agent_id, message) VALUES ('[jobId]', '[what you just finished]');\"

Write a checkpoint after each file you create or major change you make.

=== WHEN YOU ARE DONE ===

IMPORTANT: If your summary contains single quotes, escape them by doubling: replace ' with ''

After completing your task, run ALL of these commands:

sqlite3 .codex/state.db \"UPDATE agents SET status='completed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), files_modified='[LIST_FILES_YOU_MODIFIED]', summary='[2-3 sentence summary of what you did]' WHERE id='[jobId]';\"
sqlite3 .codex/state.db \"INSERT INTO events (type, source, message, context) VALUES ('agent_complete', 'agent-[jobId]', 'Completed: [one-line summary]', '[list key files modified]');\"
sqlite3 .codex/state.db \"DELETE FROM file_locks WHERE agent_id='[jobId]';\"

Replace [LIST_FILES_YOU_MODIFIED] with a JSON array (e.g. '[\"src/auth.ts\", \"src/types.ts\"]').
The DELETE releases your file locks so subsequent agents can modify those files.

If you FAIL or cannot complete the task, run instead:

sqlite3 .codex/state.db \"UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='[reason for failure]' WHERE id='[jobId]';\"
sqlite3 .codex/state.db \"INSERT INTO events (type, source, message, context) VALUES ('agent_fail', 'agent-[jobId]', 'Failed: [reason]', '[error details]');\"
sqlite3 .codex/state.db \"DELETE FROM file_locks WHERE agent_id='[jobId]';\"
" --map -f "relevant/files/*.ts"
```

### After Spawning

Claude MUST register the agent in the database immediately after spawning:

```bash
sqlite3 .codex/state.db "INSERT INTO agents (id, task, sandbox) VALUES ('{jobId}', '{task}', '{sandbox}');"
sqlite3 .codex/state.db "INSERT INTO events (type, source, message) VALUES ('agent_spawn', 'claude', 'Spawned agent {jobId} for: {task}');"
```

### Template Rules (STRICT)

1. **Every agent gets the full template.** All 5 sections: MISSION CONTEXT, YOUR TASK, BEFORE YOU START CODING, DURING YOUR WORK, WHEN YOU ARE DONE. No exceptions.
2. **The sqlite3 commands are verbatim.** Do not paraphrase, simplify, or omit any query.
3. **All 5 read queries in MISSION CONTEXT are mandatory.** Mission, agents, events, file_locks, checkpoints. All five, every time.
4. **Claude fills in ONLY the bracketed parts** (`[Specific task description]`, `[cwd]`, `[list specific files]`, `[jobId]`, `[file1]`, `[file2]`). The rest is copy-paste.
5. **For review agents**, add `-s read-only`, omit BEFORE YOU START CODING (no file locks needed), and append: `Write your findings to .codex/reviews/codex-{focus}.md in markdown format.`
6. **For UI work**, include the production-grade UI line. For non-UI work, omit it.
7. **File lock INSERTs** — Claude fills in the exact file paths. One INSERT per file.

## 7. CLI Reference & Monitoring

### Spawning Agents

```bash
codex-agent start "[TASK PROMPT]" --map -s read-only    # research
codex-agent start "[TASK PROMPT]" --map                  # implementation
codex-agent start "[TASK PROMPT]" --map -f "file.md"     # with file context
```

### Monitoring

**Process status:**

```bash
codex-agent jobs --json          # structured status of all agents
codex-agent jobs                 # human readable table
codex-agent events <id>          # parsed JSONL events
codex-agent events <id> 200      # more events
codex-agent capture <id>         # recent formatted output
codex-agent output <id>          # full output
codex-agent watch <id>           # live stream
```

**SQLite status (agent self-reported):**

```bash
sqlite3 -header -column .codex/state.db "SELECT id, task, status, files_modified, summary FROM agents;"
sqlite3 -header -column .codex/state.db "SELECT agent_id, timestamp, message FROM checkpoints ORDER BY id DESC LIMIT 20;"
sqlite3 -header -column .codex/state.db "SELECT file_path, agent_id FROM file_locks;"
sqlite3 -header -column .codex/state.db "SELECT timestamp, source, message FROM events WHERE type IN ('agent_complete', 'agent_fail') ORDER BY id;"
```

**Update mission progress:**

```bash
sqlite3 .codex/state.db "UPDATE mission SET progress='3 of 5 agents complete', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=1;"
```

**Mission completion summary** (when ALL agents done):

```bash
sqlite3 .codex/state.db "UPDATE mission SET stage='completed', progress='All agents complete', summary='[2-5 paragraph summary: what was built, agent breakdown, files changed, review findings, outstanding items]', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=1;"
```

**Fallback (agent didn't self-report):**

```bash
sqlite3 .codex/state.db "UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='Did not self-report. Marked failed by Claude.' WHERE id='{jobId}';"
sqlite3 .codex/state.db "INSERT INTO events (type, source, message) VALUES ('agent_fail', 'claude', 'Agent {jobId} did not self-report. Marked failed by Claude.');"
sqlite3 .codex/state.db "DELETE FROM file_locks WHERE agent_id='{jobId}';"
```

### Control

```bash
codex-agent kill <id>            # stop agent (last resort)
codex-agent clean                # remove old jobs (>7 days)
codex-agent health               # verify codex available
```

### Flags

| Flag | Short | Values | Description |
|------|-------|--------|-------------|
| `--reasoning` | `-r` | low, medium, high, xhigh | Reasoning depth |
| `--sandbox` | `-s` | read-only, workspace-write, danger-full-access | File access level |
| `--file` | `-f` | glob | Include files (repeatable) |
| `--map` | | flag | Include docs/CODEBASE_MAP.md |
| `--dir` | `-d` | path | Working directory |
| `--model` | `-m` | string | Model override |
| `--json` | | flag | JSON output (jobs only) |
| `--dry-run` | | flag | Preview prompt without executing |

### CLI Defaults

| Setting | Default | Why |
|---------|---------|-----|
| Model | `gpt-5.3-codex` | Latest and most capable Codex model |
| Reasoning | `xhigh` | Maximum reasoning depth |
| Sandbox | `workspace-write` | Agents can modify files by default |

## 8. Operational Policies

### Timeout

- Agent max runtime: **120 minutes**. Check progress at 90 minutes via `codex-agent capture <id>`.
- If unresponsive at 120 minutes: `codex-agent kill <id>`, mark failed, retry with adjusted prompt.

### Retry

- Max **2 retries** per agent with mutated prompt (add context about what failed).
- After 2 failures: mark task as blocked, inform user.

### Stage Regression

- Review findings (Stage 6) can trigger loop back to Implementation (Stage 5).
- Claude spawns fix agents for critical issues, then re-reviews.

### SQL Escaping

- Agent summaries and file lists may contain single quotes.
- Agents MUST escape single quotes in SQL values: replace `'` with `''`.
- Example: `SUMMARY=$(echo "$SUMMARY" | sed "s/'/''/g")`

## 9. Error Recovery

### Agent Fails

1. Check what happened:
   ```bash
   codex-agent events <id>
   ```
2. Update the database (if agent didn't self-report):
   ```bash
   sqlite3 .codex/state.db "UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id='{id}';"
   sqlite3 .codex/state.db "DELETE FROM file_locks WHERE agent_id='{id}';"
   ```
3. Decide: retry with adjusted prompt (max 2 retries), or skip and inform user.

### Post-Compaction Recovery

After Claude's context compacts, immediately:

1. `sqlite3 -header -column .codex/state.db "SELECT * FROM mission;"` — orchestration state
2. `sqlite3 -header -column .codex/state.db "SELECT * FROM agents;"` — agent statuses
3. `sqlite3 -header -column .codex/state.db "SELECT * FROM events WHERE source='claude' ORDER BY id;"` — past decisions
4. `sqlite3 -header -column .codex/state.db "SELECT file_path, agent_id FROM file_locks;"` — active file claims
5. `sqlite3 -header -column .codex/state.db "SELECT agent_id, timestamp, message FROM checkpoints ORDER BY id DESC LIMIT 20;"` — recent progress
6. Run `codex-agent jobs --json` for live agent processes
7. Resume from database state — `.codex/state.db` is your continuity mechanism

### Concurrent Agent Interference

Multiple `codex exec` instances may interfere with session restore (known issue). Mitigation: each agent runs as an independent process with its own JSONL output file. No shared session state between agents.

## 10. Agent Timing Expectations

**Codex agents take time. This is NORMAL. Do NOT be impatient.**

| Task Type | Typical Duration |
|-----------|------------------|
| Simple research | 10-20 minutes |
| Implementation (single feature) | 20-40 minutes |
| Complex implementation | 30-60+ minutes |
| Full PRD implementation | 45-90+ minutes |

**Do NOT:** kill agents for running 20+ minutes, assume problems at 30+ minutes, spawn replacements for "slow" agents.

**DO:** check `codex-agent jobs --json` periodically, view events when you need detail, let agents finish, trust the process.

## 11. When NOT to Use This Pipeline

Basically never. Codex agents are the default for all execution work.

**The ONLY exceptions:**
- The user explicitly says "you do it" or "don't use Codex"
- Pure conversation/discussion (no code, no files)
- You need to read a single file to understand context for the conversation

