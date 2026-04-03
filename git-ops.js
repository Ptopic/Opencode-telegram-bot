import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

const DEFAULT_TIMEOUT_MS = 120000;
const GIT_BINARY_CANDIDATES = [
	process.env.GIT_BINARY,
	"git",
	"/usr/bin/git",
	"/usr/local/bin/git",
].filter(Boolean);

function buildGitError(args, cwd, code, stdout, stderr, timedOut = false) {
	const detail = sanitizeCredentials((stderr || stdout || "Git command failed")).trim();
	const prefix = timedOut ? "Git command timed out" : `Git command failed (${code ?? "unknown"})`;
	const safeArgs = args.map(a => sanitizeCredentials(a));
	const error = new Error(`${prefix}: git ${safeArgs.join(" ")} (${cwd})\n${detail}`.trim());
	error.code = code;
	error.stdout = sanitizeCredentials(stdout);
	error.stderr = sanitizeCredentials(stderr);
	error.timedOut = timedOut;
	return error;
}

function buildGitBinaryNotFoundError(cwd) {
	const error = new Error(
		`Git binary not found for working directory ${cwd}. Install git in this runtime or set GIT_BINARY. If you are using Docker Compose, rebuild the telegram-bot container with the updated image.`,
	);
	error.code = "GIT_BINARY_NOT_FOUND";
	return error;
}

export function getAvailableGitBinary() {
	for (const binary of GIT_BINARY_CANDIDATES) {
		if (!binary) continue;
		if (!binary.startsWith("/")) return binary;
		if (existsSync(binary)) return binary;
	}
	return null;
}

export function sanitizeRepoDirectoryName(value) {
	const normalized = String(value ?? "")
		.trim()
		.replace(/\.git$/i, "")
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/^\.+/, "")
		.replace(/\.{2,}/g, ".");

	if (!normalized || normalized === "." || normalized === "..") {
		throw new Error("Invalid repository directory name");
	}

	return normalized;
}

export function buildAuthenticatedUrl(repoUrl) {
	const token = process.env.GITHUB_TOKEN;
	if (!token) return repoUrl;

	const url = String(repoUrl ?? "").trim();
	if (!/^https:\/\/github\.com\//i.test(url)) return url;
	if (url.includes("@github.com")) return url;

	return url.replace(/^https:\/\/github\.com\//i, `https://x-access-token:${token}@github.com/`);
}

function sanitizeCredentials(text) {
	return String(text ?? "").replace(/https:\/\/[^@/]+@github\.com\//gi, "https://github.com/");
}

export function deriveRepoDirectoryName(repoUrl) {
	const raw = String(repoUrl ?? "").trim();
	if (!raw) {
		throw new Error("Repository URL is required");
	}

	const withoutQuery = raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
	const lastSegment = withoutQuery.split("/").pop() || withoutQuery.split(":").pop() || withoutQuery;
	return sanitizeRepoDirectoryName(lastSegment);
}

export function resolveCloneTargetPath(rootPath, repoUrl, requestedName = "") {
	const normalizedRoot = path.resolve(String(rootPath ?? ""));
	if (!normalizedRoot || normalizedRoot === ".") {
		throw new Error("Clone root is not configured");
	}

	if (requestedName && /[\\/]/.test(requestedName)) {
		throw new Error("Invalid repository directory name");
	}

	const directoryName = sanitizeRepoDirectoryName(requestedName || deriveRepoDirectoryName(repoUrl));
	const targetPath = path.resolve(normalizedRoot, directoryName);
	if (targetPath !== normalizedRoot && !targetPath.startsWith(`${normalizedRoot}${path.sep}`)) {
		throw new Error("Clone destination must stay inside the configured workspace root");
	}

	return targetPath;
}

const HTTP_GIT_COMMANDS = new Set(["clone", "fetch", "pull", "push", "ls-remote", "submodule"]);

function buildGitArgsWithAuth(args) {
	const token = process.env.GITHUB_TOKEN;
	if (!token || args.length === 0 || !HTTP_GIT_COMMANDS.has(args[0])) {
		return args;
	}
	const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
	return ["-c", `http.https://github.com/.extraheader=Authorization: basic ${encoded}`, ...args];
}

export async function runGit(args, options = {}) {
	const cwd = String(options.cwd ?? "").trim();
	if (!cwd) {
		throw new Error("Git command requires a working directory");
	}

	const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, Math.floor(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
	const gitArgs = buildGitArgsWithAuth(args);
	let lastError = null;

	for (const binary of GIT_BINARY_CANDIDATES) {
		if (binary.startsWith("/") && !existsSync(binary)) {
			continue;
		}

		try {
			return await new Promise((resolve, reject) => {
				const child = spawn(binary, gitArgs, {
			cwd,
			env: {
				...process.env,
				GIT_PAGER: "cat",
				GIT_TERMINAL_PROMPT: "0",
				NO_COLOR: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
				});

				let stdout = "";
				let stderr = "";
				let finished = false;

				const timer = setTimeout(() => {
					if (finished) return;
					finished = true;
					child.kill("SIGTERM");
					reject(buildGitError(args, cwd, null, stdout, stderr, true));
				}, timeoutMs);

				child.stdout.on("data", (chunk) => {
					stdout += String(chunk);
				});

				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});

				child.on("error", (error) => {
					if (finished) return;
					finished = true;
					clearTimeout(timer);
					reject(error);
				});

				child.on("close", (code) => {
					if (finished) return;
					finished = true;
					clearTimeout(timer);
					resolve({ code, stdout, stderr, binary });
				});
			});
		} catch (error) {
			lastError = error;
			if (error?.code === "ENOENT") {
				continue;
			}
			throw error;
		}
	}

	throw lastError?.code === "ENOENT"
		? buildGitBinaryNotFoundError(cwd)
		: lastError ?? buildGitBinaryNotFoundError(cwd);
}

export async function runGitOrThrow(args, options = {}) {
	const result = await runGit(args, options);
	if (result.code !== 0) {
		throw buildGitError(args, options.cwd, result.code, result.stdout, result.stderr);
	}
	return result;
}

export async function getGitRepoRoot(cwd) {
	const result = await runGit(["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 15000 });
	if (result.code !== 0) return null;
	const value = result.stdout.trim();
	return value || null;
}

export async function isGitRepository(cwd) {
	return Boolean(await getGitRepoRoot(cwd));
}

export async function getCurrentBranch(cwd) {
	const result = await runGit(["branch", "--show-current"], { cwd, timeoutMs: 15000 });
	if (result.code !== 0) return null;
	const branch = result.stdout.trim();
	return branch || null;
}

export async function getUpstreamBranch(cwd) {
	const result = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
		cwd,
		timeoutMs: 15000,
	});
	if (result.code !== 0) return null;
	const upstream = result.stdout.trim();
	return upstream || null;
}
