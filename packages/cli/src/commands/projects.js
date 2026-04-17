/**
 * projects list / projects select
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
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

/**
 * List all known projects and their running status.
 */
export async function listProjects() {
  const state = readState();
  const rows = [];

  for (const root of getProjectRoots()) {
    rows.push({ type: "root", scope: root.scope, path: root.path, label: root.label });
    // Discover sub-projects under each root
    try {
      const entries = readdirSync(root.path, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectPath = path.join(root.path, entry.name);
        const instance = state.instances[projectPath];
        let status = "stopped";
        if (instance?.status === "ready" && instance?.baseUrl) {
          const health = await probeHealth(instance.baseUrl);
          status = health.ok ? `running ${instance.baseUrl}` : `unhealthy (${health.reason})`;
        }
        rows.push({ type: "project", scope: root.scope, path: projectPath, label: entry.name, status });
      }
    } catch (err) {
      rows.push({ type: "project", scope: root.scope, path: root.path, label: "(cannot read root)", status: "error" });
    }
  }

  // Print
  for (const row of rows) {
    if (row.type === "root") {
      console.log(`\n${row.label} (${row.scope}):`);
    } else {
      const pad = row.status === "stopped" ? "  ○" : row.status.startsWith("running") ? "  ●" : "  ✗";
      console.log(`  ${pad} ${row.label}`);
      if (row.status !== "stopped") {
        console.log(`      ${row.status}`);
      }
    }
  }
}
