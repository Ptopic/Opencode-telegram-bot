/**
 * session list / session switch / session new
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { listSessions, createSession, getSession, deleteSession } from "../api-client.js";

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

/**
 * List sessions for a project.
 */
export async function listSessionsCommand(projectPath) {
  if (!projectPath) {
    console.error("Usage: opencode-telegram session list <project-path>");
    process.exit(1);
  }

  const state = readState();
  const instance = findInstanceForPath(state, projectPath);

  if (!instance || instance.status !== "ready") {
    console.log("No running OpenCode instance found for this project. Start it with 'opencode-telegram start' from Telegram.");
    return;
  }

  const sessions = await listSessions(instance.baseUrl);

  if (!sessions.length) {
    console.log("No sessions found.");
    return;
  }

  const currentId = findCurrentSessionId(state, projectPath);

  console.log(`Sessions for ${projectPath}:`);
  for (const s of sessions) {
    const marker = s.id === currentId ? " ●" : " ○";
    const title = typeof s.title === "string" ? s.title : s.id;
    console.log(`  ${marker} ${title} (${s.id})`);
  }
}

/**
 * Switch to a different session for a project.
 */
export async function switchSessionCommand(projectPath, targetSessionId) {
  if (!projectPath || !targetSessionId) {
    console.error("Usage: opencode-telegram session switch <project-path> <session-id>");
    process.exit(1);
  }

  const state = readState();
  const instance = findInstanceForPath(state, projectPath);

  if (!instance || instance.status !== "ready") {
    console.error("No running OpenCode instance found for this project.");
    process.exit(1);
  }

  // Verify session exists
  try {
    await getSession(instance.baseUrl, targetSessionId);
  } catch {
    console.error(`Session '${targetSessionId}' not found on this instance.`);
    process.exit(1);
  }

  // Persist the active session
  state.activeSession = state.activeSession ?? {};
  state.activeSession[projectPath] = targetSessionId;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`Switched to session ${targetSessionId} for ${projectPath}`);
}

/**
 * Create a new session for a project.
 */
export async function newSessionCommand(projectPath) {
  if (!projectPath) {
    console.error("Usage: opencode-telegram session new <project-path>");
    process.exit(1);
  }

  const state = readState();
  const instance = findInstanceForPath(state, projectPath);

  if (!instance || instance.status !== "ready") {
    console.error("No running OpenCode instance found for this project.");
    process.exit(1);
  }

  const title = `cli-session-${Date.now()}`;
  const session = await createSession(instance.baseUrl, { title, directory: projectPath, cwd: projectPath });

  console.log(`Created session: ${session.id}`);
  console.log(`  Title: ${title}`);
  console.log(`  Project: ${projectPath}`);

  // Auto-select it
  state.activeSession = state.activeSession ?? {};
  state.activeSession[projectPath] = session.id;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function findCurrentSessionId(state, projectPath) {
  return state?.activeSession?.[projectPath] ?? null;
}
