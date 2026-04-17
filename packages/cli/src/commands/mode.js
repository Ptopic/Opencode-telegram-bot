/**
 * mode <name> [--project <path>]
 * Sets the agent mode for the active session.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { listModes, setMode, listSessions } from "../api-client.js";

const STATE_FILE = path.join(homedir(), ".opencode-telegram-instances.json");

function readState() {
  if (!existsSync(STATE_FILE)) return { instances: {}, activeSession: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { instances: {}, activeSession: {} };
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

/**
 * List available modes.
 */
export async function listModesCommand(projectPath) {
  if (!projectPath) {
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
    process.exit(1);
  }

  const state = readState();
  const instance = findInstanceForPath(state, projectPath);

  if (!instance || instance.status !== "ready") {
    console.error(`No running OpenCode instance for: ${projectPath}`);
    process.exit(1);
  }

  const modes = await listModes(instance.baseUrl);

  if (!modes.length) {
    console.log("No modes available.");
    return;
  }

  console.log(`Available modes for ${projectPath}:`);
  for (const m of modes) {
    const name = typeof m === "string" ? m : m.name;
    const desc = typeof m === "object" && m.description ? ` — ${m.description}` : "";
    console.log(`  • ${name}${desc}`);
  }
}

/**
 * Set the active mode.
 * @param {string} modeName
 * @param {string} [projectPath]
 */
export async function setModeCommand(modeName, projectPath) {
  if (!modeName) {
    console.error("Usage: opencode-telegram mode <name> [--project <path>]");
    console.error("       opencode-telegram mode list [--project <path>]");
    process.exit(1);
  }

  if (modeName === "list") {
    return listModesCommand(projectPath);
  }

  if (!projectPath) {
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
    process.exit(1);
  }

  const state = readState();
  const instance = findInstanceForPath(state, projectPath);

  if (!instance || instance.status !== "ready") {
    console.error(`No running OpenCode instance for: ${projectPath}`);
    process.exit(1);
  }

  const sessionId = state?.activeSession?.[projectPath];
  if (!sessionId) {
    // Try to use the latest session
    const sessions = await listSessions(instance.baseUrl);
    if (!sessions.length) {
      console.error("No sessions found. Create one first.");
      process.exit(1);
    }
    // Use the most recent session
    sessionId = sessions[sessions.length - 1].id;
  }

  await setMode(instance.baseUrl, sessionId, modeName);
  console.log(`Mode set to: ${modeName}`);
}
