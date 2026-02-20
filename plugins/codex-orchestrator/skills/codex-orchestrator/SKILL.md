---
name: codex-orchestrator
description: Army model — Claude decomposes tasks and spawns N focused Codex agents directly via codex exec --json. No single-lead bottleneck. Claude manages all coordination via _codex/state.db, makes strategic decisions, and orchestrates dual-model code reviews. Cross-platform (macOS, Linux, Windows). Trigger on ANY task involving code, file modifications, codebase research, multi-step work, or implementation. Only skip if the user explicitly asks you to do something yourself.
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
- **Claude**: Strategy, task decomposition, PRD creation, agent spawning, coordination via `_codex/state.db`, synthesis, dual-model review orchestration.

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
- Initialize and manage `_codex/state.db`
- Register agents in the `agents` table (status `pending`)
- Monitor agent completion via `codex-agent jobs --json` and SQLite queries
- Make course corrections via `events` table
- Synthesize results
- Run dual-model reviews (Stage 6)

**Not Claude's job:**
- Implementing code directly (agents do this)
- Doing extensive file reads for delegation context

**Agent's job:**
- Read the pre-injected mission context (provided as plain text in the prompt — no DB queries needed)
- Execute the focused task from Claude
- Write clean code following existing patterns
- Stay within scope — only modify files listed in YOUR FILES (pre-locked by Claude)
- On completion: run the single sqlite3 heredoc to report status and summary
- Exit when done — output captured automatically via JSONL

**What agents do NOT do:**
- Agents do NOT query the database (context is pre-injected by Claude)
- Agents do NOT manage file locks (Claude pre-locks before spawn, releases after completion)
- Agents do NOT write checkpoints (Claude monitors via `codex-agent capture`)
- Agents do NOT transition their own status to running (Claude does this at spawn time)

### Rule 3: Claude Subagents for Review

Use Claude subagents (Task tool) during Stage 6 (Review) for dual-model code review. Claude subagents return results in-memory — they do NOT write to disk. All code execution goes to Codex agents.

### Rule 4: Write Ownership Is Strict

See Section 5 for the full ownership table and rules. In summary: Claude owns the `mission` table, agent registration, file locks, and all status transitions. Agents own only their completion self-report (UPDATE own row + INSERT completion event). No writer ever modifies another writer's rows.

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
2. RESEARCH        (Claude spawns N workspace-write agents, read-only behavior)
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
| "investigate", "research", "understand" | RESEARCH | Spawn workspace-write Codex agents (read-only behavior) |
| Agent findings ready, need synthesis | SYNTHESIS | Claude reviews, filters, combines |
| "let's plan", "create PRD", synthesis done | PRD | Claude writes PRD to docs/prds/ |
| PRD exists, "implement", "build" | IMPLEMENTATION | Spawn workspace-write Codex agents |
| Implementation done, "review" | REVIEW | DUAL-MODEL: Codex + Claude review agents |
| "test", "verify", review passed | TESTING | Spawn workspace-write Codex agents |

### Codebase Map (Auto-Managed)

The `--map` flag injects `docs/CODEBASE_MAP.md` into every agent's prompt, giving them instant architectural context. Without it, agents waste time exploring and guessing at structure.

**Auto-create at mission start:** Before entering any pipeline stage, check if `docs/CODEBASE_MAP.md` exists. If it does NOT exist, invoke `/cartographer` to generate it. This is a prerequisite — do NOT spawn agents without a map.

```bash
test -f docs/CODEBASE_MAP.md && echo "MAP EXISTS" || echo "NO MAP — run /cartographer first"
```

**Cartographer fallback (if /cartographer returns empty):** If `/cartographer` produces no output or the map file is missing/empty after invocation, spawn a `general-purpose` agent (NOT Explore — Explore agents are read-only and cannot write files) with explicit instructions to:
1. Read all source files in the project
2. Write the analysis directly to `docs/CODEBASE_MAP.md`

Explore agents return their analysis in-context, which can be lost during context handoff (especially with `run_in_background`). `general-purpose` agents can write files directly, ensuring the map is on disk regardless of context issues.

**Auto-update after implementation:** After Stage 5 (Implementation) completes and passes the artifact gate, run `/cartographer` in update mode before advancing to Stage 6 (Review). Implementation agents change the codebase — review agents need the updated architecture to give accurate findings.

**Why this matters:** A map costs minutes to generate. Without it, every agent wastes 5-10 minutes exploring. With 5 agents, that's 25-50 minutes of wasted compute per stage.

### Stage 1: Ideation (Claude + User)

Talk through the problem with the user. Understand what they want. Plan how to decompose the work into agent-sized tasks. Even seemingly simple tasks go to Codex agents — you are the orchestrator, not the implementer.

### Stage 2: Research (Claude spawns workspace-write agents, read-only behavior)

Decompose the research into focused questions. Spawn a Codex agent for each question/area. Use `-s workspace-write` (the default) — the prompt constrains agents to read-only behavior. Do NOT use `-s read-only` because SQLite WAL mode requires write access to journal files, and agents must interact with `_codex/state.db`.

### Stage 3: Synthesis (Claude)

Review agent outputs via `codex-agent jobs --json` and `codex-agent events <id>`. Filter signal from noise:

- Agent suggests splitting a 9k token file — likely good
- Agent suggests adding rate limiting — good, we want quality
- Agent suggests types for code we didn't touch — skip, over-engineering
- Agent contradicts itself — investigate further
- Agent misunderstands the codebase — discount that finding

Write synthesis decision to `events` table in `_codex/state.db`.

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
sqlite3 -header -column _codex/state.db "SELECT id, task, status FROM agents WHERE status NOT IN ('completed','failed');"
sqlite3 -header -column _codex/state.db "SELECT file_path, agent_id FROM file_locks;"
```

If any agents are still running or file locks remain, do NOT advance to review.

**Map Update Gate (after artifact gate passes):** Run `/cartographer` to update the codebase map before review. Implementation agents changed the codebase — review agents need current architecture context.

### Stage 6: Review (DUAL-MODEL) — Complete Protocol

This is the only stage that uses both Codex and Claude review agents. Follow this protocol exactly. All findings are stored in the `review_findings` table in `_codex/state.db` for structured querying, cross-model dedup, and telemetry.

**Step 0: Deterministic Quality Gate (HARD FAIL)**

Before spending tokens on LLM review, run deterministic checks. These catch issues that don't need AI.

```bash
codex-agent review gate
```

This runs (in order, stopping on first failure):
1. `tsc --noEmit` (or project's type-check command)
2. `bun test` / `npm test` (if test suite exists)
3. Linter (eslint/biome if configured)

**If the gate fails, STOP. Fix the issues before proceeding.** Do not send broken code to review agents.

For JSON output (machine-readable): `codex-agent review gate --json`

**Step 1: Freeze Diff Scope**

Establish the exact set of files modified by implementation agents. All reviewers MUST scope their analysis to these files only.

```bash
# Get the diff scope from state.db
sqlite3 _codex/state.db "SELECT DISTINCT files_modified FROM agents WHERE status='completed';"
# Or from git if available
git diff --name-only <base-sha>..HEAD
```

Store this file list — pass it to every review agent's prompt to prevent scope creep.

**Step 2: Codex Review (via `codex review`)**

Use the built-in `codex review` command instead of `codex exec`. This gives structured, deterministic review output scoped to the diff.

```bash
# Review uncommitted changes
codex review --uncommitted

# Or review against a base commit
codex review --base <sha>

# With specific model
codex review --model gpt-5.3-codex --base <sha>
```

Parse the output and store each finding in `review_findings` via the stateStore API:

```bash
# Claude inserts findings programmatically via stateStore.insertFinding()
# or agents write structured JSON that Claude parses and inserts
```

Each finding MUST include: `agent_id`, `model`, `path`, `line` (if known), `severity` (critical/high/medium/low), `confidence` (0-100), `category`, `description`, `evidence`, `suggested_fix`, `in_diff` (true/false).

**Step 3: Claude Review Agents (5 Sonnet Agents in Parallel)**

Launch 5 parallel Sonnet agents via the Task tool. Each independently reviews the implementation and returns findings as structured JSON arrays:

| Agent | Focus | What to check |
|-------|-------|---------------|
| #1 | CLAUDE.md compliance | Audit changes against project CLAUDE.md guidelines. Only flag rules directly relevant to the changes. |
| #2 | Bug scan | Shallow scan of files modified by implementation agents. Focus on large bugs only. Ignore nitpicks and issues linters would catch. |
| #3 | Git blame/history | Read git blame and history of modified files. Identify bugs in light of historical context. |
| #4 | Cross-agent conflicts | Check files modified by multiple agents for consistency. Verify no contradictory changes. Check pattern adherence. |
| #5 | Error handling + edge cases | Swallowed errors, missing validation, raw errors exposed to clients, unhandled edge cases. |

Each agent returns findings as JSON: `[{path, line, severity, confidence, category, description, evidence, suggested_fix}]`

**IMPORTANT**: Pass the frozen diff scope (Step 1) to each agent. Agents MUST NOT review files outside the scope.

**Step 4: Confidence Scoring**

For each issue from Step 3, launch a parallel Haiku agent that scores confidence 0-100:

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
- Issues that linters, typecheckers, or compilers would catch (the gate already caught these)
- Pedantic nitpicks a senior engineer wouldn't flag
- General quality issues unless explicitly required by CLAUDE.md
- Intentional functionality changes related to the mission
- Issues on lines not modified by agents

**Step 5: Store All Findings in state.db**

After scoring, Claude inserts ALL surviving findings (confidence >= 80) into the `review_findings` table. Use `insertFinding()` from `stateStore.ts`:

- Set `agent_id` to the reviewing agent's ID (e.g., `codex-review`, `claude-review-1` through `claude-review-5`)
- Set `model` to identify the source model (e.g., `codex`, `claude-sonnet`)
- Set `in_diff = 1` for all findings from properly scoped agents

Verify insertion:
```bash
codex-agent review findings
codex-agent review summary
```

**Step 6: Cross-Model Synthesis**

Query `review_findings` for cross-model agreement. Findings flagged by BOTH Codex and Claude on the same `path + line + category` are high-confidence:

```bash
codex-agent review summary
```

The `confirmed_by_both` count shows cross-model agreement. Write synthesis to `_codex/reviews/synthesis.md`:

- Issues flagged by BOTH Codex and Claude = **HIGH CONFIDENCE** (prioritize these)
- Issues flagged by Codex only (model contains 'codex')
- Issues flagged by Claude only (model contains 'claude', scored >= 80)
- Recommended actions
- Telemetry: total findings, by severity, by status, confirmed_by_both

**Step 7: PR Review (Optional)**

If the work is on a PR branch and a PR exists, ALSO invoke `code-review:code-review` for PR-specific analysis (prior PR comments, `gh` integration, GitHub comment posting). If no PR exists, skip this step.

### Stage 7: Testing (Claude spawns workspace-write agents)

Spawn Codex agents for test writing, test execution, and verification. Each agent gets a focused testing task.

## 5. SQLite State Protocol (_codex/state.db)

The `_codex/state.db` SQLite database is the coordination bus. It lives in the project root under `_codex/`.

### Directory Structure

```
_codex/
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
  type TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS review_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  model TEXT NOT NULL,
  path TEXT NOT NULL,
  line INTEGER,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT,
  suggested_fix TEXT,
  in_diff INTEGER DEFAULT 1,
  status TEXT DEFAULT 'open' CHECK (status IN ('open','confirmed','dismissed','fixed')),
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_checkpoints_agent ON checkpoints(agent_id);
CREATE INDEX IF NOT EXISTS idx_findings_status ON review_findings(status);
CREATE INDEX IF NOT EXISTS idx_findings_path ON review_findings(path);
```

### Write Ownership Table

| Table/File | Writer | Reader |
|------------|--------|--------|
| `mission` table | Claude only | Claude |
| `agents` table (INSERT, status transitions) | Claude only | Claude |
| `agents` table (UPDATE on completion) | Each agent (own row only) | Claude |
| `events` table | Claude (source='claude'), Agents (source='agent-{id}') | Claude |
| `file_locks` table | Claude only (pre-lock before spawn, release after completion) | Claude |
| `checkpoints` table | Not used (removed — Claude monitors via `codex-agent capture`) | — |
| `review_findings` table | Claude (inserts parsed findings from all reviewers) | Claude, User |
| `reviews/codex-*.md` | Codex review agents (file writes, legacy — prefer `review_findings`) | Claude |
| `reviews/synthesis.md` | Claude | User |

**Agent write rules (minimal):**
- Agents receive all context pre-injected in their prompt — NO sqlite3 SELECT queries
- Agents UPDATE only their OWN row in `agents` on completion (`status`, `completed_at`, `files_modified`, `summary`)
- Agents INSERT one completion/failure event in `events` (source='agent-{their-id}')
- Agents do NOT touch `file_locks` — Claude manages all lock lifecycle
- Agents do NOT write to `checkpoints` — this table exists for backward compatibility but is no longer used
- Agents NEVER write to the `mission` table
- Agents NEVER modify other agents' rows

**Why this is conflict-free**: Claude is the primary DB writer (pre-spawn setup, post-completion cleanup). Agents write exactly ONE sqlite3 heredoc on completion (UPDATE + INSERT). WAL mode + `busy_timeout=5000` handles the rare case of simultaneous completion by two agents.

### Pre-Initialization: Context Recovery (MANDATORY)

Before creating or reinitializing `_codex/state.db`, Claude MUST check for existing state and recover context. **NEVER skip this step.**

**Step 1: Check if state.db exists**

```bash
test -f _codex/state.db && echo "EXISTS" || echo "NEW"
```

**Step 2: If it exists, read ALL context before doing anything else**

```bash
sqlite3 -header -column _codex/state.db "SELECT stage, mission, progress, summary FROM mission WHERE id=1;" 2>/dev/null
sqlite3 -header -column _codex/state.db "SELECT id, task, status, files_modified, summary FROM agents;" 2>/dev/null
sqlite3 -header -column _codex/state.db "SELECT timestamp, type, source, message FROM events ORDER BY id DESC LIMIT 20;" 2>/dev/null
```

Use this context to understand:
- What was previously built (agent tasks and files_modified)
- What patterns were used (agent summaries)
- What the current state of the project is
- Whether the previous mission completed or was interrupted

**Step 3: Archive, never delete**

If starting a new mission with existing data:
- Insert a boundary event marking the transition
- The old data stays — it provides valuable context for future missions

```bash
sqlite3 _codex/state.db "INSERT INTO events (type, source, message, context) VALUES ('info', 'claude', 'New mission starting. Previous mission archived in place.', (SELECT mission FROM mission WHERE id=1));" 2>/dev/null
```

### Destructive Action Policy

**NEVER run DELETE, DROP, or TRUNCATE on any table in state.db.** The accumulated history is context, not clutter. Old mission data helps Claude understand:
- What was already built (avoid duplicate work)
- What files were modified (know what exists)
- What failed previously (avoid repeating mistakes)

If tables grow excessively large (>1000 rows in checkpoints/events), Claude may ask the user for permission to prune old entries — but NEVER autonomously.

### Initialization

Claude initializes the database when starting a mission. The `mission init` command creates the `_codex/` directory, initializes the DB schema (all tables with IF NOT EXISTS), inserts the mission row, and logs an init event — all in a single command:

```bash
codex-agent mission init "{mission_description}" --stage "{stage}" --dir "{cwd}"
```

This replaces the previous manual `mkdir` + sqlite3 heredoc approach. The command is idempotent — safe to run on existing databases (tables use IF NOT EXISTS, mission row uses INSERT OR REPLACE).

## 6. Spawning Agents — Mandatory Prompt Template

Every agent prompt MUST include the **Mission Context** and **Task** blocks below. Claude uses this template every time, filling in the bracketed placeholders. No improvisation.

**Design principle: maximize coding turns.** Codex agents have a limited turn budget (not configurable). Every sqlite3 call, file read, or status update costs a turn. The template is designed so agents spend nearly ALL turns writing code.

- Claude pre-injects all mission context as plain text (agents run ZERO read queries)
- Claude pre-locks files before spawning (agents run ZERO file lock commands)
- Agents report completion with a single sqlite3 heredoc (1 turn, not 3+)
- No checkpoint writes during work (Claude monitors via `codex-agent capture`)

### The Template

**CRITICAL: Use file-based prompts to avoid shell quoting issues.** Write the prompt to `_codex/prompt-{agentId}.txt` using the Write tool, then spawn with `codex-agent start "$(cat _codex/prompt-{agentId}.txt)" --map -f "relevant/files"`.

**Before writing the prompt file**, Claude MUST:

1. Read the current mission context (single structured command replaces 3 separate SELECT queries):
```bash
codex-agent mission status --json --dir "{cwd}"
```
This returns mission state, all agents, file locks, and recent events in one machine-parseable JSON response.

2. Pre-lock the agent's files and register the agent:
```bash
sqlite3 _codex/state.db <<SQL
INSERT INTO agents (id, task, sandbox) VALUES ('{jobId}', '{task}', '{sandbox}');
INSERT INTO events (type, source, message) VALUES ('agent_spawn', 'claude', 'Spawned agent {jobId} for: {task}');
UPDATE agents SET status='running' WHERE id='{jobId}';
INSERT INTO events (type, source, message) VALUES ('agent_start', 'claude', 'Agent {jobId} started');
INSERT OR IGNORE INTO file_locks (file_path, agent_id) VALUES ('{file1}', '{jobId}');
INSERT OR IGNORE INTO file_locks (file_path, agent_id) VALUES ('{file2}', '{jobId}');
SQL
```

3. Generate the formatted mission context block for the prompt file:
```bash
CONTEXT=$(codex-agent mission context --dir "{cwd}")
```
This produces a pre-formatted text block containing the mission state, agent statuses, file locks, and recent events — ready to embed directly into the prompt. Replaces manually formatting the agents table and file locks.

4. Write the prompt file using the `$CONTEXT` output and the template below.

**Prompt file template** (write this to `_codex/prompt-{agentId}.txt`):

```
=== MISSION CONTEXT (pre-loaded by orchestrator — do not query the database) ===
{output of: codex-agent mission context --dir "{cwd}"}

This block is generated by `codex-agent mission context` and contains:
- Mission description, stage, and progress
- Other agents and their statuses
- Files locked by other agents (DO NOT modify these)
- Recent orchestrator decisions and events

=== YOUR TASK ===

TASK: [Specific task description]

WORKSPACE: [cwd]

YOUR AGENT ID: [jobId]

YOUR FILES (pre-locked for you by orchestrator):
- [file1]
- [file2]

CONSTRAINTS:
- Only modify the files listed in YOUR FILES above
- Follow existing code patterns and conventions
- Do not modify files outside your scope
- Do not query _codex/state.db — all context is provided above
[If research/review task: - IMPORTANT: Do NOT modify any source code files. Your task is to READ, ANALYZE, and REPORT only. Write findings to _codex/reviews/codex-{focus}.md in markdown format.]
[If UI work: - Build production-grade UI. Use refined typography, spacing, micro-interactions, and visual hierarchy. The result should look like a shipped SaaS product, not a prototype.]

=== WHEN DONE ===

After completing your task, run this single command to report completion.
IMPORTANT: Escape single quotes in your summary by doubling them: ' becomes ''

sqlite3 _codex/state.db <<'DONE'
UPDATE agents SET status='completed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), files_modified='[FILES_JSON_ARRAY]', summary='[2-3 sentence summary]' WHERE id='[jobId]';
INSERT INTO events (type, source, message) VALUES ('agent_complete', 'agent-[jobId]', 'Completed: [one-line summary]');
DONE

If you FAIL or cannot complete the task:

sqlite3 _codex/state.db <<'FAIL'
UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='[reason for failure]' WHERE id='[jobId]';
INSERT INTO events (type, source, message) VALUES ('agent_fail', 'agent-[jobId]', 'Failed: [reason]');
FAIL
```

**Spawning command** (after writing the prompt file):

```bash
codex-agent start "$(cat _codex/prompt-{agentId}.txt)" --map -f "relevant/files/*.ts"
```

### After Spawning

Claude has already registered the agent and pre-locked files (Step 2 above). No additional post-spawn DB writes needed. Proceed to spawn the next agent or begin monitoring.

After spawning all agents, monitor with:

```bash
codex-agent jobs --json
codex-agent mission status --json --dir "{cwd}"
```

When agents complete or fail, locks are auto-released by the runtime. Use `codex-agent mission reconcile --dir "{cwd}"` to clean up any stale state (dead agents marked failed, orphan locks released).

### File Lock Cleanup

Claude handles lock cleanup — agents do NOT run DELETE on file_locks. After an agent completes or fails (detected via `codex-agent jobs --json` or `refreshJobStatus`), Claude releases locks:

```bash
sqlite3 _codex/state.db "DELETE FROM file_locks WHERE agent_id='{jobId}';"
```

If an agent fails to self-report (no status update in state.db), Claude runs the fallback:

```bash
sqlite3 _codex/state.db "UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='Did not self-report. Marked failed by Claude.' WHERE id='{jobId}';"
sqlite3 _codex/state.db "INSERT INTO events (type, source, message) VALUES ('agent_fail', 'claude', 'Agent {jobId} did not self-report. Marked failed.');"
sqlite3 _codex/state.db "DELETE FROM file_locks WHERE agent_id='{jobId}';"
```

### Template Rules (STRICT)

1. **ALWAYS use file-based prompts.** Write to `_codex/prompt-{agentId}.txt`, spawn with `codex-agent start "$(cat _codex/prompt-{agentId}.txt)" ...`. NEVER inline the template.
2. **Every agent gets the full template.** All 3 sections: MISSION CONTEXT, YOUR TASK, WHEN DONE.
3. **Claude pre-injects ALL context.** Agents NEVER run sqlite3 SELECT queries. The mission state, agent list, locked files, and decisions are embedded as plain text by Claude.
4. **Claude pre-locks ALL files.** Before writing the prompt, Claude INSERTs file locks for every file the agent will modify. Agents NEVER run INSERT INTO file_locks.
5. **Claude handles lock cleanup.** After agent completion/failure, Claude DELETEs the agent's file locks. Agents NEVER run DELETE FROM file_locks.
6. **Agents report completion with a single heredoc.** One sqlite3 call with UPDATE + INSERT. That's it. No other DB writes during the agent's lifetime.
7. **No checkpoint writes.** Claude monitors agent progress via `codex-agent capture <id>`. Checkpoints waste turns for marginal coordination value.
8. **For review agents**, omit YOUR FILES section. Add: `Write your findings to _codex/reviews/codex-{focus}.md. Do NOT modify source code.`
9. **For UI work**, include the production-grade UI constraint. For non-UI work, omit it.
10. **Claude fills in ONLY the bracketed parts.** `[mission description]`, `[task]`, `[cwd]`, `[jobId]`, `[file1]`, `[file2]`, etc. The structure is fixed.

## 7. CLI Reference & Monitoring

### Spawning Agents

```bash
codex-agent start "[TASK PROMPT]" --map                  # research (read-only behavior in prompt)
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

**Mission & state commands (structured, machine-parseable):**

```bash
codex-agent mission status --json --dir "{cwd}"   # full mission state: mission, agents, locks, events
codex-agent mission reconcile --dir "{cwd}"        # auto-mark dead agents as failed, release their locks
codex-agent locks list --dir "{cwd}"               # list all active file locks
codex-agent locks release {agentId} --dir "{cwd}"  # manually release locks for a specific agent
codex-agent resume {jobId}                         # resume a failed non-ephemeral agent
```

**SQLite status (agent self-reported — use when controller commands are insufficient):**

```bash
sqlite3 -header -column _codex/state.db "SELECT id, task, status, files_modified, summary FROM agents;"
sqlite3 -header -column _codex/state.db "SELECT agent_id, timestamp, message FROM checkpoints ORDER BY id DESC LIMIT 20;"
sqlite3 -header -column _codex/state.db "SELECT file_path, agent_id FROM file_locks;"
sqlite3 -header -column _codex/state.db "SELECT timestamp, source, message FROM events WHERE type IN ('agent_complete', 'agent_fail') ORDER BY id;"
```

**Update mission progress:**

```bash
sqlite3 _codex/state.db "UPDATE mission SET progress='3 of 5 agents complete', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=1;"
```

**Mission completion summary** (when ALL agents done):

```bash
sqlite3 _codex/state.db "UPDATE mission SET stage='completed', progress='All agents complete', summary='[2-5 paragraph summary: what was built, agent breakdown, files changed, review findings, outstanding items]', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=1;"
```

**Fallback (agent didn't self-report):** See Section 6 "File Lock Cleanup" for the full fallback sequence.

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

### Sandbox Mode: workspace-write for ALL agents

**NEVER use `-s read-only` for any agent.** All agents MUST use `workspace-write` (the default).

**Why:** SQLite WAL mode requires write access to create `-wal` and `-shm` journal files. On Windows (MINGW/Git Bash), the `read-only` sandbox blocks this access entirely, making `_codex/state.db` unreadable. Even a simple SELECT query fails because SQLite cannot open the WAL journal.

Additionally, review agents need to write findings to `_codex/reviews/`, which also requires write access.

**How read-only behavior is enforced:** For research and review agents, the PROMPT explicitly constrains the agent: "Do NOT modify any source code files." This is a behavioral constraint, not a sandbox restriction. The agent template already limits which files agents can touch via the CONSTRAINTS section.

### Timeout

- CLI inactivity timeout: **60 minutes** (configurable in `src/config.ts`). Job auto-marked as failed if no JSONL activity.
- Orchestration policy maximum: **120 minutes**. Check progress at 90 minutes via `codex-agent capture <id>`.
- If unresponsive at 120 minutes: `codex-agent kill <id>`, mark failed, retry with adjusted prompt.

### Retry

- Max **2 retries** per agent with mutated prompt (add context about what failed).
- After 2 failures: mark task as blocked, inform user.

### Stage Regression

- Review findings (Stage 6) can trigger loop back to Implementation (Stage 5).
- Claude spawns fix agents for critical issues, then re-reviews.

### Data Integrity

- **NEVER run DELETE, DROP, or TRUNCATE on state.db tables** without explicit user approval.
- Old mission data is context, not clutter. It helps avoid duplicate work and understand project history.
- When an agent fails, only DELETE that agent's file_locks (to release claimed files) — never bulk delete.
- If the database grows large, ask the user before pruning.

### SQL Escaping

- Agent summaries and file lists may contain single quotes.
- Agents MUST escape single quotes in SQL values: replace `'` with `''`.
- Example: `SUMMARY=$(echo "$SUMMARY" | sed "s/'/''/g")`

### Execution Mode: Ephemeral vs Persistent

Agents can run in two modes controlled by the `--ephemeral` flag:

**Ephemeral (default):** Session data is not persisted. Best for:
- Quick research or review tasks (< 10 min expected)
- Tasks where retry-from-scratch is acceptable
- Running many parallel agents where disk space matters

**Persistent (omit --ephemeral):** Session is saved to disk and can be resumed. Best for:
- Complex implementation tasks (> 10 min expected)
- High-value tasks where partial progress should be recoverable
- Tasks operating on large codebases where re-reading context is expensive

To start a persistent agent:

```bash
codex-agent start "prompt" --no-ephemeral
```

To resume a failed persistent agent:

```bash
codex-agent resume <jobId>
```

Claude decides per-agent based on task complexity. Default to ephemeral unless the task is complex enough to warrant recovery support.

## 9. Error Recovery

### Agent Fails

1. Check what happened:
   ```bash
   codex-agent events <id>
   codex-agent capture <id>
   ```
2. Mark failed and release locks (Claude handles all DB writes — see Section 6 "File Lock Cleanup"):
   ```bash
   sqlite3 _codex/state.db <<SQL
   UPDATE agents SET status='failed', completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), summary='[failure reason from events]' WHERE id='{id}';
   INSERT INTO events (type, source, message) VALUES ('agent_fail', 'claude', 'Agent {id} failed: [reason]');
   DELETE FROM file_locks WHERE agent_id='{id}';
   SQL
   ```
   Alternatively, to manually release locks for a specific agent:
   ```bash
   codex-agent locks release {agentId} --dir "{cwd}"
   ```
   To resume a failed persistent (non-ephemeral) agent instead of retrying from scratch:
   ```bash
   codex-agent resume {jobId}
   ```
3. Decide: retry with adjusted prompt (max 2 retries), resume if persistent, or skip and inform user.

### Post-Compaction Recovery

After Claude's context compacts, immediately recover state with:

```bash
# 1. Live agent processes
codex-agent jobs --json

# 2. Full mission state (mission, agents, locks, events — all in one call)
codex-agent mission status --json --dir "{cwd}"

# 3. Reconcile dead agents (auto-marks failed, releases their locks)
codex-agent mission reconcile --dir "{cwd}"
```

The `mission status --json` command replaces the 4 separate sqlite3 SELECT queries previously needed. The `mission reconcile` command automatically detects agents whose processes died without self-reporting, marks them as failed, and releases their file locks — eliminating the need for manual fallback sqlite3 heredocs.

Resume from the combined output — `_codex/state.db` is your continuity mechanism.

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

