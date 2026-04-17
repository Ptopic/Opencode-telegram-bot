/**
 * stop [--project <path>]
 * Aborts current execution in a project's active session.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { abortSession } from "../api-client.js";

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
 * @param {string} [projectPath]
 */
export async function stopCommand(projectPath) {
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
    console.error("No active session set for this project.");
    process.exit(1);
  }

  await abortSession(instance.baseUrl, sessionId);
  console.log(`Abort sent to session ${sessionId}`);
}
