// codex exec --json backend
// Spawns codex exec as detached background processes with JSONL output

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { config } from "./config.ts";
import { spawnSync } from "child_process";

// --- Types ---

export interface ExecEvent {
  type: string;
  [key: string]: unknown;
}

export interface StartExecResult {
  pid: number;
  jobId: string;
  success: boolean;
  error?: string;
}

// --- Paths ---

function getJsonlPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.jsonl`);
}

function getStderrPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.stderr`);
}

function getPidPath(jobId: string): string {
  return join(config.jobsDir, `${jobId}.pid`);
}

// --- Core Execution ---

/**
 * Spawn codex exec --json as a detached background process.
 * Output goes to {jobId}.jsonl, stderr to {jobId}.stderr.
 * PID is stored in {jobId}.pid for later process management.
 */
export function startExec(options: {
  jobId: string;
  prompt: string;
  model: string;
  reasoningEffort: string;
  sandbox: string;
  cwd: string;
}): StartExecResult {
  mkdirSync(config.jobsDir, { recursive: true });

  const jsonlPath = getJsonlPath(options.jobId);
  const stderrPath = getStderrPath(options.jobId);
  const pidPath = getPidPath(options.jobId);

  // Write prompt to file to avoid shell escaping issues with long prompts
  const promptFile = join(config.jobsDir, `${options.jobId}.prompt`);
  writeFileSync(promptFile, options.prompt);

  try {
    // Build command flags for codex exec --json (prompt passed separately via env var)
    // --ephemeral prevents session file conflicts when running multiple agents
    const flagArgs = [
      "exec", "--json",
      "--ephemeral",
      "-m", options.model,
      "-c", `model_reasoning_effort=${options.reasoningEffort}`,
      "-s", options.sandbox,
      "--full-auto",
    ];

    // Use bash to spawn codex in the background with shell-level redirection.
    // This is the most reliable cross-platform approach:
    // - Shell handles stdout/stderr redirection (not Bun/Node file handles)
    // - & backgrounds the process so bash exits immediately
    // - echo $! captures the background process PID
    // - Works on Linux, macOS, and Windows (MINGW/Git Bash)
    //
    // IMPORTANT: The prompt is passed via CODEX_PROMPT env var, NOT as a shell
    // argument. "$CODEX_PROMPT" in double quotes expands the variable but does
    // NOT re-interpret special characters ($, `, \) in the content. This avoids
    // all bash quoting issues with complex prompts containing SQL, markdown
    // backticks, nested quotes, etc.
    const shellArgs = flagArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const shellCmd = `codex ${shellArgs} "$CODEX_PROMPT" > '${jsonlPath.replace(/\\/g, "/")}' 2> '${stderrPath.replace(/\\/g, "/")}' & echo $!`;

    const result = spawnSync("bash", ["-c", shellCmd], {
      cwd: options.cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CODEX_PROMPT: options.prompt },
    });

    if (result.status !== 0) {
      throw new Error(`Failed to spawn codex: ${result.stderr || "unknown error"}`);
    }

    const pid = parseInt((result.stdout as string).trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error(`Failed to get PID from spawn: stdout=${result.stdout}`);
    }

    writeFileSync(pidPath, String(pid));

    return { pid, jobId: options.jobId, success: true };
  } catch (err) {
    return {
      pid: 0,
      jobId: options.jobId,
      success: false,
      error: (err as Error).message,
    };
  }
}

// --- Process Management ---

/**
 * Check if a process with the given PID is still running.
 * Cross-platform: uses process.kill(pid, 0) signal check.
 */
export function isRunning(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a running process by PID.
 */
export function killProcess(pid: number): boolean {
  if (!isRunning(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/**
 * Get stored PID for a job from the .pid file.
 */
export function getStoredPid(jobId: string): number | null {
  const pidPath = getPidPath(jobId);
  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// --- JSONL Parsing ---

/**
 * Parse a single JSON line, returning null on failure.
 */
function parseLine(line: string): ExecEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as ExecEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse all events from a JSONL file.
 */
export function parseJSONL(jobId: string): ExecEvent[] {
  const filePath = getJsonlPath(jobId);
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const events: ExecEvent[] = [];

    for (const line of lines) {
      const event = parseLine(line);
      if (event) events.push(event);
    }

    return events;
  } catch {
    return [];
  }
}

/**
 * Get the last N events from a JSONL file.
 */
export function getEvents(jobId: string, count: number = 50): ExecEvent[] {
  const all = parseJSONL(jobId);
  if (count >= all.length) return all;
  return all.slice(-count);
}

/**
 * Get all events from a JSONL file.
 */
export function getAllEvents(jobId: string): ExecEvent[] {
  return parseJSONL(jobId);
}

/**
 * Get the most recent event from a JSONL file.
 */
export function getLastEvent(jobId: string): ExecEvent | null {
  const filePath = getJsonlPath(jobId);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trimEnd().split("\n");

    // Walk backwards to find last valid JSON line
    for (let i = lines.length - 1; i >= 0; i--) {
      const event = parseLine(lines[i]);
      if (event) return event;
    }

    return null;
  } catch {
    return null;
  }
}

// --- Event Analysis ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract list of files modified from JSONL events.
 * Looks for apply_patch tool calls and file_change events.
 */
export function extractFilesModified(events: ExecEvent[]): string[] {
  const files = new Set<string>();

  for (const event of events) {
    // Check for file_change events
    if (event.type === "file_change" && typeof event.file === "string") {
      files.add(event.file);
    }

    // Check for apply_patch tool calls in response_item events
    if (event.type === "response_item") {
      const payload = isRecord(event.payload) ? event.payload : event;
      const payloadType = typeof payload.type === "string" ? payload.type : null;
      const toolName = typeof payload.name === "string" ? payload.name : null;

      if ((payloadType === "custom_tool_call" || payloadType === "function_call") && toolName === "apply_patch") {
        const input = payload.input ?? payload.arguments;
        if (typeof input === "string") {
          const patchFiles = extractFilesFromPatch(input);
          for (const f of patchFiles) files.add(f);
        }
      }
    }
  }

  return Array.from(files);
}

/**
 * Extract files from patch text (apply_patch format).
 */
function extractFilesFromPatch(patchText: string): string[] {
  const files: string[] = [];
  const prefixes = [
    "*** Update File: ",
    "*** Add File: ",
    "*** Delete File: ",
    "*** Move to: ",
  ];

  for (const line of patchText.split("\n")) {
    for (const prefix of prefixes) {
      if (!line.startsWith(prefix)) continue;
      const file = line.slice(prefix.length).trim();
      if (file) files.push(file);
    }
  }

  return files;
}

/**
 * Extract token usage from JSONL events.
 * Looks for token_count event messages and turn.completed events.
 */
export function extractTokenUsage(events: ExecEvent[]): { input: number; output: number } | null {
  let totalInput = 0;
  let totalOutput = 0;
  let found = false;

  for (const event of events) {
    // Look for token_count event messages
    if (event.type === "event_msg") {
      const payload = isRecord(event.payload) ? event.payload : null;
      if (payload && payload.type === "token_count" && isRecord(payload.info)) {
        const usage = payload.info.total_token_usage;
        if (isRecord(usage)) {
          const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
          const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
          if (input > 0 || output > 0) {
            totalInput = input;
            totalOutput = output;
            found = true;
          }
        }
      }
    }

    // Also check turn.completed events
    if (event.type === "turn.completed" || event.type === "response.completed") {
      const usage = isRecord(event.usage) ? event.usage : null;
      if (usage) {
        const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
        const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
        if (input > 0 || output > 0) {
          totalInput = input;
          totalOutput = output;
          found = true;
        }
      }
    }
  }

  return found ? { input: totalInput, output: totalOutput } : null;
}

// --- Completion Detection ---

/**
 * Check if a codex exec session has completed based on JSONL events.
 * Returns "completed", "failed", or null (still running).
 */
export function detectCompletion(jobId: string): "completed" | "failed" | null {
  const lastEvent = getLastEvent(jobId);
  if (!lastEvent) return null;

  // Check for explicit completion/failure events
  if (lastEvent.type === "turn.completed" || lastEvent.type === "task.completed") {
    return "completed";
  }

  if (lastEvent.type === "turn.failed" || lastEvent.type === "task.failed" || lastEvent.type === "error") {
    return "failed";
  }

  return null;
}

/**
 * Check if codex CLI is available.
 */
export function isCodexAvailable(): boolean {
  const result = spawnSync("codex", ["--version"], { stdio: "pipe" });
  return result.status === 0;
}

/**
 * Get codex CLI version string.
 */
export function getCodexVersion(): string | null {
  const result = spawnSync("codex", ["--version"], { stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) return null;
  return (result.stdout as string).trim();
}

/**
 * Get raw JSONL content as formatted text for display.
 */
export function getFormattedOutput(jobId: string, lines?: number): string | null {
  const events = lines ? getEvents(jobId, lines) : getAllEvents(jobId);
  if (events.length === 0) return null;

  const formatted: string[] = [];
  for (const event of events) {
    formatted.push(formatEvent(event));
  }

  return formatted.join("\n");
}

/**
 * Format a single event for human-readable display.
 */
export function formatEvent(event: ExecEvent): string {
  const type = event.type || "unknown";

  // Handle message events
  if (type === "response_item") {
    const payload = isRecord(event.payload) ? event.payload : event;
    if (payload.role === "assistant") {
      const content = payload.content;
      if (Array.isArray(content)) {
        const texts = content
          .filter((c: unknown) => isRecord(c) && (c.type === "output_text" || c.type === "text"))
          .map((c: unknown) => (c as Record<string, unknown>).text)
          .filter((t: unknown) => typeof t === "string");
        if (texts.length > 0) return `[assistant] ${texts.join("")}`;
      }
    }
    const payloadType = isRecord(payload) ? payload.type : null;
    const name = isRecord(payload) ? payload.name : null;
    if (payloadType === "custom_tool_call" || payloadType === "function_call") {
      return `[tool] ${name || "unknown"}`;
    }
  }

  if (type === "event_msg") {
    const payload = isRecord(event.payload) ? event.payload : null;
    if (payload) {
      const msg = typeof payload.message === "string" ? payload.message : "";
      return `[event] ${payload.type || type}: ${msg}`.trim();
    }
  }

  // Default: compact JSON
  return `[${type}] ${JSON.stringify(event).slice(0, 200)}`;
}

/**
 * Get stderr output for a job (useful for debugging).
 */
export function getStderrOutput(jobId: string): string | null {
  const stderrPath = getStderrPath(jobId);
  try {
    return readFileSync(stderrPath, "utf-8");
  } catch {
    return null;
  }
}
