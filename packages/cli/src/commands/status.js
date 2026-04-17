/**
 * status — show all running instances, active sessions, and their health
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { probeHealth } from "../api-client.js";
import { getProjectRoots } from "../config.js";

const STATE_FILE = path.join(homedir(), ".opencode-telegram-instances.json");

function readState() {
  if (!existsSync(STATE_FILE)) return { instances: {}, activeSession: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { instances: {}, activeSession: {} };
  }
}

export async function statusCommand() {
  const state = readState();
  const roots = getProjectRoots();

  console.log("=== OpenCode Instance Status ===\n");

  if (Object.keys(state.instances ?? {}).length === 0) {
    console.log("No running instances.");
  }

  let anyRunning = false;

  for (const [projectPath, instance] of Object.entries(state.instances ?? {})) {
    if (!instance?.baseUrl) continue;

    const health = await probeHealth(instance.baseUrl, 3000);
    const isHealthy = health.ok;
    const status = isHealthy
      ? `● running (${instance.baseUrl})`
      : `✗ unhealthy — ${health.reason ?? "unknown"}`;

    const activeSessionId = state?.activeSession?.[projectPath];
    const activeSession = activeSessionId
      ? `\n    Active session: ${activeSessionId}`
      : "\n    No active session";

    const version = health.version ? `  version: ${health.version}` : "";

    console.log(`Project: ${projectPath}`);
    console.log(`  ${status}${version}`);
    console.log(`  pid: ${instance.pid ?? "unknown"}${activeSession}`);
    console.log(`  started: ${instance.startedAt ? new Date(instance.startedAt).toLocaleString() : "unknown"}`);
    console.log();

    anyRunning = true;
  }

  console.log("=== Project Roots ===");
  for (const root of roots) {
    console.log(`  ${root.label} (${root.scope}): ${root.path}`);
  }
}
