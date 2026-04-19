/**
 * session list / session switch / session new
 */
import { createSession, getSession, listSessions } from "../api-client.js";
import { getActiveSession, getInstance, setActiveSession } from "../db.js";

/**
 * List sessions for a project.
 */
export async function listSessionsCommand(projectPath) {
  if (!projectPath) {
    console.error("Usage: opencode-telegram session list <project-path>");
    process.exit(1);
  }

  const instance = getInstance(projectPath);

  if (!instance || instance.status !== "ready") {
    console.log("No running OpenCode instance found for this project. Start it with 'opencode-telegram start' from Telegram.");
    return;
  }

  const sessions = await listSessions(instance.base_url);

  if (!sessions.length) {
    console.log("No sessions found.");
    return;
  }

  const currentId = findCurrentSessionId(projectPath);

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

  const instance = getInstance(projectPath);

  if (!instance || instance.status !== "ready") {
    console.error("No running OpenCode instance found for this project.");
    process.exit(1);
  }

  // Verify session exists
  try {
    await getSession(instance.base_url, targetSessionId);
  } catch {
    console.error(`Session '${targetSessionId}' not found on this instance.`);
    process.exit(1);
  }

  // Persist the active session, preserving any existing mode
  setActiveSession(projectPath, {
    sessionId: targetSessionId,
    mode: getActiveSession(projectPath)?.mode,
  });

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

  const instance = getInstance(projectPath);

  if (!instance || instance.status !== "ready") {
    console.error("No running OpenCode instance found for this project.");
    process.exit(1);
  }

  const title = `cli-session-${Date.now()}`;
  const session = await createSession(instance.base_url, { title, directory: projectPath, cwd: projectPath });

  console.log(`Created session: ${session.id}`);
  console.log(`  Title: ${title}`);
  console.log(`  Project: ${projectPath}`);

  // Auto-select it, preserving any existing mode
  setActiveSession(projectPath, {
    sessionId: session.id,
    mode: getActiveSession(projectPath)?.mode,
  });
}

function findCurrentSessionId(projectPath) {
  const active = getActiveSession(projectPath);
  if (!active) return null;
  return active.sessionId ?? null;
}