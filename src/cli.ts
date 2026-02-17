#!/usr/bin/env bun

// Codex Agent CLI - Delegate tasks to GPT Codex agents via codex exec --json
// Designed for Claude Code orchestration — cross-platform

import { config, ReasoningEffort, SandboxMode } from "./config.ts";
import {
  startJob,
  loadJob,
  listJobs,
  killJob,
  refreshJobStatus,
  cleanupOldJobs,
  deleteJob,
  getJobOutput,
  getJobFullOutput,
  Job,
  getJobsJson,
} from "./jobs.ts";
import { loadFiles, formatPromptWithFiles, estimateTokens, loadCodebaseMap } from "./files.ts";
import { isCodexAvailable, getCodexVersion, getEvents, formatEvent } from "./exec.ts";

const HELP = `
Codex Agent - Delegate tasks to GPT Codex agents (codex exec --json)

Usage:
  codex-agent start "prompt" [options]   Start agent with codex exec
  codex-agent status <jobId>             Check job status
  codex-agent capture <jobId> [lines]    Show recent events (default: 50)
  codex-agent output <jobId>             Get full event stream
  codex-agent events <jobId> [count]     Show parsed JSONL events
  codex-agent watch <jobId>              Stream output updates
  codex-agent jobs [--json]              List all jobs
  codex-agent kill <jobId>               Kill running job
  codex-agent clean                      Clean old completed jobs
  codex-agent health                     Check codex availability

Options:
  -r, --reasoning <level>    Reasoning effort: low, medium, high, xhigh (default: xhigh)
  -m, --model <model>        Model name (default: gpt-5.3-codex)
  -s, --sandbox <mode>       Sandbox: read-only, workspace-write, danger-full-access
  -f, --file <glob>          Include files matching glob (can repeat)
  -d, --dir <path>           Working directory (default: cwd)
  --parent-session <id>      Parent session ID for linkage
  --map                      Include codebase map if available
  --dry-run                  Show prompt without executing
  --json                     Output JSON (jobs command only)
  --limit <n>                Limit jobs shown (jobs command only)
  --all                      Show all jobs (jobs command only)
  -h, --help                 Show this help

Examples:
  # Start an agent
  codex-agent start "Review this code for security issues" -f "src/**/*.ts"

  # Check on it
  codex-agent events abc123

  # Watch live output
  codex-agent watch abc123

  # View all jobs as JSON
  codex-agent jobs --json
`;

interface Options {
  reasoning: ReasoningEffort;
  model: string;
  sandbox: SandboxMode;
  files: string[];
  dir: string;
  includeMap: boolean;
  parentSessionId: string | null;
  dryRun: boolean;
  json: boolean;
  jobsLimit: number | null;
  jobsAll: boolean;
}

function parseArgs(args: string[]): {
  command: string;
  positional: string[];
  options: Options;
} {
  const options: Options = {
    reasoning: config.defaultReasoningEffort,
    model: config.model,
    sandbox: config.defaultSandbox,
    files: [],
    dir: process.cwd(),
    includeMap: false,
    parentSessionId: null,
    dryRun: false,
    json: false,
    jobsLimit: config.jobsListLimit,
    jobsAll: false,
  };

  const positional: string[] = [];
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    } else if (arg === "-r" || arg === "--reasoning") {
      const level = args[++i] as ReasoningEffort;
      if (config.reasoningEfforts.includes(level)) {
        options.reasoning = level;
      } else {
        console.error(`Invalid reasoning level: ${level}`);
        console.error(`Valid options: ${config.reasoningEfforts.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "-m" || arg === "--model") {
      options.model = args[++i];
    } else if (arg === "-s" || arg === "--sandbox") {
      const mode = args[++i] as SandboxMode;
      if (config.sandboxModes.includes(mode)) {
        options.sandbox = mode;
      } else {
        console.error(`Invalid sandbox mode: ${mode}`);
        console.error(`Valid options: ${config.sandboxModes.join(", ")}`);
        process.exit(1);
      }
    } else if (arg === "-f" || arg === "--file") {
      options.files.push(args[++i]);
    } else if (arg === "-d" || arg === "--dir") {
      options.dir = args[++i];
    } else if (arg === "--parent-session") {
      options.parentSessionId = args[++i] ?? null;
    } else if (arg === "--map") {
      options.includeMap = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--limit") {
      const raw = args[++i];
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        console.error(`Invalid limit: ${raw}`);
        process.exit(1);
      }
      options.jobsLimit = Math.floor(parsed);
    } else if (arg === "--all") {
      options.jobsAll = true;
    } else if (!arg.startsWith("-")) {
      if (!command) {
        command = arg;
      } else {
        positional.push(arg);
      }
    }
  }

  return { command, positional, options };
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

function formatJobStatus(job: Job): string {
  const elapsed = job.startedAt
    ? formatDuration(
        (job.completedAt ? new Date(job.completedAt).getTime() : Date.now()) -
          new Date(job.startedAt).getTime()
      )
    : "-";

  const status = job.status.toUpperCase().padEnd(10);
  const promptPreview = job.prompt.slice(0, 50) + (job.prompt.length > 50 ? "..." : "");

  return `${job.id}  ${status}  ${elapsed.padEnd(8)}  ${job.reasoningEffort.padEnd(6)}  ${promptPreview}`;
}

function refreshJobsForDisplay(jobs: Job[]): Job[] {
  return jobs.map((job) => {
    if (job.status !== "running") return job;
    const refreshed = refreshJobStatus(job.id);
    return refreshed ?? job;
  });
}

function sortJobsRunningFirst(jobs: Job[]): Job[] {
  const statusRank: Record<Job["status"], number> = {
    running: 0,
    pending: 1,
    failed: 2,
    completed: 3,
  };

  return [...jobs].sort((a, b) => {
    const rankDiff = statusRank[a.status] - statusRank[b.status];
    if (rankDiff !== 0) return rankDiff;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function applyJobsLimit<T>(jobs: T[], limit: number | null): T[] {
  if (!limit || limit <= 0) return jobs;
  return jobs.slice(0, limit);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const { command, positional, options } = parseArgs(args);

  switch (command) {
    case "health": {
      // Check codex
      if (!isCodexAvailable()) {
        console.error("codex CLI not found");
        console.error("Install with: npm install -g @openai/codex");
        process.exit(1);
      }
      const version = getCodexVersion();
      console.log(`codex: ${version}`);
      console.log("Status: Ready");
      break;
    }

    case "start": {
      if (positional.length === 0) {
        console.error("Error: No prompt provided");
        process.exit(1);
      }

      // Check codex first
      if (!isCodexAvailable()) {
        console.error("Error: codex CLI is required but not installed");
        console.error("Install with: npm install -g @openai/codex");
        process.exit(1);
      }

      let prompt = positional.join(" ");

      // Load file context if specified
      if (options.files.length > 0) {
        const files = await loadFiles(options.files, options.dir);
        prompt = formatPromptWithFiles(prompt, files);
        console.error(`Included ${files.length} files`);
      }

      // Include codebase map if requested
      if (options.includeMap) {
        const map = await loadCodebaseMap(options.dir);
        if (map) {
          prompt = `## Codebase Map\n\n${map}\n\n---\n\n${prompt}`;
          console.error("Included codebase map");
        } else {
          console.error("No codebase map found");
        }
      }

      if (options.dryRun) {
        const tokens = estimateTokens(prompt);
        console.log(`Would send ~${tokens.toLocaleString()} tokens`);
        console.log(`Model: ${options.model}`);
        console.log(`Reasoning: ${options.reasoning}`);
        console.log(`Sandbox: ${options.sandbox}`);
        console.log("\n--- Prompt Preview ---\n");
        console.log(prompt.slice(0, 3000));
        if (prompt.length > 3000) {
          console.log(`\n... (${prompt.length - 3000} more characters)`);
        }
        process.exit(0);
      }

      const job = startJob({
        prompt,
        model: options.model,
        reasoningEffort: options.reasoning,
        sandbox: options.sandbox,
        parentSessionId: options.parentSessionId ?? undefined,
        cwd: options.dir,
      });

      console.log(`Job started: ${job.id}`);
      console.log(`Model: ${job.model} (${job.reasoningEffort})`);
      console.log(`Working dir: ${job.cwd}`);
      if (job.pid) console.log(`PID: ${job.pid}`);
      console.log("");
      console.log("Commands:");
      console.log(`  View events:     codex-agent events ${job.id}`);
      console.log(`  Capture output:  codex-agent capture ${job.id}`);
      console.log(`  Watch live:      codex-agent watch ${job.id}`);
      break;
    }

    case "status": {
      if (positional.length === 0) {
        console.error("Error: No job ID provided");
        process.exit(1);
      }

      const job = refreshJobStatus(positional[0]);
      if (!job) {
        console.error(`Job ${positional[0]} not found`);
        process.exit(1);
      }

      console.log(`Job: ${job.id}`);
      console.log(`Status: ${job.status}`);
      console.log(`Model: ${job.model} (${job.reasoningEffort})`);
      console.log(`Sandbox: ${job.sandbox}`);
      console.log(`Created: ${job.createdAt}`);
      if (job.startedAt) console.log(`Started: ${job.startedAt}`);
      if (job.completedAt) console.log(`Completed: ${job.completedAt}`);
      if (job.pid) console.log(`PID: ${job.pid}`);
      if (job.tokensUsed) console.log(`Tokens: ${job.tokensUsed.input} in / ${job.tokensUsed.output} out`);
      if (job.filesModified && job.filesModified.length > 0) {
        console.log(`Files modified: ${job.filesModified.join(", ")}`);
      }
      if (job.error) console.log(`Error: ${job.error}`);
      break;
    }

    case "events": {
      if (positional.length === 0) {
        console.error("Error: No job ID provided");
        process.exit(1);
      }

      const count = positional[1] ? parseInt(positional[1], 10) : 50;
      const events = getEvents(positional[0], count);

      if (events.length === 0) {
        console.error(`No events found for job ${positional[0]}`);
        process.exit(1);
      }

      for (const event of events) {
        console.log(formatEvent(event));
      }
      break;
    }

    case "capture": {
      if (positional.length === 0) {
        console.error("Error: No job ID provided");
        process.exit(1);
      }

      const lines = positional[1] ? parseInt(positional[1], 10) : 50;
      const output = getJobOutput(positional[0], lines);

      if (output) {
        console.log(output);
      } else {
        console.error(`Could not capture output for job ${positional[0]}`);
        process.exit(1);
      }
      break;
    }

    case "output": {
      if (positional.length === 0) {
        console.error("Error: No job ID provided");
        process.exit(1);
      }

      const output = getJobFullOutput(positional[0]);
      if (output) {
        console.log(output);
      } else {
        console.error(`Could not get output for job ${positional[0]}`);
        process.exit(1);
      }
      break;
    }

    case "watch": {
      if (positional.length === 0) {
        console.error("Error: No job ID provided");
        process.exit(1);
      }

      const job = loadJob(positional[0]);
      if (!job) {
        console.error(`Job ${positional[0]} not found`);
        process.exit(1);
      }

      console.error(`Watching job ${job.id}... (Ctrl+C to stop)`);
      console.error("");

      // Poll JSONL for new events
      let lastEventCount = 0;
      const pollInterval = setInterval(() => {
        const events = getEvents(positional[0], 200);
        if (events.length > lastEventCount) {
          // Print only new events
          const newEvents = events.slice(lastEventCount);
          for (const event of newEvents) {
            console.log(formatEvent(event));
          }
          lastEventCount = events.length;
        }

        // Check if job is still running
        const refreshed = refreshJobStatus(positional[0]);
        if (refreshed && refreshed.status !== "running") {
          console.error(`\nJob ${refreshed.status}`);
          clearInterval(pollInterval);
          process.exit(0);
        }
      }, 1000);

      // Handle Ctrl+C
      process.on("SIGINT", () => {
        clearInterval(pollInterval);
        console.error("\nStopped watching");
        process.exit(0);
      });
      break;
    }

    case "jobs": {
      if (options.json) {
        const payload = getJobsJson();
        const limit = options.jobsAll ? null : options.jobsLimit;
        const statusRank: Record<Job["status"], number> = {
          running: 0,
          pending: 1,
          failed: 2,
          completed: 3,
        };
        payload.jobs.sort((a, b) => {
          const rankDiff = statusRank[a.status] - statusRank[b.status];
          if (rankDiff !== 0) return rankDiff;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
        payload.jobs = applyJobsLimit(payload.jobs, limit);
        console.log(JSON.stringify(payload, null, 2));
        break;
      }

      const limit = options.jobsAll ? null : options.jobsLimit;
      const allJobs = refreshJobsForDisplay(listJobs());
      const jobs = applyJobsLimit(sortJobsRunningFirst(allJobs), limit);
      if (jobs.length === 0) {
        console.log("No jobs");
      } else {
        console.log("ID        STATUS      ELAPSED   EFFORT  PROMPT");
        console.log("-".repeat(80));
        for (const job of jobs) {
          console.log(formatJobStatus(job));
        }
      }
      break;
    }

    case "kill": {
      if (positional.length === 0) {
        console.error("Error: No job ID provided");
        process.exit(1);
      }

      if (killJob(positional[0])) {
        console.log(`Killed job: ${positional[0]}`);
      } else {
        console.error(`Could not kill job: ${positional[0]}`);
        process.exit(1);
      }
      break;
    }

    case "clean": {
      const cleaned = cleanupOldJobs(7);
      console.log(`Cleaned ${cleaned} old jobs`);
      break;
    }

    case "delete": {
      if (positional.length === 0) {
        console.error("Error: No job ID provided");
        process.exit(1);
      }

      if (deleteJob(positional[0])) {
        console.log(`Deleted job: ${positional[0]}`);
      } else {
        console.error(`Could not delete job: ${positional[0]}`);
        process.exit(1);
      }
      break;
    }

    default:
      // Treat as prompt for start command
      if (command) {
        if (!isCodexAvailable()) {
          console.error("Error: codex CLI is required but not installed");
          console.error("Install with: npm install -g @openai/codex");
          process.exit(1);
        }

        const prompt = [command, ...positional].join(" ");

        if (options.dryRun) {
          const tokens = estimateTokens(prompt);
          console.log(`Would send ~${tokens.toLocaleString()} tokens`);
          process.exit(0);
        }

        const job = startJob({
          prompt,
          model: options.model,
          reasoningEffort: options.reasoning,
          sandbox: options.sandbox,
          parentSessionId: options.parentSessionId ?? undefined,
          cwd: options.dir,
        });

        console.log(`Job started: ${job.id}`);
        if (job.pid) console.log(`PID: ${job.pid}`);
        console.log(`Events: codex-agent events ${job.id}`);
      } else {
        console.log(HELP);
      }
  }
}

main();
