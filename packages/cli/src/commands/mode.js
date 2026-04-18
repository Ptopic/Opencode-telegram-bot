/**
 * mode <index_or_name> [--project <path>]
 * Sets the agent mode for the active session.
 * Use `mode list` to see available modes with their indices.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
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

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("Failed to save state:", err.message);
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
 * List available modes with their indices.
 */
export async function listModesCommand(projectPath) {
  if (!projectPath) {
    const state = readState();
    // Prefer active session's project, then any ready instance
    const activeProject = Object.keys(state.activeSession ?? {}).find(
      (p) => state.instances?.[p]?.status === "ready"
    );
    projectPath = activeProject ?? (() => {
      for (const [p, inst] of Object.entries(state.instances ?? {})) {
        if (inst?.status === "ready") return p;
      }
      return null;
    })();
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

  const currentMode = state?.activeSession?.[projectPath]?.mode;

  console.log(`Available modes for ${projectPath}:`);
  modes.forEach((m, i) => {
    const name = typeof m === "string" ? m : m.name;
    const desc = typeof m === "object" && m.description ? ` — ${m.description}` : "";
    const marker = name === currentMode ? " ✅" : "";
    console.log(`  ${i}  ${name}${desc}${marker}`);
  });
  console.log("\nSwitch with: opencode-telegram mode <index> [--project <path>]");
}

/**
 * Set the active mode by index number or name.
 * @param {string} modeArg - numeric index or agent name
 * @param {string} [projectPath]
 */
export async function setModeCommand(modeArg, projectPath) {
  if (!modeArg) {
    console.error("Usage: opencode-telegram mode <index_or_name> [--project <path>]");
    console.error("       opencode-telegram mode list [--project <path>]");
    process.exit(1);
  }

  if (modeArg === "list") {
    return listModesCommand(projectPath);
  }

  if (!projectPath) {
    const state = readState();
    // Prefer active session's project, then any ready instance
    const activeProject = Object.keys(state.activeSession ?? {}).find(
      (p) => state.instances?.[p]?.status === "ready"
    );
    projectPath = activeProject ?? (() => {
      for (const [p, inst] of Object.entries(state.instances ?? {})) {
        if (inst?.status === "ready") return p;
      }
      return null;
    })();
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

  // Resolve mode: if numeric index, look it up; otherwise use as agent name
  const modes = await listModes(instance.baseUrl);
  if (!modes.length) {
    console.error("No modes available from OpenCode.");
    process.exit(1);
  }

  let resolvedName = modeArg;
  const numericIndex = Number(modeArg);
  if (!isNaN(numericIndex) && Number.isInteger(numericIndex)) {
    if (numericIndex < 0 || numericIndex >= modes.length) {
      console.error(`Invalid mode index: ${modeArg}. Available range: 0-${modes.length - 1}`);
      process.exit(1);
    }
    resolvedName = modes[numericIndex].name;
  }

  // Persist the selected mode for this project in state
  if (!state.activeSession) state.activeSession = {};
  if (!state.activeSession[projectPath]) state.activeSession[projectPath] = {};
  state.activeSession[projectPath].mode = resolvedName;
  saveState(state);

  // Also update the active session if one exists
  const sessionId = state.activeSession?.[projectPath]?.sessionId;
  if (sessionId) {
    await setMode(instance.baseUrl, sessionId, resolvedName);
  }

  console.log(`Mode set to: ${resolvedName}`);
}
