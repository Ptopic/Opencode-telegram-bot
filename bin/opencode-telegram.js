#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

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
    tryLoadEnv(path.resolve(process.cwd(), ".env"));
    tryLoadEnv(path.resolve(process.cwd(), "..", ".env"));
    tryLoadEnv(path.resolve(packageRoot, "..", ".env"));
}

function hasChildExited(child) {
    return child.exitCode !== null || child.signalCode !== null;
}

function defaultAttachSessionTitle(projectDirectory) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `${path.basename(projectDirectory) || "project"}-local-${timestamp}`;
}

function getAttachBaseUrl(rawValue) {
    const fallback = process.env.OPENCODE_BASE_URL || process.env.OPENCODE_URL || "http://127.0.0.1:62771";
    const candidate = (rawValue || fallback).trim();
    const parsed = new URL(candidate);
    return parsed.toString().replace(/\/+$/, "");
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
        cwd: packageRoot,
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

async function runDevMode() {
    const devPort = Number.parseInt(process.env.OPENCODE_DEV_PORT || "62771", 10);
    const devHost = process.env.OPENCODE_DEV_HOST || "0.0.0.0";

    if (!Number.isFinite(devPort) || devPort <= 0) {
        throw new Error(`Invalid OPENCODE_DEV_PORT: ${process.env.OPENCODE_DEV_PORT}`);
    }

    if (!process.env.OPENCODE_BASE_URL) {
        process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${devPort}`;
    }

    console.log(`Starting OpenCode server on ${devHost}:${devPort}`);
    console.log(`Using OPENCODE_BASE_URL=${process.env.OPENCODE_BASE_URL}`);

    const server = spawnChild("npx", [
        "--yes",
        "opencode-ai",
        "serve",
        "--hostname",
        devHost,
        "--port",
        String(devPort),
    ]);

    const bot = spawnChild(process.execPath, [path.resolve(packageRoot, "bot.js")]);

    const children = [
        { name: "OpenCode server", process: server },
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
    const baseUrl = getAttachBaseUrl(rawBaseUrl);

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

const command = process.argv[2];

if (command === "dev") {
    const exitCode = await runDevMode();
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

if (!process.env.TELEGRAM_TOKEN) {
    console.error("Missing TELEGRAM_TOKEN. Set it in environment or .env file.");
    process.exit(1);
}

await import("../bot.js");
