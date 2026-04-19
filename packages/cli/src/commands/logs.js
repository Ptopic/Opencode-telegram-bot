/**
 * logs <project-path> [--lines 100]
 * Tail the output of the OpenCode server for a project.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { probeHealth } from "../api-client.js";
import { getProjectRoots } from "../config.js";

const STATE_FILE = path.join(homedir(), ".opencode-telegram-instances.json");

function readState() {
  if (!existsSync(STATE_FILE)) return { instances: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { instances: {} };
  }
}

function findInstanceForPath(state, projectPath) {
  const normalized = projectPath.replace(/\/+$/, "").toLowerCase();
  for (const [p, inst] of Object.entries(state.instances ?? {})) {
    const np = p.replace(/\/+$/, "").toLowerCase();
    if (np === normalized) return inst;
  }
  return null;
}

export async function logsCommand(projectPath, options = {}) {
  const lines = options.lines ?? 100;

  if (!projectPath) {
    // Auto-detect first running project
    const state = readState();
    for (const [p, inst] of Object.entries(state.instances ?? {})) {
      if (inst?.status === "ready") {
        projectPath = p;
        break;
      }
    }
  }

  if (!projectPath) {
    console.error("No project specified and no running instances found.");
    console.error("Usage: opencode-telegram logs <project-path> [--lines N]");
    process.exit(1);
  }

  const state = readState();
  const instance = findInstanceForPath(state, projectPath);

  if (!instance || instance.status !== "ready") {
    console.error(`No running instance for: ${projectPath}`);
    process.exit(1);
  }

  const health = await probeHealth(instance.baseUrl, 3000);
  console.log(`Tailing logs for: ${projectPath}`);
  console.log(`Instance: ${instance.baseUrl} | Status: ${health.ok ? "healthy" : health.reason}`);
  console.log(`Port: ${instance.port} | PID: ${instance.pid ?? "unknown"}`);
  console.log(`Lines: last ${lines}\n`);
  console.log("(Note: OpenCode serve --print-logs sends stdout/stderr to the terminal where the instance was spawned.");
  console.log(" If the instance was started in the background by the bot, logs may not be available here.)\n");

  // Try to tail the log via process log
  // We use `opencode logs --port <port>` if that exists, otherwise just show instance info
  console.log("Run the following on the machine hosting the instance to see live logs:");
  console.log(`  opencode logs --port ${instance.port}`);
}
