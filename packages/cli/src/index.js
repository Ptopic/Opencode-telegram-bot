#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { statusCommand } from "./commands/status.js";
import { logsCommand } from "./commands/logs.js";
import { watchCommand } from "./commands/watch.js";
import { startServer } from "./server.js";
import { projectStartCommand, projectStopCommand, projectListCommand } from "./commands/project.js";
import { codeIndexCommand } from "./commands/code-index.js";
import { codeSearchCommand } from "./commands/code-search.js";
import { codeStatusCommand } from "./commands/code-status.js";
import { mcpCommand } from "./commands/mcp.js";
import { helpCommand } from "./commands/help.js";
import { clearAllInstances, getInstance, listInstances, deleteInstance, upsertInstance, upsertProject } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// repoRoot: packages/cli/src/index.js -> packages/cli -> packages -> repo root
const repoRoot = path.resolve(__dirname, "../../..");
const packageRoot = path.resolve(__dirname, "..");

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

async function allocatePort() {
    const instances = await listInstances();
    const usedPorts = new Set(instances.map((i) => i.port).filter(Boolean));

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
    const instance = await getInstance(projectDirectory);

    if (!instance || !instance.base_url) {
        return null;
    }

    const inUse = await isPortInUse(instance.port);
    if (!inUse) {
        return null;
    }

    // Port is in use — trust the instance even if health probe times out
    // Map db field names to expected names for compatibility
    return {
        baseUrl: instance.base_url,
        port: instance.port,
        pid: instance.pid,
        status: instance.status,
        startedAt: instance.started_at,
    };
}

async function spawnInstanceForProject(projectDirectory) {
    const existing = await findExistingInstanceForProject(projectDirectory);
    if (existing) {
        console.log(`Reusing existing instance: ${existing.baseUrl}`);
        return existing;
    }

    console.log(`Spawning new OpenCode instance for ${projectDirectory}...`);

    const port = await allocatePort();
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

                    upsertInstance({
                        projectPath: projectDirectory,
                        baseUrl,
                        port,
                        pid: child.pid,
                        status: "ready",
                    });

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

    const instance = await getInstance(projectDirectory);

    if (instance && instance.base_url && instance.status === "ready") {
        const inUse = await isPortInUse(instance.port);
        if (inUse) {
            let pidAlive = false;
            if (typeof instance.pid === "number") {
                try { process.kill(instance.pid, 0); pidAlive = true; } catch { pidAlive = false; }
            }
            if (pidAlive) {
                const health = await probeHealth(instance.base_url, 2000);
                if (health.ok) {
                    console.log(`Found matching instance for ${projectDirectory}: ${instance.base_url}`);
                    return instance.base_url;
                }
                console.log(`Instance found but unhealthy (${health.reason}), killing stale PID...`);
                try { process.kill(instance.pid, "SIGTERM"); } catch {}
                await new Promise((r) => setTimeout(r, 1000));
                try { process.kill(instance.pid, "SIGKILL"); } catch {}
            } else {
                console.log(`Instance found but PID ${instance.pid} is dead — will spawn new`);
            }
            await deleteInstance(projectDirectory);
        } else {
            console.log(`Instance found but port not in use — will spawn new`);
        }
    }

    console.log(`No matching instance found for ${projectDirectory}`);
    const newInstance = await spawnInstanceForProject(projectDirectory);
    return newInstance.baseUrl;
}

async function createSessionForCurrentDirectory(baseUrl, projectDirectory) {
    // Wait for the HTTP server to actually be ready (not just port bound)
    const deadline = Date.now() + 30_000;
    let serverReady = false;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/global/health`, {
                signal: AbortSignal.timeout(2000),
            });
            if (res.ok) { serverReady = true; break; }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!serverReady) {
        throw new Error(`OpenCode server at ${baseUrl} did not respond to /global/health within 30s`);
    }
    console.log(`[attach] Server ready. Creating session...`);
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

// ── Shared child-process runner ───────────────────────────────────────────────

function spawnBot() {
    const botEntry = path.resolve(repoRoot, "packages", "bot", "src", "index.js");
    return spawnChild(process.execPath, [botEntry]);
}

async function runWithChildren(children, label) {
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

    return new Promise((resolve) => {
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
                    if (children.every((c) => hasChildExited(c.process))) {
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

// ── Mode: bot only ─────────────────────────────────────────────────────────────

async function runBotMode() {
    console.log("Starting Telegram bot...");
    const bot = spawnBot();
    return await runWithChildren([{ name: "Telegram bot", process: bot }], "bot");
}

// ── Mode: interactive CLI REPL ─────────────────────────────────────────────────

async function runCLIMode() {
    console.log("OpenCode CLI REPL");
    console.log("Type 'send <prompt>' to send a prompt, 'projects' to list projects, 'exit' to quit.");
    console.log("(REPL mode — for advanced use. Telegram bot is recommended for most workflows.)\n");

    const readline = await import("node:readline");
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: "opencode> ",
    });

    rl.prompt();

    rl.on("line", async (line) => {
        const cmd = line.trim();
        if (!cmd) {
            rl.prompt();
            return;
        }

        if (cmd === "exit" || cmd === "quit") {
            rl.close();
            return;
        }

        if (cmd.startsWith("send ")) {
            const prompt = cmd.slice(5).trim();
            if (!prompt) {
                console.log("Usage: send <prompt>");
            } else {
                await sendPromptCommand(prompt, undefined).catch((err) =>
                    console.error(`Error: ${err?.message ?? err}`)
                );
            }
        } else if (cmd === "projects") {
            await listProjects();
        } else {
            console.log(`Unknown command: ${cmd}`);
            console.log("Available: send <prompt>, projects, exit");
        }

        rl.prompt();
    });

    return new Promise(() => {}); // Keep running until user quits
}

// ── Mode: bot + CLI together ───────────────────────────────────────────────────

async function runAllMode() {
    console.log("Starting Telegram bot + CLI...");
    console.log("Each project will get its own OpenCode server instance.");

    delete process.env.OPENCODE_BASE_URL;
    delete process.env.OPENCODE_URL;

    const bot = spawnBot();
    const children = [{ name: "Telegram bot", process: bot }];

    return await runWithChildren(children, "all");
}

// Legacy alias
const runManagedMode = runAllMode;

async function runAttachMode(rawBaseUrl) {
    const projectDirectory = path.resolve(process.env.INIT_CWD || process.env.PWD || process.cwd());

    let baseUrl;
    try {
        baseUrl = await getOrCreateAttachBaseUrl(rawBaseUrl, projectDirectory);
    } catch (err) {
        console.error(`Failed to get/create instance: ${err.message}`);
        return 1;
    }

    console.log(`Creating session for ${projectDirectory}`);
    console.log(`Using OpenCode server ${baseUrl}`);

    // Auto-register this project so it appears in /projects
    upsertProject({
      scope: projectDirectory,  // Use project path as unique scope/key
      path: projectDirectory,
      label: path.basename(projectDirectory) || projectDirectory,
    });

    let sessionId;
    try {
        sessionId = await createSessionForCurrentDirectory(baseUrl, projectDirectory);
    } catch (err) {
        console.error(`Failed to create session: ${err.message}`);
        return 1;
    }
    console.log(`Created session ${sessionId}`);

    console.log(`[attach] Spawning: opencode attach --session ${sessionId} --dir ${projectDirectory} ${baseUrl}`);
    const child = spawn("opencode", ["attach", "--session", sessionId, "--dir", projectDirectory, baseUrl], {
        stdio: "inherit",
        env: process.env,
        cwd: projectDirectory,
    });
    child.on("error", (err) => console.error(`[attach] spawn error: ${err.message}`));

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
        clearAllInstances();
        console.log("Cleared all instances from database.");
    } catch (err) {
        console.warn("Failed to clear instances:", err?.message);
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

if (command === "project") {
    const sub = args[0];
    const subArgs = args.slice(1);

    if (sub === "start") {
        await projectStartCommand(subArgs[0]);
    } else if (sub === "stop") {
        await projectStopCommand(subArgs[0]);
    } else if (sub === "list") {
        await projectListCommand();
    } else {
        console.error("Usage: opencode-telegram project start|stop|list <project-path>");
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

if (command === "status") {
    await statusCommand();
    process.exit(0);
}

if (command === "logs") {
    const { projectPath, remaining } = parseProjectFlag(args);
    const linesArg = remaining.find((a) => a.startsWith("--lines="));
    const lines = linesArg ? parseInt(linesArg.split("=")[1], 10) : 100;
    await logsCommand(projectPath, { lines });
    process.exit(0);
}

if (command === "watch") {
    const { projectPath, remaining } = parseProjectFlag(args);
    const intervalArg = remaining.find((a) => a.startsWith("--interval="));
    const interval = intervalArg ? parseInt(intervalArg.split("=")[1], 10) : 2000;
    await watchCommand(projectPath, { interval });
    process.exit(0);
}

if (command === "mode") {
    const { projectPath, remaining } = parseProjectFlag(args);
    await setModeCommand(remaining[0], projectPath);
    process.exit(0);
}

if (command === "code-index") {
    const watch = args.includes("--watch");
    const remaining = args.filter((a) => a !== "--watch");
    const projectPath = remaining[0];
    await codeIndexCommand(projectPath, { watch });
    process.exit(0);
}

if (command === "code-search") {
    const { projectPath, remaining } = parseProjectFlag(args);
    const limitArg = remaining.find((a) => a.startsWith("--limit="));
    const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : 10;
    const queryArgs = remaining.filter((a) => !a.startsWith("--limit="));
    await codeSearchCommand(queryArgs.join(" "), { projectPath, limit });
    process.exit(0);
}

if (command === "code-status") {
    const { projectPath } = parseProjectFlag(args);
    await codeStatusCommand({ projectPath });
    process.exit(0);
}

if (command === "mcp") {
    mcpCommand();
    process.exit(0);
}

if (command === "help") {
    helpCommand();
    process.exit(0);
}

// ── start bot | start cli | start all ────────────────────────────────────────
if (command === "start") {
    const target = args[0];
    if (target === "bot") {
        process.exit(await runBotMode());
    } else if (target === "cli") {
        process.exit(await runCLIMode());
    } else if (target === "all" || !target) {
        process.exit(await runAllMode());
    } else {
        console.error(`Unknown start target: ${target}`);
        console.error("Usage: opencode-telegram start [bot|cli|all]");
        process.exit(1);
    }
}

// ── serve: HTTP API server for cloudflared tunneling ───────────────────────
if (command === "serve") {
    const port = parseInt(args.find((a) => a.startsWith("--port="))?.split("=")[1] ?? "4097", 10);
    const watch = args.includes("--watch");
    startServer(port, { watch });
    // Keep the process alive — prevent Node from exiting when stdin closes
    process.stdin.resume();
    await new Promise(() => {});
}

// ── Convenience shortcuts: opencode-telegram bot | opencode-telegram cli ──────
if (command === "bot") {
    process.exit(await runBotMode());
}

if (command === "cli") {
    process.exit(await runCLIMode());
}

// ── Default: start all ────────────────────────────────────────────────────────
const exitCode = await runAllMode();
process.exit(exitCode);
