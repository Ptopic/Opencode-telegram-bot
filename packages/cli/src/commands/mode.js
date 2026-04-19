/**
 * mode <index_or_name> [--project <path>]
 * Sets the agent mode for the active session.
 * Use `mode list` to see available modes with their indices.
 */
import { listModes, setMode } from "../api-client.js";
import { getActiveSession, getInstance, listInstances } from "../db.js";

/**
 * Find a ready instance for the given project path.
 * If no projectPath given, finds the active session's project or any ready instance.
 */
function resolveProjectPath(projectPath) {
	if (projectPath) {
		const instance = getInstance(projectPath);
		if (instance?.status === "ready") return projectPath;
		return null;
	}

	// Prefer active session's project, then any ready instance
	const instances = listInstances();
	const activeProject = instances.find(
		(p) => p.status === "ready" && getActiveSession(p.project_path)?.sessionId,
	);
	if (activeProject) return activeProject.project_path;

	const anyReady = instances.find((p) => p.status === "ready");
	return anyReady?.project_path ?? null;
}

/**
 * List available modes with their indices.
 */
export async function listModesCommand(projectPath) {
	const resolvedPath = resolveProjectPath(projectPath);

	if (!resolvedPath) {
		console.error("No project specified and no running instances found.");
		process.exit(1);
	}

	const instance = getInstance(resolvedPath);

	if (!instance || instance.status !== "ready") {
		console.error(`No running OpenCode instance for: ${resolvedPath}`);
		process.exit(1);
	}

	const modes = await listModes(instance.base_url);

	if (!modes.length) {
		console.log("No modes available.");
		return;
	}

	const activeSession = getActiveSession(resolvedPath);
	const currentMode = activeSession?.mode;

	console.log(`Available modes for ${resolvedPath}:`);
	modes.forEach((m, i) => {
		const name = typeof m === "string" ? m : m.name;
		const desc =
			typeof m === "object" && m.description ? ` — ${m.description}` : "";
		const marker = name === currentMode ? " ✅" : "";
		console.log(`  ${i}  ${name}${desc}${marker}`);
	});
	console.log(
		"\nSwitch with: opencode-telegram mode <index> [--project <path>]",
	);
}

/**
 * Set the active mode by index number or name.
 * @param {string} modeArg - numeric index or agent name
 * @param {string} [projectPath]
 */
export async function setModeCommand(modeArg, projectPath) {
	if (!modeArg) {
		console.error(
			"Usage: opencode-telegram mode <index_or_name> [--project <path>]",
		);
		console.error("       opencode-telegram mode list [--project <path>]");
		process.exit(1);
	}

	if (modeArg === "list") {
		return listModesCommand(projectPath);
	}

	const resolvedPath = resolveProjectPath(projectPath);

	if (!resolvedPath) {
		console.error("No project specified and no running instances found.");
		process.exit(1);
	}

	const instance = getInstance(resolvedPath);

	if (!instance || instance.status !== "ready") {
		console.error(`No running OpenCode instance for: ${resolvedPath}`);
		process.exit(1);
	}

	// Resolve mode: if numeric index, look it up; otherwise use as agent name
	const modes = await listModes(instance.base_url);
	if (!modes.length) {
		console.error("No modes available from OpenCode.");
		process.exit(1);
	}

	let resolvedName = modeArg;
	const numericIndex = Number(modeArg);
	if (!Number.isNaN(numericIndex) && Number.isInteger(numericIndex)) {
		if (numericIndex < 0 || numericIndex >= modes.length) {
			console.error(
				`Invalid mode index: ${modeArg}. Available range: 0-${modes.length - 1}`,
			);
			process.exit(1);
		}
		resolvedName = modes[numericIndex].name;
	}

	// Persist the selected mode for this project in db
	setMode(resolvedPath, resolvedName);

	// Also update the active session if one exists
	const activeSession = getActiveSession(resolvedPath);
	if (activeSession?.sessionId) {
		await setMode(instance.base_url, activeSession.sessionId, resolvedName);
	}

	console.log(`Mode set to: ${resolvedName}`);
}
