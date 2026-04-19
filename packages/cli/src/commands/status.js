/**
 * status — show all running instances, active sessions, and their health
 */
import { listInstances, getActiveSession } from "../db.js";
import { getProjectRoots } from "../config.js";
import { probeHealth } from "../api-client.js";

export async function statusCommand() {
  const roots = getProjectRoots();
  const instances = listInstances();

  console.log("=== OpenCode Instance Status ===\n");

  if (instances.length === 0) {
    console.log("No running instances.");
  }

  for (const instance of instances) {
    if (!instance?.baseUrl) continue;

    const health = await probeHealth(instance.baseUrl, 3000);
    const isHealthy = health.ok;
    const status = isHealthy
      ? `● running (${instance.baseUrl})`
      : `✗ unhealthy — ${health.reason ?? "unknown"}`;

    const activeSessionId = getActiveSession(instance.projectPath);
    const activeSession = activeSessionId
      ? `\n    Active session: ${activeSessionId}`
      : "\n    No active session";

    const version = health.version ? `  version: ${health.version}` : "";

    console.log(`Project: ${instance.projectPath}`);
    console.log(`  ${status}${version}`);
    console.log(`  pid: ${instance.pid ?? "unknown"}${activeSession}`);
    console.log(`  started: ${instance.startedAt ? new Date(instance.startedAt).toLocaleString() : "unknown"}`);
    console.log();
  }

  console.log("=== Project Roots ===");
  for (const root of roots) {
    console.log(`  ${root.label} (${root.scope}): ${root.path}`);
  }
}