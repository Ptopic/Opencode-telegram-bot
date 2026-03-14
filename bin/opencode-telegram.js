#!/usr/bin/env node

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

if (!process.env.TELEGRAM_TOKEN) {
    console.error("Missing TELEGRAM_TOKEN. Set it in environment or .env file.");
    process.exit(1);
}

await import("../bot.js");
