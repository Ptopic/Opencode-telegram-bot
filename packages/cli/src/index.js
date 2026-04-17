#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { listProjects } from "./commands/projects.js";
import {
    listSessionsCommand,
    switchSessionCommand,
    newSessionCommand,
} from "./commands/session.js";
import { sendPromptCommand } from "./commands/send.js";
import { stopCommand } from "./commands/stop.js";
import { setModeCommand } from "./commands/mode.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// repoRoot: packages/cli/src/index.js -> packages/cli -> packages -> repo root
const repoRoot = path.resolve(__dirname, "../../..");
const packageRoot = path.resolve(__dirname, "..");

const INSTANCES_STATE_FILE = path.join(homedir(), ".opencode-telegram-instances.json");
const INSTANCE_PORT_START = Number(process.env.OPENCODE_INSTANCE_PORT_START) || 50000;
const INSTANCE_PORT_END = Number(process.env.OPENCODE_INSTANCE_PORT_END) || 59999;
const INSTANCE_STARTUP_TIMEOUT_MS = 30000;

function parseEnvFile(content) {
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!match) continue;

        const key = match[1];
        let value = match[2] ?? "";
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

function tryLoadEnv(filePath) {
    if (!filePath || !existsSync(filePath)) return false;

    try {
        const content = readFileSync(filePath, "utf8");
        parseEnvFile(content);
        return true;
    } catch (err) {
        console.warn(`Could not load env file: ${filePath} (${err?.message ?? "unknown error"})`);
        return false;
    }
}

const explicitEnv = process.env.OPENCODE_TELEGRAM_ENV_FILE;
if (explicitEnv) {
    tryLoadEnv(path.resolve(process.cwd(), explicitEnv));
} else {
    tryLoadEnv(path.resolve(repoRoot, ".env"));
    tryLoadEnv(path.resolve(repoRoot, "..", ".env"));
    tryLoadEnv(path.resolve(packageRoot, ".env"));
}

function hasChildExited(child) {
    return child.exitCode !== null || child.signalCode !== null;
}

function defaultAttachSessionTitle(projectDirectory) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${path.basename(projectDirectory) || "project"}-local-${timestamp}`;
}

function readInstanceState() {
    if (!existsSync(INSTANCES_STATE_FILE)) {
        return { instances: {} };
    }

    try {
        const content = readFileSync(INSTANCES_STATE_FILE, "utf8");
        const data = JSON.parse(content);
        return data;
    } catch {
        return { instances: {} };
    }
}

function findInstanceForDirectory(state, directory) {
    const normalizedDir = directory.replace(/\/+$/, "").toLowerCase();

    for (const [projectPath, instance] of Object.entries(state.instances || {})) {
        const normalizedProject = projectPath.replace(/\/+$/, "").toLowerCase();

        if (normalizedProject === normalizedDir || normalizedDir.startsWith(normalizedProject + "/")) {
            return { projectPath, ...instance };
        }
    }

    return null;
}

function saveInstanceState(state) {
    try {
        writeFileSync(INSTANCES_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
        console.warn("Failed to save instance state:", err?.message);
    }
}

async function allocatePort(state) {
    const usedPorts = new Set(
        Object.values(state.instances || {}).map((i) => i.port).filter(Boolean)
    );

    for (let port = INSTANCE_PORT_START; port <= INSTANCE_PORT_END; port++) {
        if (usedPorts.has(port)) continue;
        
        const inUse = await isPortInUse(port);
        if (!inUse) {
            return port;
        }
    }

    throw new Error("No available ports in range");
}

async function isPortInUse(port) {
    return new Promise((resolve) => {
        const socket = createConnection({ port, host: "127.0.0.1" }, () => {
            socket.end();
            resolve(true);
        });
        socket.once("error", () => {
            socket.destroy();
            resolve(false);
        });
    });
}

async function waitForPort(port, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        let settled = false;
        let retryTimer = null;

        const cleanup = () => {
            settled = true;
            if (retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
        };

        const tryConnect = () => {
            if (settled) return;

            const socket = createConnection({ port, host: "127.0.0.1" }, () => {
                cleanup();
                socket.end();
                resolve();
            });

            socket.once("error", () => {
                socket.destroy();
                if (settled) return;

                if (Date.now() >= deadline) {
                    cleanup();
                    reject(new Error(`Port ${port} did not become available within ${timeoutMs}ms`));
                } else {
                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        tryConnect();
                    }, 100);
                }
            });
        };

        tryConnect();
    });
}

async function probeHealth(baseUrl, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${baseUrl}/global/health`, {
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            return { ok: false, reason: `HTTP ${response.status}` };
        }

        const payload = await response.json().catch(() => null);
        const healthy = payload?.healthy === true;
        const version = typeof payload?.version === "string" ? payload.version : undefined;

        if (!healthy) {
            return { ok: false, reason: "Instance reported unhealthy" };
        }

        return { ok: true, version };
    } catch (err) {
        clearTimeout(timeoutId);
        return { ok: false, reason: err?.message || "Connection failed" };
    }
}

async function findExistingInstanceForProject(projectDirectory) {
    const state = readInstanceState();
    const instance = findInstanceForDirectory(state, projectDirectory);

    if (!instance || !instance.baseUrl) {
        return null;
    }

    const inUse = await isPortInUse(instance.port);
    if (!inUse) {
        return null;
    }

    const result = await probeHealth(instance.baseUrl, 2000);
    if (result.ok) {
        return instance;
    }

    return null;
}

async function spawnInstanceForProject(projectDirectory) {
    const existing = await findExistingInstanceForProject(projectDirectory);
    if (existing) {
        console.log(`Reusing existing instance: ${existing.baseUrl}`);
        return existing;
    }

    console.log(`Spawning new OpenCode instance for ${projectDirectory}...`);

    const state = readInstanceState();
    const port = await allocatePort(state);
    const baseUrl = `http://127.0.0.1:${port}`;

    return new Promise((resolve, reject) => {
        let stdoutBuffer = "";
        let portFound = false;
        let healthCheckInterval = null;
        let startupTimeout = null;
        let resolved = false;

        const cleanup = () => {
            if (healthCheckInterval) {
                clearInterval(healthCheckInterval);
                healthCheckInterval = null;
            }
            if (startupTimeout) {
                clearTimeout(startupTimeout);
                startupTimeout = null;
            }
        };

        startupTimeout = setTimeout(() => {
            if (!resolved && !portFound) {
                cleanup();
                resolved = true;
                child.kill("SIGKILL");
                reject(new Error(`OpenCode instance startup timeout after ${INSTANCE_STARTUP_TIMEOUT_MS}ms`));
            }
        }, INSTANCE_STARTUP_TIMEOUT_MS);

        const child = spawn("opencode", ["serve", "--port", String(port), "--print-logs"], {
            cwd: projectDirectory,
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
        });

        child.on("error", (err) => {
            cleanup();
            if (!resolved) {
                resolved = true;
                reject(err);
            }
        });

        child.on("exit", (code, signal) => {
            if (!resolved) {
                cleanup();
                resolved = true;
                const output = (stdoutBuffer + "\n" + stderrBuffer).trim();
                reject(new Error(`OpenCode process exited before startup: code=${code}, signal=${signal}\n${output}`));
            }
        });

        let stderrBuffer = "";

        child.stdout?.on("data", (data) => {
            const text = data.toString();
            stdoutBuffer += text;
            if (!portFound && /opencode server listening on/i.test(text)) {
                portFound = true;
            }
        });

        child.stderr?.on("data", (data) => {
            const text = data.toString();
            stderrBuffer += text;
            if (!portFound && /opencode server listening on/i.test(text)) {
                portFound = true;
            }
        });

        healthCheckInterval = setInterval(async () => {
            if (resolved) {
                cleanup();
                return;
            }

            if (!portFound) {
                const inUse = await isPortInUse(port);
                if (inUse) {
                    portFound = true;
                }
            }

            if (!portFound) return;

            try {
                const result = await probeHealth(baseUrl, 2000);

                if (result.ok) {
                    cleanup();
                    resolved = true;

                    state.instances[projectDirectory] = {
                        port,
                        baseUrl,
                        status: "ready",
                        pid: child.pid,
                        startedAt: Date.now(),
                    };
                    saveInstanceState(state);

                    console.log(`Instance ready: ${projectDirectory} -> ${baseUrl}`);
                    resolve({ baseUrl, pid: child.pid, port });
                }
            } catch {}
        }, 500);
    });
}

async function getOrCreateAttachBaseUrl(rawValue, projectDirectory) {
    if (rawValue) {
        const candidate = rawValue.trim();
        const parsed = new URL(candidate);
        return parsed.toString().replace(/\/+$/, "");
    }

    const state = readInstanceState();
    const instance = findInstanceForDirectory(state, projectDirectory);

    if (instance && instance.baseUrl && instance.status === "ready") {
        const result = await probeHealth(instance.baseUrl, 2000);
        if (result.ok) {
            console.log(`Found matching instance for ${projectDirectory}: ${instance.baseUrl}`);
            return instance.baseUrl;
        }
        console.log(`Instance found but not healthy, spawning new one...`);
    }

    console.log(`No matching instance found for ${projectDirectory}`);
    const newInstance = await spawnInstanceForProject(projectDirectory);
    return newInstance.baseUrl;
}

async function createSessionForCurrentDirectory(baseUrl, projectDirectory) {
    const response = await fetch(`${baseUrl}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title: defaultAttachSessionTitle(projectDirectory),
            directory: projectDirectory,
            cwd: projectDirectory,
        }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Session creation failed (${response.status}): ${body || "empty response"}`);
    }

    const payload = await response.json();
    const sessionId = payload?.id;
    if (typeof sessionId !== "string" || sessionId === "") {
        throw new Error("Session creation succeeded but no session id returned");
    }

    return sessionId;
}

function spawnChild(command, args, options) {
    return spawn(command, args, {
        stdio: "inherit",
        env: process.env,
        cwd: repoRoot,
        ...options,
    });
}

function waitForChildExit(child) {
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            resolve({ code, signal });
        });
    });
}

async function runManagedMode() {
    console.log("Starting Telegram bot with multi-instance mode...");
    console.log("Each project will get its own OpenCode server instance.");

    delete process.env.OPENCODE_BASE_URL;
    delete process.env.OPENCODE_URL;

    const botEntry = path.resolve(repoRoot, "packages", "bot", "src", "index.js");
    const bot = spawnChild(process.execPath, [botEntry]);

    const children = [
        { name: "Telegram bot", process: bot },
    ];

    let shutdownStarted = false;

    const shutdown = (reason) => {
        if (shutdownStarted) return;
        shutdownStarted = true;

        console.log(`Shutting down (${reason})...`);

        for (const child of children) {
            if (!hasChildExited(child.process)) {
                child.process.kill("SIGTERM");
            }
        }

        setTimeout(() => {
            for (const child of children) {
                if (!hasChildExited(child.process)) {
                    child.process.kill("SIGKILL");
                }
            }
        }, 5000).unref();
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    return await new Promise((resolve) => {
        let resolved = false;

        const finish = (code) => {
            if (resolved) return;
            resolved = true;
            resolve(code);
        };

        for (const child of children) {
            child.process.once("error", (err) => {
                console.error(`${child.name} failed to start: ${err?.message ?? "unknown error"}`);
                shutdown(`${child.name} error`);
                finish(1);
            });

            child.process.once("exit", (code, signal) => {
                if (shutdownStarted) {
                    if (children.every((entry) => hasChildExited(entry.process))) {
                        finish(typeof code === "number" ? code : 0);
                    }
                    return;
                }

                console.error(`${child.name} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`);
                shutdown(`${child.name} exited`);
                finish(typeof code === "number" ? code : 1);
            });
        }
    });
}

async function runAttachMode(rawBaseUrl) {
    const projectDirectory = path.resolve(process.env.INIT_CWD || process.env.PWD || process.cwd());
    const baseUrl = await getOrCreateAttachBaseUrl(rawBaseUrl, projectDirectory);

    console.log(`Creating session for ${projectDirectory}`);
    console.log(`Using OpenCode server ${baseUrl}`);

    const sessionId = await createSessionForCurrentDirectory(baseUrl, projectDirectory);
    console.log(`Created session ${sessionId}`);

    const child = spawn("opencode", ["attach", "--session", sessionId, "--dir", projectDirectory, baseUrl], {
        stdio: "inherit",
        env: process.env,
        cwd: projectDirectory,
    });

    const { code, signal } = await waitForChildExit(child);
    if (typeof code === "number") {
        return code;
    }

    if (signal) {
        console.error(`opencode attach terminated by signal ${signal}`);
    }
    return 1;
}

async function runKillAll() {
    console.log("Killing all OpenCode server instances...");

    const result = spawn("pkill", ["-f", "opencode serve"], {
        stdio: "inherit",
        shell: process.platform === "win32",
    });

    await new Promise((resolve) => {
        result.on("close", resolve);
        result.on("error", resolve);
    });

    try {
        if (existsSync(INSTANCES_STATE_FILE)) {
            unlinkSync(INSTANCES_STATE_FILE);
            console.log("Removed instance state file.");
        }
    } catch (err) {
        console.warn("Failed to remove state file:", err?.message);
    }

    console.log("Done. All OpenCode server instances have been terminated.");
    return 0;
}

const command = process.argv[2];
const args = process.argv.slice(3);

// Parse global --project <path> flag (used by send, stop, mode)
function parseProjectFlag(argList) {
    const idx = argList.findIndex((a) => a === "--project");
    if (idx >= 0 && argList[idx + 1] !== undefined) {
        return { projectPath: argList[idx + 1], remaining: argList.filter((_, i) => i !== idx && i !== idx + 1) };
    }
    return { projectPath: undefined, remaining: argList };
}

if (command === "dev" || !command) {
    if (!process.env.TELEGRAM_TOKEN) {
        console.error("Missing TELEGRAM_TOKEN. Set it in environment or .env file.");
        process.exit(1);
    }
}

if (command === "dev") {
    const exitCode = await runManagedMode();
    process.exit(exitCode);
}

if (command === "attach" || command === "attach-local") {
    try {
        const exitCode = await runAttachMode(process.argv[3]);
        process.exit(exitCode);
    } catch (err) {
        console.error(`Attach failed: ${err?.message ?? "unknown error"}`);
        process.exit(1);
    }
}

if (command === "kill-all") {
    const exitCode = await runKillAll();
    process.exit(exitCode);
}

// ── New subcommands ───────────────────────────────────────────────────────────
if (command === "projects") {
    const sub = args[0];
    if (sub === "list" || !sub) {
        await listProjects();
    } else {
        console.error(`Unknown 'projects' subcommand: ${sub}`);
        console.error("Usage: opencode-telegram projects list");
        process.exit(1);
    }
    process.exit(0);
}

if (command === "session" || command === "sessions") {
    const sub = args[0];
    const subArgs = args.slice(1);
    const { projectPath, remaining } = parseProjectFlag(subArgs);

    if (sub === "list") {
        await listSessionsCommand(projectPath ?? remaining[0]);
    } else if (sub === "switch") {
        await switchSessionCommand(remaining[0], remaining[1]);
    } else if (sub === "new") {
        await newSessionCommand(projectPath ?? remaining[0]);
    } else {
        console.error("Usage: opencode-telegram session list|switch|new [--project <path>]");
        process.exit(1);
    }
    process.exit(0);
}

if (command === "send") {
    const { projectPath, remaining } = parseProjectFlag(args);
    await sendPromptCommand(remaining.join(" "), projectPath);
    process.exit(0);
}

if (command === "stop") {
    const { projectPath } = parseProjectFlag(args);
    await stopCommand(projectPath);
    process.exit(0);
}

if (command === "mode") {
    const { projectPath, remaining } = parseProjectFlag(args);
    await setModeCommand(remaining[0], projectPath);
    process.exit(0);
}

// ── Default: start Telegram bot ──────────────────────────────────────────────
const exitCode = await runManagedMode();
process.exit(exitCode);
