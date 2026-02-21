// Configuration for codex-agent

import { homedir } from "os";

export const config = {
  // Default model — override with CODEX_MODEL env var
  model: process.env.CODEX_MODEL ?? "gpt-5.3-codex",

  // Reasoning effort levels — override default with CODEX_REASONING env var
  reasoningEfforts: ["low", "medium", "high", "xhigh"] as const,
  defaultReasoningEffort: (process.env.CODEX_REASONING ?? "xhigh") as "low" | "medium" | "high" | "xhigh",

  // Sandbox modes
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"] as const,
  defaultSandbox: "workspace-write" as const,

  // Job storage directory
  jobsDir: `${homedir()}/.codex-agent/jobs`,

  // Default inactivity timeout in minutes for running jobs
  defaultTimeout: 60,

  // Default number of jobs to show in listings
  jobsListLimit: 20,

};

export type ReasoningEffort = typeof config.reasoningEfforts[number];
export type SandboxMode = typeof config.sandboxModes[number];
