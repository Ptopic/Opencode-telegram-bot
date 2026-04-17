/**
 * watch <project-path> [--interval 2000]
 * Stream session messages as they arrive, showing role + content.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { getSessionMessages as fetchMessages, listSessions } from "../api-client.js";
import { getProjectRoots } from "../config.js";

const STATE_FILE = path.join(homedir(), ".opencode-telegram-instances.json");

function readState() {
  if (!existsSync(STATE_FILE)) return { instances: {}, activeSession: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { instances: {}, activeSession: {} };
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

function getMessageRole(msg) {
  for (const key of ["role", "type", "author"]) {
    const val = msg?.[key];
    if (typeof val === "string") return val.toLowerCase();
  }
  // Check nested
  for (const k of ["message", "info", "metadata"]) {
    const nested = msg?.[k];
    if (typeof nested === "object" && nested) {
      for (const nk of ["role", "type"]) {
        const v = nested?.[nk];
        if (typeof v === "string") return v.toLowerCase();
      }
    }
  }
  return "unknown";
}

function getMessageText(msg) {
  // parts array
  if (Array.isArray(msg?.parts)) {
    return msg.parts
      .filter((p) => p && typeof p === "object")
      .map((p) => {
        const type = typeof p.type === "string" ? p.type.toLowerCase() : "";
        const text = typeof p.text === "string" ? p.text : typeof p.content === "string" ? p.content : "";
        return { type, text };
      })
      .filter((p) => p.text)
      .map((p) => ({ type: p.type, text: p.text }));
  }

  // Direct fields
  for (const key of ["text", "content", "message", "response", "reply", "outputText"]) {
    const val = msg?.[key];
    if (typeof val === "string" && val.trim()) return [{ type: "text", text: val.trim() }];
  }

  // Nested result/message
  for (const key of ["result", "data"]) {
    const nested = msg?.[key];
    if (typeof nested === "object" && nested) {
      for (const k of ["text", "content", "message"]) {
        const v = nested?.[k];
        if (typeof v === "string" && v.trim()) return [{ type: "text", text: v.trim() }];
      }
    }
  }

  return [];
}

function formatRole(role) {
  switch (role) {
    case "assistant": return "🤖 assistant";
    case "user":      return "👤 user";
    case "system":    return "⚙️  system";
    case "tool":      return "🔧 tool";
    default:          return `(${role})`;
  }
}

function printMessage(msg, stream) {
  const role = getMessageRole(msg);
  const parts = getMessageText(msg);

  if (!parts.length) return;

  stream.write(`\n${formatRole(role)}\n`);
  stream.write(`${"─".repeat(50)}\n`);

  for (const part of parts) {
    if (part.type === "reasoning") {
      stream.write(`  [thinking] ${part.text}\n`);
    } else {
      stream.write(`${part.text}\n`);
    }
  }
}

async function watchSession(projectPath, baseUrl, sessionId, intervalMs, stream = process.stderr) {
  let seenCount = 0;

  // Get initial message count so we know where we start
  try {
    const initial = await fetchMessages(baseUrl, sessionId);
    seenCount = initial.length;
    if (initial.length > 0) {
      stream.write(`\n📡 Watching session ${sessionId}\n`);
      stream.write(`📊 Starting from message ${seenCount} (current message count)\n\n`);
    }
  } catch (err) {
    stream.write(`⚠️  Could not fetch initial messages: ${err?.message}\n`);
  }

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const messages = await fetchMessages(baseUrl, sessionId);

        if (messages.length > seenCount) {
          const newMessages = messages.slice(seenCount);
          for (const msg of newMessages) {
            printMessage(msg, stream);
          }
          seenCount = messages.length;
          stream.write("\n"); // blank line between message groups
        }
      } catch (err) {
        stream.write(`\n⚠️  Error fetching messages: ${err?.message}\n`);
      }
    }, intervalMs);

    // Handle SIGINT gracefully
    const cleanup = () => {
      clearInterval(interval);
      stream.write("\n👋 Stopped watching.\n");
      resolve();
    };

    process.on("SIGINT", cleanup);
  });
}

export async function watchCommand(projectPath, options = {}) {
  const intervalMs = options.interval ?? 2000;

  if (!projectPath) {
    const state = readState();
    for (const [p, inst] of Object.entries(state.instances ?? {})) {
      if (inst?.status === "ready") {
        projectPath = p;
        break;
      }
    }
  }

  if (!projectPath) {
    console.error("No project specified and no running instances found.");
    console.error("Usage: opencode-telegram watch <project-path> [--interval 2000]");
    process.exit(1);
  }

  const state = readState();
  const instance = findInstanceForPath(state, projectPath);

  if (!instance || instance.status !== "ready") {
    console.error(`No running instance for: ${projectPath}`);
    console.error("Start the bot first with 'opencode-telegram bot' and select a project.");
    process.exit(1);
  }

  const activeSessionId = state?.activeSession?.[projectPath];
  let targetSessionId = activeSessionId;

  if (!targetSessionId) {
    console.error(`No active session set for ${projectPath}.`);
    const sessions = await listSessions(instance.baseUrl);
    if (!sessions.length) {
      console.error("No sessions found. Start a conversation from Telegram first.");
      process.exit(1);
    }
    // Use most recent session
    targetSessionId = sessions[sessions.length - 1].id;
    console.error(`Using most recent session: ${targetSessionId}`);
  }

  await watchSession(projectPath, instance.baseUrl, targetSessionId, intervalMs);
}
