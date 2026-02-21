# Controller-First Orchestration Implementation Plan

## 1. Purpose

This plan upgrades `barthazian/codex-orchestrator` from prompt-driven coordination to deterministic runtime coordination while keeping the same user workflow and model stack:

- Orchestrator model: `claude-opus-4.6`
- Execution model: `gpt-5.3-codex`
- Fast scan model: `gpt-5.3-codex-spark`

Primary objective: make Codex multi-agent spawning and coordination reliable, observable, and recoverable under failure.

## 2. Current Issues To Fix

Known behavior in current codebase:

1. Coordination logic is mostly in `SKILL.md` prompt protocol, not runtime enforcement.
2. Runtime truth is split across JSONL/pid files and SQLite, with manual reconciliation.
3. `refreshJobStatus` can mark a dead process as completed without explicit terminal success event.
4. File locks are advisory and path canonicalization is not enforced.
5. Worker self-reporting to SQLite is not guaranteed and can drift from actual execution.
6. No test suite currently validates failure and recovery paths.

## 3. Target Architecture

## 3.1 Control Plane

Use one runtime controller inside `codex-agent` as the sole authority for orchestration state.

1. Claude plans and requests tasks.
2. Controller persists tasks in SQLite.
3. Controller acquires file locks and dispatches workers.
4. Workers run `codex exec --json` and never write SQLite directly.
5. Controller ingests JSONL events and advances task state machine.
6. Controller handles retries, timeout, recovery, and lock release.

## 3.2 Data Plane

1. Worker prompt contains task scope and constraints only.
2. Worker outputs only through JSONL and filesystem changes.
3. Controller derives files changed and summary from events and diff signals.

## 3.3 State Ownership

SQLite write ownership becomes strict:

1. Controller: all writes to mission/tasks/events/file_locks/checkpoints.
2. Claude: no direct SQL writes; uses controller commands only.
3. Workers: no SQL writes.

## 4. Scope

In scope:

1. SQLite schema v2 and migration.
2. Controller modules in `src/`.
3. New orchestration CLI commands.
4. SKILL protocol rewrite to controller-driven operation.
5. Automated reconciliation and recovery.
6. Test suite and CI gates.

Out of scope:

1. Replacing Codex CLI transport (`codex exec --json` stays).
2. Changing plugin marketplace structure.
3. Building a remote service; controller remains local CLI process.

## 5. Success Criteria

Required targets before merge:

1. Zero false completions in forced-failure tests.
2. No stale lock after crash/kill/restart scenarios.
3. Deterministic task state transitions with audit trail.
4. Full orchestration resume after controller restart.
5. At least 80 percent test coverage on orchestration core modules.
6. End-to-end scenario pass rate at least 95 percent over 50 seeded runs.

## 6. Implementation Phases

## Phase 0 - Baseline and Safety Net

Goal: freeze current behavior and establish reproducible benchmarks.

Tasks:

1. Add baseline integration script under `scripts/` for current flows:
   - spawn 3 jobs
   - one completes
   - one hard-fails
   - one killed
2. Capture metrics:
   - completion classification accuracy
   - stale lock count
   - mean time to detect terminal state
3. Add `docs/BASELINE_METRICS.md`.

Deliverables:

1. Baseline script.
2. Baseline metrics document.

## Phase 1 - Immediate Correctness Fixes

Goal: remove critical correctness defects before larger refactor.

Tasks:

1. Fix false completion logic in `src/jobs.ts`:
   - require explicit terminal success event (`turn.completed` or `task.completed`) before setting completed.
   - if process exits without terminal success event, mark failed with reason `process_exited_without_success_event`.
2. Extend terminal classification in `src/exec.ts`:
   - normalize terminal event mapping.
   - persist final reason code.
3. Add lock-safe kill path:
   - when killed, controller marks failed and releases owned locks.
4. Add unit tests for status transitions and terminal event parsing.

Deliverables:

1. Patch in `src/jobs.ts` and `src/exec.ts`.
2. Tests for transition correctness.

## Phase 2 - SQLite Schema v2

Goal: make SQLite authoritative and controller-friendly.

Tasks:

1. Add migration framework under `src/migrations/`.
2. Introduce schema v2 in `_codex/state.db`:
   - `missions`
   - `tasks`
   - `task_attempts`
   - `events`
   - `file_locks`
   - `checkpoints`
3. Keep compatibility views for existing table names where possible:
   - `mission` view
   - `agents` view
4. Add `schema_version` table.
5. Add strict constraints:
   - task status enum
   - foreign keys with `PRAGMA foreign_keys=ON`
   - unique lock ownership
6. Add lock lease fields:
   - `lease_expires_at`
   - `heartbeat_at`
7. Add canonical file path column in `file_locks`.

Proposed task status FSM:

1. `queued`
2. `dispatching`
3. `running`
4. `completed`
5. `failed`
6. `timed_out`
7. `canceled`
8. `blocked`

Deliverables:

1. Migration SQL files.
2. `src/state/schema.ts` constants and validators.
3. Compatibility notes in `docs/STATE_SCHEMA_V2.md`.

## Phase 3 - Controller Core Modules

Goal: move orchestration rules from prompt text into executable runtime.

Add modules:

1. `src/controller/stateStore.ts`
2. `src/controller/taskFsm.ts`
3. `src/controller/scheduler.ts`
4. `src/controller/lockManager.ts`
5. `src/controller/dispatcher.ts`
6. `src/controller/eventIngestor.ts`
7. `src/controller/reconciler.ts`
8. `src/controller/retryPolicy.ts`

Core behavior:

1. Scheduler selects runnable tasks by dependency + lock availability + concurrency limit.
2. Dispatcher spawns worker and records `task_attempt`.
3. Event ingestor tails JSONL and emits normalized runtime events.
4. FSM applies transitions with validation.
5. Reconciler handles restarts, dead PIDs, and missing terminal events.
6. Lock manager grants/rejects locks using canonicalized paths.

Deliverables:

1. Controller module set.
2. Structured event model and reason codes.
3. State transition audit logs.

## Phase 4 - CLI Contract Redesign

Goal: expose deterministic orchestration commands and preserve simple UX.

New commands:

1. `codex-agent mission init --mission "..."`
2. `codex-agent task enqueue --task-id ... --stage ... --prompt-file ... --scope-file ...`
3. `codex-agent task start --task-id ...` (manual dispatch)
4. `codex-agent mission run` (controller loop / auto-dispatch)
5. `codex-agent mission status --json`
6. `codex-agent mission reconcile`
7. `codex-agent task cancel --task-id ...`
8. `codex-agent locks list --json`
9. `codex-agent locks release-stale --task-id ...` (controlled)

Backward compatibility:

1. Keep `codex-agent start` as thin wrapper that:
   - creates mission if absent
   - enqueues one task
   - dispatches immediately
2. Deprecation warnings for direct legacy patterns over 2 releases.

Deliverables:

1. CLI command handlers in `src/cli.ts`.
2. JSON schema docs in `docs/CLI_V2.md`.

## Phase 5 - Prompt and Skill Protocol Refactor

Goal: simplify worker prompts and remove SQL responsibilities from workers.

Update:

1. `plugins/codex-orchestrator/skills/codex-orchestrator/SKILL.md`
2. `plugins/codex-orchestrator/README.md`
3. `README.md`
4. `docs/RUNBOOK.md`
5. `plugins/.../assets/agents.log.template` (replace with v2 schema reference)

Required changes:

1. Remove mandatory mission SQL header from worker prompts.
2. Replace with controller-generated context block:
   - mission summary
   - task goal
   - allowed files
   - forbidden files
   - done criteria
3. Replace agent self-report SQL steps with controller-managed completion.
4. Keep file-based prompt transport for quoting safety.
5. Document new operational flow:
   - Claude calls controller commands, not raw SQL.

Deliverables:

1. Updated skill protocol.
2. Updated docs with command-based runbook.

## Phase 6 - Locking and Path Canonicalization

Goal: make file coordination collision-safe.

Tasks:

1. Implement canonicalization utility:
   - normalize separators
   - resolve relative paths against task cwd
   - normalize case policy per platform
2. Store both:
   - `path_raw`
   - `path_canonical`
3. Lock acquisition policy:
   - all declared files must lock before task enters running
   - if lock conflict, task status `blocked`
4. Stale lock policy:
   - lock lease heartbeat per running task
   - lease expiry reclaims lock after configurable grace period

Deliverables:

1. `src/controller/lockManager.ts`
2. Collision tests including Windows path edge cases.

## Phase 7 - Reliability and Recovery

Goal: robust continuation after crashes and compaction.

Tasks:

1. Add periodic reconciler tick:
   - verify PID liveness
   - inspect last JSONL event
   - update FSM safely
2. Startup recovery:
   - detect in-flight tasks
   - reattach tailing to existing JSONL files
   - reclaim stale locks
3. Add explicit failure reason codes:
   - `timeout_inactive`
   - `process_exit_no_success_event`
   - `terminal_failure_event`
   - `dispatch_error`
   - `lock_conflict`
4. Add mission-level health endpoint in CLI.

Deliverables:

1. Reconciler runtime.
2. Recovery tests and documentation.

## Phase 8 - Testing and CI

Goal: make orchestration changes safe to ship.

Test layers:

1. Unit tests:
   - FSM transitions
   - event parsing
   - lock arbitration
   - retry policy
2. Integration tests:
   - spawn mocked workers emitting synthetic JSONL
   - crash mid-run
   - stale lock recovery
3. End-to-end smoke tests:
   - real `codex exec --json` run in sample repo
   - multi-task mission with dependencies

CI gates:

1. Typecheck
2. Lint
3. Unit + integration tests
4. Coverage threshold
5. Optional nightly e2e run

Deliverables:

1. `tests/unit/*`
2. `tests/integration/*`
3. `.github/workflows/ci.yml` update

## Phase 9 - Rollout Strategy

Goal: migrate safely without breaking existing users.

Steps:

1. Ship controller path behind feature flag:
   - `CODEX_ORCH_V2=1`
2. Run dual-write mode for one release:
   - write v2 tables
   - preserve legacy outputs
3. Gather telemetry and failure reports.
4. Promote v2 to default.
5. Remove legacy SQL-in-worker protocol in next major release.

Rollback:

1. Disable flag to revert to legacy behavior.
2. Keep migration reversible where possible.
3. Preserve mission/task history during rollback.

## 7. File-Level Change Plan

New files:

1. `src/controller/stateStore.ts`
2. `src/controller/taskFsm.ts`
3. `src/controller/scheduler.ts`
4. `src/controller/lockManager.ts`
5. `src/controller/dispatcher.ts`
6. `src/controller/eventIngestor.ts`
7. `src/controller/reconciler.ts`
8. `src/controller/retryPolicy.ts`
9. `src/migrations/0001_init_v2.sql`
10. `src/migrations/0002_views_compat.sql`
11. `src/migrations/runner.ts`
12. `docs/STATE_SCHEMA_V2.md`
13. `docs/CLI_V2.md`
14. `docs/BASELINE_METRICS.md`

Modified files:

1. `src/cli.ts`
2. `src/jobs.ts`
3. `src/exec.ts`
4. `src/config.ts`
5. `plugins/codex-orchestrator/skills/codex-orchestrator/SKILL.md`
6. `plugins/codex-orchestrator/README.md`
7. `README.md`
8. `docs/RUNBOOK.md`
9. `docs/CODEBASE_MAP.md` (if needed for navigation updates)

## 8. Suggested Config Defaults

1. `maxConcurrentTasks`: 5
2. `lockLeaseSeconds`: 120
3. `heartbeatIntervalSeconds`: 15
4. `inactiveTimeoutMinutes`: 60
5. `maxRetriesPerTask`: 2
6. `defaultModel`: `gpt-5.3-codex`
7. `defaultReasoning`: `xhigh`

## 9. Operational Runbook (v2)

Mission lifecycle:

1. `codex-agent mission init --mission "..."`
2. `codex-agent task enqueue ...` (repeat per task)
3. `codex-agent mission run`
4. `codex-agent mission status --json`
5. `codex-agent mission reconcile` (if interrupted)
6. `codex-agent task cancel --task-id ...` (only when needed)

Incident handling:

1. If task stalled: run reconcile, inspect reason code, then retry task.
2. If lock conflict: inspect `locks list`, adjust file scopes, re-enqueue.
3. If controller crash: restart and run `mission reconcile`.

## 10. Acceptance Checklist

Feature completeness:

1. Controller is sole DB writer.
2. Workers do not execute SQL.
3. Task FSM is enforced in code.
4. Locking is canonicalized and lease-based.
5. Recovery after restart works.
6. Legacy `start` still works during transition.

Quality:

1. Unit/integration tests pass.
2. Coverage target met.
3. Baseline metrics improved:
   - false completion rate to 0
   - stale lock incidents to 0 in seeded crash tests
   - status convergence under 5 seconds after terminal event

## 11. Prompt To Feed Claude For Execution

Use this exact prompt with Claude when you start implementation:

```text
Implement docs/CONTROLLER_ORCHESTRATION_IMPLEMENTATION_PLAN.md end to end in phased commits.
Constraints:
1) Keep backward compatibility for `codex-agent start` during migration.
2) Make the controller the only SQLite writer.
3) Remove SQL responsibilities from worker prompts in SKILL.md.
4) Add migration files and tests before enabling v2 by default.
5) Do not skip failure-mode and recovery tests.
Execution style:
- Complete Phase 0 and Phase 1 first and open a checkpoint summary.
- Then proceed phase by phase with a brief diff summary and test results after each phase.
```

## 12. Proposed Milestones

1. Milestone A (days 1-2): Phase 0-1 complete.
2. Milestone B (days 3-5): Phase 2-4 complete with controller and CLI v2.
3. Milestone C (days 6-7): Phase 5-8 complete with tests and docs.
4. Milestone D (day 8): Flagged rollout and production validation.

