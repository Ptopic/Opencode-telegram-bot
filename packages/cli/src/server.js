/**
 * HTTP API server for the CLI.
 * Exposes the same operations as the CLI over HTTP, for cloudflared tunneling.
 */
import http from "node:http";
import { URL } from "node:url";
import {
  abortSession,
  createSession,
  getSessionMessages,
  listModes,
  listSessions,
  probeHealth,
  sendPrompt,
  setMode,
} from "./api-client.js";
import {
  getActiveSession,
  getInstance,
  listInstances,
  listProjects,
  setActiveSession,
  setMode as dbSetMode,
} from "./db.js";

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
      const instances = await listInstances();
      return jsonResponse(res, 200, {
        ok: true,
        instances: instances.map((inst) => ({
          projectPath: inst.project_path,
          baseUrl: inst.base_url,
          port: inst.port,
          status: inst.status,
          pid: inst.pid,
          startedAt: inst.started_at,
        })),
      });
    }

    // ── GET /status ─────────────────────────────────────────────────────────
    if (pathname === "/status" && method === "GET") {
      const instances = await listInstances();
      const projects = await listProjects();
      const result = [];

      for (const inst of instances) {
        if (!inst?.base_url) continue;
        const health = await probeHealth(inst.base_url, 3000);
        const activeSession = await getActiveSession(inst.project_path);
        result.push({
          projectPath: inst.project_path,
          baseUrl: inst.base_url,
          status: health.ok ? "healthy" : "unhealthy",
          reason: health.ok ? null : health.reason,
          version: health.version ?? null,
          pid: inst.pid ?? null,
          activeSessionId: activeSession?.sessionId ?? null,
          startedAt: inst.started_at ?? null,
        });
      }

      return jsonResponse(res, 200, {
        instances: result,
        projectRoots: projects.map((p) => ({ type: "root", scope: p.scope, path: p.path, label: p.label })),
      });
    }

    // ── GET /projects ───────────────────────────────────────────────────────
    if (pathname === "/projects" && method === "GET") {
      try {
        const projects = await listProjects();
        const instances = await listInstances();
        const _debug = { projectsCount: projects?.length ?? -1, instancesCount: instances?.length ?? -1, instances };
        const result = projects.map((p) => ({ type: "root", scope: p.scope, path: p.path, label: p.label }));
        // Include running instances that aren't already in projectRoots
        const rootPaths = new Set(result.map((p) => p.path));
        for (const inst of instances) {
          if (inst.project_path && !rootPaths.has(inst.project_path)) {
            result.push({
              type: "instance",
              path: inst.project_path,
              label: inst.project_path.split("/").pop(),
              status: inst.status,
            });
          }
        }

        return jsonResponse(res, 200, { projectRoots: result, _debug });
      } catch (err) {
        return errorResponse(res, 500, "Internal error: " + err?.message);
      }
    }

    // ── GET /debug/db ───────────────────────────────────────────────────────
    if (pathname === "/debug/db" && method === "GET") {
      try {
        const instances = await listInstances();
        return jsonResponse(res, 200, { raw_instances: instances });
      } catch (err) {
        return errorResponse(res, 500, "DB error: " + err?.message);
      }
    }

    // ── GET /sessions/:project ──────────────────────────────────────────────
    if (pathname.startsWith("/sessions/") && method === "GET") {
      const projectPath = decodeURIComponent(pathname.slice("/sessions/".length));
      const instance = await getInstance(projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const sessions = await listSessions(instance.base_url);
      const activeSession = await getActiveSession(projectPath);

      return jsonResponse(res, 200, {
        projectPath,
        baseUrl: instance.base_url,
        activeSessionId: activeSession?.sessionId ?? null,
        sessions,
      });
    }

    // ── POST /sessions/:project/new ────────────────────────────────────────
    if (pathname.startsWith("/sessions/") && pathname.endsWith("/new") && method === "POST") {
      const parts = pathname.slice("/sessions/".length).split("/");
      parts.pop(); // remove "new"
      const projectPath = decodeURIComponent(parts.join("/"));
      const body = await parseBody(req);
      const instance = await getInstance(projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const session = await createSession(instance.base_url, {
        title: body.title ?? `http-session-${Date.now()}`,
        directory: projectPath,
        cwd: projectPath,
      });

      // Auto-select it, preserving any existing mode
      const existing = await getActiveSession(projectPath);
      await setActiveSession(projectPath, {
        sessionId: session.id,
        mode: existing?.mode ?? null,
      });

      return jsonResponse(res, 201, { session, activeSessionId: session.id });
    }

    // ── POST /send ─────────────────────────────────────────────────────────
    if (pathname === "/send" && method === "POST") {
      const body = await parseBody(req);
      const { project: projectPath, sessionId, prompt, agent } = body;

      if (!prompt) return errorResponse(res, 400, "Missing 'prompt' in request body");

      const instance = await getInstance(projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const sessionData = (await getActiveSession(projectPath)) ?? {};
      let targetSessionId = sessionId ?? sessionData.sessionId;

      if (!targetSessionId) {
        const sessions = await listSessions(instance.base_url);
        if (!sessions.length) return errorResponse(res, 404, "No sessions found");
        targetSessionId = sessions[sessions.length - 1].id;
      }

      // Auto-use saved mode unless caller explicitly passed one
      const effectiveAgent = agent ?? sessionData.mode ?? null;

      const reply = await sendPrompt(instance.base_url, targetSessionId, prompt, effectiveAgent);

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
      const instance = await getInstance(projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const sessionData = (await getActiveSession(projectPath)) ?? {};
      const sessionId =
        url.searchParams.get("session") ??
        sessionData.sessionId ??
        (await listSessions(instance.base_url)).pop()?.id;

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

      let emptyPolls = 0;
      const MAX_EMPTY_POLLS = 5; // 10 seconds of silence (5 x 2000ms) = session likely done

      const interval = setInterval(async () => {
        try {
          const messages = await getSessionMessages(instance.base_url, sessionId);

          if (messages.length > seenCount) {
            const newMessages = messages.slice(seenCount);
            for (const msg of newMessages) {
              const data = JSON.stringify({ type: "message", role: getMessageRole(msg), parts: getMessageParts(msg) });
              res.write(`data: ${data}\n\n`);
            }
            seenCount = messages.length;
            emptyPolls = 0; // Reset counter when we get new messages
          } else {
            emptyPolls++;
            // Check if session appears done: we have messages, and no new messages for MAX_EMPTY_POLLS
            if (emptyPolls >= MAX_EMPTY_POLLS && seenCount > 0) {
              // Session is likely done - emit done and close
              res.write(`data: ${JSON.stringify({ type: "done", isFinished: true })}\n\n`);
              clearInterval(interval);
              res.end();
              return;
            }
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
      const instances = await listInstances();
      let baseUrl = null;
      for (const inst of instances) {
        if (inst?.status === "ready") { baseUrl = inst.base_url; break; }
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
              res.write(`${l}\n`);
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
      const instances = await listInstances();
      let baseUrl = null;
      for (const inst of instances) {
        if (inst?.status === "ready") { baseUrl = inst.base_url; break; }
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
              res.write(`${l}\n`);
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
      const instance = await getInstance(projectPath);
      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }
      const modes = await listModes(instance.base_url);
      return jsonResponse(res, 200, { projectPath, baseUrl: instance.base_url, modes });
    }

    // ── POST /modes/:project/mode ────────────────────────────────────────
    if (pathname.startsWith("/modes/") && pathname.endsWith("/mode") && method === "POST") {
      const projectPath = decodeURIComponent(pathname.slice("/modes/".length, -5)); // strip "/mode"
      const body = await parseBody(req);
      const instance = await getInstance(projectPath);
      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }
      const sessionData = await getActiveSession(projectPath);
      const sessionId = body.sessionId ?? sessionData?.sessionId;
      if (!sessionId) {
        return errorResponse(res, 400, "No active session");
      }

      // Resolve mode: if body.mode is a number string (index), look up the name
      let resolvedMode = body.mode;
      const modeIndex = parseInt(body.mode, 10);
      if (!isNaN(modeIndex) && modeIndex >= 0) {
        const modes = await listModes(instance.base_url);
        if (modeIndex >= modes.length) {
          return errorResponse(res, 400, `Mode index ${modeIndex} out of range (0-${modes.length - 1})`);
        }
        resolvedMode = modes[modeIndex].name;
      }

      await setMode(instance.base_url, sessionId, resolvedMode);
      await dbSetMode(projectPath, resolvedMode);

      return jsonResponse(res, 200, { ok: true, mode: resolvedMode, sessionId, index: modeIndex });
    }

    // ── POST /stop ────────────────────────────────────────────────────────
    if (pathname === "/stop" && method === "POST") {
      const body = await parseBody(req);
      const { project: projectPath, sessionId } = body;

      const instance = await getInstance(projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const activeSession = await getActiveSession(projectPath);
      const targetSessionId = sessionId ?? activeSession?.sessionId;
      if (!targetSessionId) return errorResponse(res, 400, "No active session");

      await abortSession(instance.base_url, targetSessionId);
      return jsonResponse(res, 200, { ok: true, sessionId: targetSessionId });
    }

    // ── POST /project/start ─────────────────────────────────────────────
    if (pathname === "/project/start" && method === "POST") {
      const body = await parseBody(req);
      const { project: projectPath } = body;
      if (!projectPath) return errorResponse(res, 400, "Missing 'project' in request body");

      try {
        const { projectStartCommand } = await import("./commands/project.js");
        await projectStartCommand(projectPath);
        const instance = await getInstance(projectPath);
        return jsonResponse(res, 200, {
          ok: true,
          projectPath,
          instance: instance ? { baseUrl: instance.base_url, port: instance.port, pid: instance.pid, status: instance.status } : null,
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

    // ── Code Search Proxy Routes ────────────────────────────────────────────
    // Proxy /api/search/* → code-search server at localhost:4098

    if (pathname.startsWith('/api/search/') && method === 'POST') {
      const codeSearchBody = await parseBody(req);
      const targetPath = pathname.slice('/api'.length); // /search/index → /api/search/index
      try {
        const csRes = await fetch(`http://localhost:4098${targetPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(codeSearchBody),
          signal: AbortSignal.timeout(300_000),
        });
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(res, 502, `Code-search server unreachable: ${err.message}`);
      }
    }

    if (pathname === '/api/search/stats' && method === 'GET') {
      const projectPath = url.searchParams.get('projectPath') ?? '';
      try {
        const csRes = await fetch(`http://localhost:4098/api/search/stats?projectPath=${encodeURIComponent(projectPath)}`);
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(res, 502, `Code-search server unreachable: ${err.message}`);
      }
    }

    if (pathname.startsWith('/api/search/index/') && method === 'DELETE') {
      const pathToRemove = pathname.slice('/api/search/index/'.length);
      try {
        const csRes = await fetch(`http://localhost:4098/api/search/index/${pathToRemove}`, {
          method: 'DELETE',
        });
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(res, 502, `Code-search server unreachable: ${err.message}`);
      }
    }

    if (pathname === '/api/search/watch/start' && method === 'POST') {
      const codeSearchBody = await parseBody(req);
      try {
        const csRes = await fetch('http://localhost:4098/api/search/watch/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(codeSearchBody),
        });
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(res, 502, `Code-search server unreachable: ${err.message}`);
      }
    }

    if (pathname === '/api/search/watch/stop' && method === 'POST') {
      try {
        const csRes = await fetch('http://localhost:4098/api/search/watch/stop', {
          method: 'POST',
        });
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(res, 502, `Code-search server unreachable: ${err.message}`);
      }
    }

    // Graph routes
    if (pathname.startsWith('/api/graph/') && method === 'GET') {
      const targetPath = pathname.slice('/api'.length);
      try {
        const csRes = await fetch(`http://localhost:4098${targetPath}${url.search}`);
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(res, 502, `Code-search server unreachable: ${err.message}`);
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

  fs.watch(watchDir, { recursive: true }, (_eventType, filename) => {
    if (filename?.endsWith(".js")) {
      restart();
    }
  });
}
