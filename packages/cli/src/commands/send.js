/**
 * send <prompt> [--project <path>]
 * Sends a prompt to the active session of a project and prints the reply.
 * Automatically uses the mode set via `opencode-telegram mode <index>`.
 */
import { listSessions, sendPrompt } from "../api-client.js";
import { getActiveSession, getInstance, listInstances } from "../db.js";

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
    const instances = listInstances();
    for (const inst of instances) {
      if (inst?.status === "ready") {
        projectPath = inst.project_path;
        break;
      }
    }
  }

  if (!projectPath) {
    console.error("No project specified and no running instances found.");
    console.error("Usage: opencode-telegram send <prompt> [--project <path>]");
    process.exit(1);
  }

  const instance = getInstance(projectPath);

  if (!instance || instance.status !== "ready") {
    console.error(`No running OpenCode instance found for: ${projectPath}`);
    process.exit(1);
  }

  const sessionData = getActiveSession(projectPath);
  let targetSessionId = sessionData?.sessionId;

  if (!targetSessionId) {
    // Pick the most recent session
    const sessions = await listSessions(instance.base_url);
    if (!sessions.length) {
      console.error("No sessions found. Create one first with 'opencode-telegram session new'.");
      process.exit(1);
    }
    targetSessionId = sessions[sessions.length - 1].id;
  }

  // Auto-use the mode saved via `opencode-telegram mode <index>`
  const agent = sessionData?.mode ?? null;

  console.error(`Sending to session ${targetSessionId} on ${instance.base_url}${agent ? ` (mode: ${agent})` : ""}...`);

  try {
    const reply = await sendPrompt(instance.base_url, targetSessionId, prompt, agent);
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