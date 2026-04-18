/**
 * send <prompt> [--project <path>]
 * Sends a prompt to the active session of a project and prints the reply.
 * Automatically uses the mode set via `opencode-telegram mode <index>`.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { listSessions, sendPrompt } from "../api-client.js";

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
 * @param {string} prompt
 * @param {string} [projectPath]
 */
export async function sendPromptCommand(prompt, projectPath) {
  if (!prompt) {
    console.error("Usage: opencode-telegram send <prompt> [--project <path>]");
    process.exit(1);
  }

  if (!projectPath) {
    // Find the first running project
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
    console.error("Usage: opencode-telegram send <prompt> [--project <path>]");
    process.exit(1);
  }

  const state = readState();
  const instance = findInstanceForPath(state, projectPath);

  if (!instance || instance.status !== "ready") {
    console.error(`No running OpenCode instance found for: ${projectPath}`);
    process.exit(1);
  }

  const sessionData = state?.activeSession?.[projectPath];
  let targetSessionId = sessionData?.sessionId;

  if (!targetSessionId) {
    // Pick the most recent session
    const sessions = await listSessions(instance.baseUrl);
    if (!sessions.length) {
      console.error("No sessions found. Create one first with 'opencode-telegram session new'.");
      process.exit(1);
    }
    targetSessionId = sessions[sessions.length - 1].id;
  }

  // Auto-use the mode saved via `opencode-telegram mode <index>`
  const agent = sessionData?.mode ?? null;

  console.error(`Sending to session ${targetSessionId} on ${instance.baseUrl}${agent ? ` (mode: ${agent})` : ""}...`);

  try {
    const reply = await sendPrompt(instance.baseUrl, targetSessionId, prompt, agent);
    if (reply) {
      console.log(reply);
    } else {
      console.error("(no reply)");
    }
  } catch (err) {
    console.error(`Error: ${err?.response?.data?.message ?? err?.message ?? err}`);
    process.exit(1);
  }
}
