/**
 * stop [--project <path>]
 * Aborts current execution in a project's active session.
 */
import { getActiveSession, getInstance, listInstances } from "../db.js";
import { abortSession } from "../api-client.js";

/**
 * @param {string} [projectPath]
 */
export async function stopCommand(projectPath) {
  if (!projectPath) {
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
    process.exit(1);
  }

  const instance = getInstance(projectPath);

  if (!instance || instance.status !== "ready") {
    console.error(`No running OpenCode instance for: ${projectPath}`);
    process.exit(1);
  }

  const activeSession = getActiveSession(projectPath);
  if (!activeSession) {
    console.error("No active session set for this project.");
    process.exit(1);
  }

  const sessionId = activeSession.sessionId;
  await abortSession(instance.base_url, sessionId);
  console.log(`Abort sent to session ${sessionId}`);
}