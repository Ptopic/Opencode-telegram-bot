/**
 * HTTP API server for the CLI.
 * Exposes the same operations as the CLI over HTTP, for cloudflared tunneling.
 */
import http from "node:http";
import { URL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  probeHealth,
  listSessions,
  createSession,
  sendPrompt,
  abortSession,
  listModes,
  setMode,
  getSessionMessages,
} from "./api-client.js";
import { getProjectRoots } from "./config.js";

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
  if (!projectPath) return null;
  const normalized = projectPath.replace(/\/+$/, "").toLowerCase();
  for (const [p, inst] of Object.entries(state.instances ?? {})) {
    const np = p.replace(/\/+$/, "").toLowerCase();
    if (np === normalized) return inst;
  }
  return null;
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function errorResponse(res, statusCode, message) {
  jsonResponse(res, statusCode, { error: message });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

async function handleRequest(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, "") || "/";
  const method = req.method;

  try {
    // ── GET /health ──────────────────────────────────────────────────────────
    if (pathname === "/health" && method === "GET") {
      const state = readState();
      const instances = Object.entries(state.instances ?? {}).map(([projectPath, inst]) => ({
        projectPath,
        baseUrl: inst.baseUrl,
        port: inst.port,
        status: inst.status,
        pid: inst.pid,
        startedAt: inst.startedAt,
      }));
      return jsonResponse(res, 200, { ok: true, instances });
    }

    // ── GET /status ─────────────────────────────────────────────────────────
    if (pathname === "/status" && method === "GET") {
      const state = readState();
      const roots = getProjectRoots();
      const instances = [];

      for (const [projectPath, inst] of Object.entries(state.instances ?? {})) {
        if (!inst?.baseUrl) continue;
        const health = await probeHealth(inst.baseUrl, 3000);
        instances.push({
          projectPath,
          baseUrl: inst.baseUrl,
          status: health.ok ? "healthy" : "unhealthy",
          reason: health.ok ? null : health.reason,
          version: health.version ?? null,
          pid: inst.pid ?? null,
          activeSessionId: state?.activeSession?.[projectPath] ?? null,
          startedAt: inst.startedAt ?? null,
        });
      }

      return jsonResponse(res, 200, { instances, projectRoots: roots });
    }

    // ── GET /projects ───────────────────────────────────────────────────────
    if (pathname === "/projects" && method === "GET") {
      const state = readState();
      const roots = getProjectRoots();
      const result = [];

      for (const root of roots) {
        result.push({ type: "root", scope: root.scope, path: root.path, label: root.label });
      }

      return jsonResponse(res, 200, { projectRoots: result });
    }

    // ── GET /sessions/:project ──────────────────────────────────────────────
    if (pathname.startsWith("/sessions/") && method === "GET") {
      const projectPath = decodeURIComponent(pathname.slice("/sessions/".length));
      const state = readState();
      const instance = findInstanceForPath(state, projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const sessions = await listSessions(instance.baseUrl);
      const activeSessionId = state?.activeSession?.[projectPath] ?? null;

      return jsonResponse(res, 200, {
        projectPath,
        baseUrl: instance.baseUrl,
        activeSessionId,
        sessions,
      });
    }

    // ── POST /sessions/:project/new ────────────────────────────────────────
    if (pathname.startsWith("/sessions/") && pathname.endsWith("/new") && method === "POST") {
      const parts = pathname.slice("/sessions/".length).split("/");
      parts.pop(); // remove "new"
      const projectPath = decodeURIComponent(parts.join("/"));
      const body = await parseBody(req);
      const state = readState();
      const instance = findInstanceForPath(state, projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const session = await createSession(instance.baseUrl, {
        title: body.title ?? `http-session-${Date.now()}`,
        directory: projectPath,
        cwd: projectPath,
      });

      // Auto-select it, preserving any existing mode
      state.activeSession = state.activeSession ?? {};
      const existing = state.activeSession[projectPath];
      state.activeSession[projectPath] = {
        ...(typeof existing === "object" && existing !== null ? existing : {}),
        sessionId: session.id,
      };

      return jsonResponse(res, 201, { session, activeSessionId: session.id });
    }

    // ── POST /send ─────────────────────────────────────────────────────────
    if (pathname === "/send" && method === "POST") {
      const body = await parseBody(req);
      const { project: projectPath, sessionId, prompt, agent } = body;

      if (!prompt) return errorResponse(res, 400, "Missing 'prompt' in request body");

      const state = readState();
      const instance = findInstanceForPath(state, projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const sessionData = state?.activeSession?.[projectPath] ?? {};
      let targetSessionId = sessionId ?? sessionData.sessionId;

      if (!targetSessionId) {
        const sessions = await listSessions(instance.baseUrl);
        if (!sessions.length) return errorResponse(res, 404, "No sessions found");
        targetSessionId = sessions[sessions.length - 1].id;
      }

      // Auto-use saved mode unless caller explicitly passed one
      const effectiveAgent = agent ?? sessionData.mode ?? null;

      const reply = await sendPrompt(instance.baseUrl, targetSessionId, prompt, effectiveAgent);

      return jsonResponse(res, 200, {
        projectPath,
        sessionId: targetSessionId,
        agent: effectiveAgent,
        reply: reply ?? "(no reply)",
      });
    }

    // ── GET /watch/:project ────────────────────────────────────────────────
    if (pathname.startsWith("/watch/") && method === "GET") {
      const projectPath = decodeURIComponent(pathname.slice("/watch/".length));
      const state = readState();
      const instance = findInstanceForPath(state, projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const sessionData = state?.activeSession?.[projectPath] ?? {};
      const sessionId =
        url.searchParams.get("session") ??
        sessionData.sessionId ??
        (await listSessions(instance.baseUrl)).pop()?.id;

      if (!sessionId) {
        return errorResponse(res, 404, "No session found");
      }

      // SSE stream
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      let seenCount = 0;
      const intervalMs = parseInt(url.searchParams.get("interval") ?? "2000", 10);

      const interval = setInterval(async () => {
        try {
          const messages = await getSessionMessages(instance.baseUrl, sessionId);

          if (messages.length > seenCount) {
            const newMessages = messages.slice(seenCount);
            for (const msg of newMessages) {
              const data = JSON.stringify({ type: "message", role: getMessageRole(msg), parts: getMessageParts(msg) });
              res.write(`data: ${data}\n\n`);
            }
            seenCount = messages.length;
          }
        } catch (err) {
          const data = JSON.stringify({ type: "error", message: err.message });
          res.write(`data: ${data}\n\n`);
        }
      }, intervalMs);

      req.on("close", () => clearInterval(interval));

      return;
    }

    // ── RAW SSE DEBUG ──────────────────────────────────────────────────────
    if (pathname === "/debug/raw-sse" && method === "GET") {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) return errorResponse(res, 400, "Missing ?session=");
      const state = readState();
      let baseUrl = null;
      for (const inst of Object.values(state.instances ?? {})) {
        if (inst?.status === "ready") { baseUrl = inst.baseUrl; break; }
      }
      if (!baseUrl) return errorResponse(res, 500, "No healthy instance");

      res.setHeader("Content-Type", "text/plain");
      res.flushHeaders();

      // Fetch raw SSE from OpenCode
      try {
        const sseRes = await fetch(`${baseUrl}/global/event`, {
          headers: { Accept: "text/event-stream" },
        });
        const reader = sseRes.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let count = 0;
        while (count < 50 && !res.writableEnded) {
          const { done, chunk } = await reader.read();
          if (done) break;
          buf += dec.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) {
            if (l.startsWith("data:") || l.startsWith("event:") || l.startsWith("id:")) {
              res.write(l + "\n");
            }
          }
          count++;
        }
      } catch (err) {
        res.write(`ERROR: ${err.message}\n`);
      }
      res.end();
      return;
    }

    // ── RAW SSE PROXY — streams /global/event for 15s to see actual events ───
    if (pathname === "/debug/sse-raw" && method === "GET") {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) return errorResponse(res, 400, "Missing ?session=");
      const state = readState();
      let baseUrl = null;
      for (const inst of Object.values(state.instances ?? {})) {
        if (inst?.status === "ready") { baseUrl = inst.baseUrl; break; }
      }
      if (!baseUrl) return errorResponse(res, 500, "No healthy instance");

      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Cache-Control", "no-cache");
      res.flushHeaders();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);

      try {
        const sseRes = await fetch(`${baseUrl}/global/event`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        const reader = sseRes.body.getReader();
        const dec = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, chunk } = await reader.read();
          if (done) break;
          buf += dec.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) {
            if (l.startsWith("data:") || l.startsWith("event:") || l.startsWith("id:") || l.trim()) {
              res.write(l + "\n");
            }
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          res.write(`ERROR: ${err.message}\n`);
        }
      } finally {
        clearTimeout(timer);
      }
      res.end();
      return;
    }

    // ── GET /modes/:project ──────────────────────────────────────────────
    if (pathname.startsWith("/modes/") && method === "GET") {
      const projectPath = decodeURIComponent(pathname.slice("/modes/".length));
      const state = readState();
      const instance = findInstanceForPath(state, projectPath);
      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }
      const modes = await listModes(instance.baseUrl);
      return jsonResponse(res, 200, { projectPath, baseUrl: instance.baseUrl, modes });
    }

    // ── POST /modes/:project ──────────────────────────────────────────────
    if (pathname.startsWith("/modes/") && pathname.endsWith("/mode") && method === "POST") {
      const projectPath = decodeURIComponent(pathname.slice("/modes/".length, -5)); // strip "/mode"
      const body = await parseBody(req);
      const state = readState();
      const instance = findInstanceForPath(state, projectPath);
      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }
      const sessionData = state?.activeSession?.[projectPath];
      const sessionId = body.sessionId ?? (typeof sessionData === "string" ? sessionData : sessionData?.sessionId);
      if (!sessionId) {
        return errorResponse(res, 400, "No active session");
      }
      await setMode(instance.baseUrl, sessionId, body.mode);

      // Persist mode to local state file
      state.activeSession = state.activeSession ?? {};
      const existing = state.activeSession[projectPath];
      state.activeSession[projectPath] = {
        ...(typeof existing === "object" && existing !== null ? existing : {}),
        mode: body.mode,
      };

      return jsonResponse(res, 200, { ok: true, mode: body.mode, sessionId });
    }

    // ── POST /stop ────────────────────────────────────────────────────────
    if (pathname === "/stop" && method === "POST") {
      const body = await parseBody(req);
      const { project: projectPath, sessionId } = body;

      const state = readState();
      const instance = findInstanceForPath(state, projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const targetSessionId = sessionId ?? state?.activeSession?.[projectPath];
      if (!targetSessionId) return errorResponse(res, 400, "No active session");

      await abortSession(instance.baseUrl, targetSessionId);
      return jsonResponse(res, 200, { ok: true, sessionId: targetSessionId });
    }

    // ── POST /project/start ─────────────────────────────────────────────
    if (pathname === "/project/start" && method === "POST") {
      const body = await parseBody(req);
      const { project: projectPath } = body;
      if (!projectPath) return errorResponse(res, 400, "Missing 'project' in request body");

      try {
        const { projectStartCommand } = await import("./commands/project.js");
        // Start the instance (writes to state file)
        await projectStartCommand(projectPath);
        // Re-read state to get the new instance info
        const state = readState();
        const instance = findInstanceForPath(state, projectPath);
        return jsonResponse(res, 200, {
          ok: true,
          projectPath,
          instance: instance ? { baseUrl: instance.baseUrl, port: instance.port, pid: instance.pid, status: instance.status } : null,
        });
      } catch (err) {
        return errorResponse(res, 500, `Failed to start project: ${err.message}`);
      }
    }

    // ── POST /project/stop ───────────────────────────────────────────────
    if (pathname === "/project/stop" && method === "POST") {
      const body = await parseBody(req);
      const { project: projectPath } = body;
      if (!projectPath) return errorResponse(res, 400, "Missing 'project' in request body");

      try {
        const { projectStopCommand } = await import("./commands/project.js");
        await projectStopCommand(projectPath);
        return jsonResponse(res, 200, { ok: true, projectPath });
      } catch (err) {
        return errorResponse(res, 500, `Failed to stop project: ${err.message}`);
      }
    }

    // ── 404 ────────────────────────────────────────────────────────────────
    return errorResponse(res, 404, `Unknown route: ${method} ${pathname}`);

  } catch (err) {
    console.error("Server error:", err);
    return errorResponse(res, 500, err.message ?? "Internal error");
  }
}

function getMessageRole(msg) {
  for (const key of ["role", "type", "author"]) {
    const val = msg?.[key];
    if (typeof val === "string") return val.toLowerCase();
  }
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

function getMessageParts(msg) {
  if (Array.isArray(msg?.parts)) {
    return msg.parts
      .filter((p) => p && typeof p === "object")
      .map((p) => ({
        type: typeof p.type === "string" ? p.type : "text",
        text: typeof p.text === "string" ? p.text : typeof p.content === "string" ? p.content : "",
      }));
  }
  for (const key of ["text", "content", "message", "response", "reply"]) {
    const val = msg?.[key];
    if (typeof val === "string" && val.trim()) return [{ type: "text", text: val.trim() }];
  }
  return [];
}

export function startServer(port = 4097, { watch = false } = {}) {
  const server = http.createServer(handleRequest);

  server.on("error", (err) => {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`HTTP API server running on http://127.0.0.1:${port}`);
    console.log("Endpoints:");
    console.log("  GET  /health              — server health + instances");
    console.log("  GET  /status              — detailed status");
    console.log("  GET  /projects            — project roots");
    console.log("  GET  /sessions/:project   — list sessions");
    console.log("  POST /sessions/:project/new — create session");
    console.log("  POST /send                — send prompt { project, prompt, sessionId? }");
    console.log("  GET  /watch/:project      — SSE stream of messages");
    console.log("  POST /stop                — abort session { project, sessionId? }");
    if (watch) {
      console.log("\n🔁 Watch mode enabled — restarting on file changes...");
      startFileWatcher().catch(console.error);
    }
  });

  return server;
}

// ── File watcher for --watch mode ─────────────────────────────────────────────
async function startFileWatcher() {
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const fs = req("node:fs");
  const { spawn } = req("node:child_process");
  const path = req("node:path");
  const { fileURLToPath } = req("node:url");

  const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
  const watchDir = path.join(repoRoot, "packages", "cli", "src");
  let debounceTimer = null;

  console.error(`[watch] Monitoring ${watchDir}`);

  const restart = () => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      console.error("[watch] File change detected, restarting server...");
      const newServer = spawn(process.execPath, [import.meta.url, "serve"], {
        cwd: repoRoot,
        stdio: "inherit",
        detached: false,
      });
      newServer.unref();
      process.exit(0);
    }, 1000);
  };

  fs.watch(watchDir, { recursive: true }, (eventType, filename) => {
    if (filename && filename.endsWith(".js")) {
      restart();
    }
  });
}
