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
import { loadServerConfig } from "./config.js";

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

console.log("This is a test for code search");

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
        projectRoots: projects.map((p) => ({
          type: "root",
          scope: p.scope,
          path: p.path,
          label: p.label,
        })),
      });
    }

    // ── GET /projects ───────────────────────────────────────────────────────
    if (pathname === "/projects" && method === "GET") {
      try {
        const projects = await listProjects();
        const instances = await listInstances();
        const _debug = {
          projectsCount: projects?.length ?? -1,
          instancesCount: instances?.length ?? -1,
          instances,
        };
        const result = projects.map((p) => ({
          type: "root",
          scope: p.scope,
          path: p.path,
          label: p.label,
        }));
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
      const projectPath = decodeURIComponent(
        pathname.slice("/sessions/".length),
      );
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
    if (
      pathname.startsWith("/sessions/") &&
      pathname.endsWith("/new") &&
      method === "POST"
    ) {
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

      if (!prompt)
        return errorResponse(res, 400, "Missing 'prompt' in request body");

      const instance = await getInstance(projectPath);

      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const sessionData = (await getActiveSession(projectPath)) ?? {};
      let targetSessionId = sessionId ?? sessionData.sessionId;

      if (!targetSessionId) {
        const sessions = await listSessions(instance.base_url);
        if (!sessions.length)
          return errorResponse(res, 404, "No sessions found");
        targetSessionId = sessions[sessions.length - 1].id;
      }

      // Auto-use saved mode unless caller explicitly passed one
      const effectiveAgent = agent ?? sessionData.mode ?? null;

      const reply = await sendPrompt(
        instance.base_url,
        targetSessionId,
        prompt,
        effectiveAgent,
      );

      return jsonResponse(res, 200, {
        projectPath,
        sessionId: targetSessionId,
        agent: effectiveAgent,
        reply: reply ?? "(no reply)",
      });
    }

    // ── POST /session/:sessionId/message ───────────────────────────────────
    // Fire-and-forget proxy to workspace runtime for real-time streaming.
    // Forwards to: POST {workspace_base_url}/session/{sessionId}/message
    // Returns 202 immediately; workspace processes async.
    if (pathname.match(/^\/session\/([^/]+)\/message$/) && method === "POST") {
      const sessionId = pathname
        .replace(/^\/session\//, "")
        .replace(/\/message$/, "");
      const body = await parseBody(req);

      const projectPath = body.project ?? null;
      if (!projectPath) {
        return errorResponse(res, 400, "Missing 'project' in request body");
      }

      const instance = await getInstance(projectPath);
      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      const payload = {
        parts: body.parts ?? [{ type: "text", text: body.text ?? "" }],
        mode: body.mode ?? null,
      };

      // Fire-and-forget: don't await the workspace response.
      // Detach the request so the proxy returns 202 immediately.
      const proxyReq = http.request(
        `${instance.base_url}/session/${sessionId}/message`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        },
        (proxyRes) => {
          // Discard workspace response — we don't need it
          proxyRes.on("data", () => {});
          proxyRes.on("end", () => {});
        },
      );
      proxyReq.on("error", () => {});
      proxyReq.write(JSON.stringify(payload));
      proxyReq.end();
      // Don't wait — let the proxy return while workspace processes in background
      return jsonResponse(res, 202, {
        ok: true,
        sessionId,
        message: "Prompt sent",
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
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      let seenCount = 0;
      const intervalMs = parseInt(
        url.searchParams.get("interval") ?? "2000",
        10,
      );

      let emptyPolls = 0;
      const MAX_EMPTY_POLLS = 5;
      const emittedPermissionIds = new Set();
      const showToolCalls = loadServerConfig().toolCallDisplay === true;

      const interval = setInterval(async () => {
        try {
          const messages = await getSessionMessages(
            instance.base_url,
            sessionId,
          );

          if (messages.length > seenCount) {
            const newMessages = messages.slice(seenCount);
            for (const msg of newMessages) {
              const role = getMessageRole(msg);
              if (!showToolCalls && role === "tool") continue;
              const data = JSON.stringify({
                type: "message",
                role,
                parts: getMessageParts(msg),
                ts: msg.ts,
              });
              res.write(`data: ${data}\n\n`);
            }
            seenCount = messages.length;
            emptyPolls = 0;
          }

          try {
            const permRes = await fetch(`${instance.base_url}/permission`, {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(5000),
            });
            if (permRes.ok) {
              const permPayload = await permRes.json();
              const pending = Array.isArray(permPayload)
                ? permPayload
                : Array.isArray(permPayload?.permissions)
                  ? permPayload.permissions
                  : Array.isArray(permPayload?.pending)
                    ? permPayload.pending
                    : [];
              for (const perm of pending) {
                const permId = perm?.id ?? perm?.permissionID ?? null;
                if (!permId || emittedPermissionIds.has(permId)) continue;
                if (perm.sessionID && perm.sessionID !== sessionId) continue;
                emittedPermissionIds.add(permId);
                const permEvent = {
                  type: "permission.asked",
                  id: permId,
                  sessionID: perm.sessionID ?? perm.sessionId ?? sessionId,
                  permission: perm.permission ?? null,
                  patterns: Array.isArray(perm.patterns) ? perm.patterns : [],
                  tool: perm.tool ?? perm.toolName ?? perm.permission ?? null,
                  metadata: perm.metadata ?? {},
                };
                res.write(`data: ${JSON.stringify(permEvent)}\n\n`);
                emptyPolls = 0;
              }
            }
          } catch {}

          if (messages.length <= seenCount) {
            emptyPolls++;
            if (emptyPolls >= MAX_EMPTY_POLLS && seenCount > 0) {
              res.write(
                `data: ${JSON.stringify({ type: "done", isFinished: false, reason: "timeout" })}\n\n`,
              );
              clearInterval(interval);
              res.end();
              return;
            } else if (emptyPolls > 0 && emptyPolls < MAX_EMPTY_POLLS) {
              res.write(
                `data: ${JSON.stringify({ type: "done", isFinished: false })}\n\n`,
              );
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

    // ── GET /watch-native/:project ─────────────────────────────────────────
    // Proxies OpenCode's native /event SSE stream, mapping session.idle
    // to our {type:"done",isFinished:true} format so clients know when
    // the session is truly finished (vs the polling-based /watch/:project
    // which can premature-close when OpenCode adds follow-up user messages).
    if (pathname.startsWith("/watch-native/") && method === "GET") {
      const projectPath = decodeURIComponent(
        pathname.slice("/watch-native/".length),
      );
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

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      let finished = false;
      const showToolCalls = loadServerConfig().toolCallDisplay === true;

      const sessionFilter = (event) => {
        // Match events for our session — sessionID may be at top level or nested
        const eventSessionId =
          event?.sessionID ??
          event?.sessionId ??
          event?.session?.id ??
          event?.info?.sessionID ??
          null;
        return String(eventSessionId) === String(sessionId);
      };

      const parseSseFrame = (raw) => {
        const lines = raw.split("\n");
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }
        const rawPayload = dataLines.join("\n").trim();
        if (!rawPayload || rawPayload === "[DONE]") return null;
        try {
          return JSON.parse(rawPayload);
        } catch {
          return null;
        }
      };

      let buffer = "";

      const stream = new ReadableStream({
        async start(controller) {
          let retryDelay = 1000;
          const maxRetryDelay = 10000;

          const fetchEvents = async () => {
            try {
              const sseRes = await fetch(`${instance.base_url}/global/event`, {
                headers: { Accept: "text/event-stream" },
              });

              if (!sseRes.ok || !sseRes.body) {
                throw new Error(`Event stream unavailable (${sseRes.status})`);
              }

              retryDelay = 1000;
              const reader = sseRes.body.getReader();
              const decoder = new TextDecoder();

              while (!finished) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder
                  .decode(value, { stream: true })
                  .replace(/\r\n/g, "\n");
                const frames = buffer.split("\n\n");
                buffer = frames.pop() ?? "";

                for (const frame of frames) {
                  if (finished) break;
                  const event = parseSseFrame(frame);
                  if (!event) continue;

                  const eventType =
                    typeof event.type === "string" ? event.type : "";

                  if (eventType === "session.idle" && sessionFilter(event)) {
                    if (!finished) {
                      finished = true;
                      const data = JSON.stringify({
                        type: "done",
                        isFinished: true,
                      });
                      res.write(`data: ${data}\n\n`);
                      // Don't close immediately - session.idle may arrive before all
                      // message events have been forwarded. Close after buffer drains
                      // or after timeout to ensure client receives all events.
                      setTimeout(() => {
                        if (!res.writableEnded) res.end();
                        controller.close();
                      }, 2000);
                    }
                    continue;
                  }

                  // ── Permission events ──────────────────────────────────────────
                  // Emit as first-class "permission.asked" events so consumers
                  // (OpenClaw skills, Telegram bots, etc.) can detect them and
                  // render approval/deny buttons.  The payload includes the
                  // permission ID, session ID, tool name and patterns needed to
                  // POST a reply back to OpenCode.
                  if (eventType === "permission.asked") {
                    const props = event.properties ?? event;
                    const permEvent = {
                      type: "permission.asked",
                      id: props.id ?? props.permissionID ?? null,
                      sessionID: props.sessionID ?? props.sessionId ?? null,
                      permission: props.permission ?? null,
                      patterns: Array.isArray(props.patterns)
                        ? props.patterns
                        : [],
                      tool:
                        props.tool ??
                        props.toolName ??
                        props.permission ??
                        null,
                      metadata: props.metadata ?? {},
                    };
                    const data = JSON.stringify(permEvent);
                    res.write(`data: ${data}\n\n`);
                    continue;
                  }

                  if (eventType === "permission.replied") {
                    const props = event.properties ?? event;
                    const permReplyEvent = {
                      type: "permission.replied",
                      id: props.id ?? props.permissionID ?? null,
                      sessionID: props.sessionID ?? props.sessionId ?? null,
                      reply: props.reply ?? props.response ?? null,
                    };
                    const data = JSON.stringify(permReplyEvent);
                    res.write(`data: ${data}\n\n`);
                    continue;
                  }

                  if (!showToolCalls) {
                    const msgRole =
                      event?.properties?.message?.role ?? event?.role ?? "";
                    if (
                      typeof msgRole === "string" &&
                      msgRole.toLowerCase() === "tool"
                    )
                      continue;
                  }

                  const data = JSON.stringify({
                    type: eventType || "event",
                    payload: event,
                  });
                  res.write(`data: ${data}\n\n`);
                }
              }
            } catch (err) {
              if (finished) return;
              console.warn(
                "Native event stream error, retrying in",
                retryDelay,
                err.message,
              );
              const data = JSON.stringify({
                type: "error",
                message: `stream error: ${err.message}, retrying...`,
              });
              res.write(`data: ${data}\n\n`);
              await new Promise((r) => setTimeout(r, retryDelay));
              retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
              if (!finished) fetchEvents();
            }
          };

          fetchEvents();
        },

        cancel() {
          finished = true;
        },
      });

      // Pipe the readable stream to the response
      stream.pipeTo(
        new WritableStream({
          write(chunk) {
            if (!res.writableEnded) res.write(chunk);
          },
          close() {
            if (!res.writableEnded) res.end();
          },
        }),
      );

      req.on("close", () => {
        finished = true;
      });

      return;
    }

    // ── RAW SSE DEBUG ──────────────────────────────────────────────────────
    if (pathname === "/debug/raw-sse" && method === "GET") {
      const sessionId = url.searchParams.get("session");
      if (!sessionId) return errorResponse(res, 400, "Missing ?session=");
      const instances = await listInstances();
      let baseUrl = null;
      for (const inst of instances) {
        if (inst?.status === "ready") {
          baseUrl = inst.base_url;
          break;
        }
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
            if (
              l.startsWith("data:") ||
              l.startsWith("event:") ||
              l.startsWith("id:")
            ) {
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
        if (inst?.status === "ready") {
          baseUrl = inst.base_url;
          break;
        }
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
            if (
              l.startsWith("data:") ||
              l.startsWith("event:") ||
              l.startsWith("id:") ||
              l.trim()
            ) {
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
      return jsonResponse(res, 200, {
        projectPath,
        baseUrl: instance.base_url,
        modes,
      });
    }

    // ── POST /modes/:project/mode ────────────────────────────────────────
    if (
      pathname.startsWith("/modes/") &&
      pathname.endsWith("/mode") &&
      method === "POST"
    ) {
      const projectPath = decodeURIComponent(
        pathname.slice("/modes/".length, -5),
      ); // strip "/mode"
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
          return errorResponse(
            res,
            400,
            `Mode index ${modeIndex} out of range (0-${modes.length - 1})`,
          );
        }
        resolvedMode = modes[modeIndex].name;
      }

      await setMode(instance.base_url, sessionId, resolvedMode);
      await dbSetMode(projectPath, resolvedMode);

      return jsonResponse(res, 200, {
        ok: true,
        mode: resolvedMode,
        sessionId,
        index: modeIndex,
      });
    }

    // ── POST /permission/respond ──────────────────────────────────────────
    // Approve or deny a pending permission request from OpenCode.
    // Body: { project, requestID, reply, message?, sessionId? }
    //   reply: "once" | "always" | "reject"
    if (pathname === "/permission/respond" && method === "POST") {
      const body = await parseBody(req);
      const { project: projectPath, requestID, reply, message } = body;

      if (!projectPath)
        return errorResponse(res, 400, "Missing 'project' in request body");
      if (!requestID)
        return errorResponse(res, 400, "Missing 'requestID' in request body");
      if (!["once", "always", "reject"].includes(reply)) {
        return errorResponse(
          res,
          400,
          'Invalid \'reply\' — must be "once", "always", or "reject"',
        );
      }

      const instance = await getInstance(projectPath);
      if (!instance || instance.status !== "ready") {
        return errorResponse(res, 404, "No running instance for this project");
      }

      try {
        const replyPayload = { reply, ...(message ? { message } : {}) };
        const replyRes = await fetch(
          `${instance.base_url}/permission/${encodeURIComponent(requestID)}/reply`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(replyPayload),
            signal: AbortSignal.timeout(10000),
          },
        );

        if (!replyRes.ok) {
          const errText = await replyRes.text().catch(() => "");
          return errorResponse(
            res,
            replyRes.status,
            `OpenCode permission reply failed: ${errText}`,
          );
        }

        const result = await replyRes.json().catch(() => ({}));
        return jsonResponse(res, 200, { ok: true, requestID, reply, result });
      } catch (err) {
        return errorResponse(
          res,
          502,
          `Failed to reach OpenCode: ${err.message}`,
        );
      }
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
      if (!projectPath)
        return errorResponse(res, 400, "Missing 'project' in request body");

      try {
        const { projectStartCommand } = await import("./commands/project.js");
        await projectStartCommand(projectPath);
        const instance = await getInstance(projectPath);
        return jsonResponse(res, 200, {
          ok: true,
          projectPath,
          instance: instance
            ? {
                baseUrl: instance.base_url,
                port: instance.port,
                pid: instance.pid,
                status: instance.status,
              }
            : null,
        });
      } catch (err) {
        return errorResponse(
          res,
          500,
          `Failed to start project: ${err.message}`,
        );
      }
    }

    // ── POST /project/stop ───────────────────────────────────────────────
    if (pathname === "/project/stop" && method === "POST") {
      const body = await parseBody(req);
      const { project: projectPath } = body;
      if (!projectPath)
        return errorResponse(res, 400, "Missing 'project' in request body");

      try {
        const { projectStopCommand } = await import("./commands/project.js");
        await projectStopCommand(projectPath);
        return jsonResponse(res, 200, { ok: true, projectPath });
      } catch (err) {
        return errorResponse(
          res,
          500,
          `Failed to stop project: ${err.message}`,
        );
      }
    }

    // ── Code Search Proxy Routes ────────────────────────────────────────────
    // Proxy /api/search/* → code-search server at localhost:4098

    if (pathname.startsWith("/api/search/") && method === "POST") {
      const codeSearchBody = await parseBody(req);
      const targetPath = pathname.slice("/api".length); // /search/index → /api/search/index
      try {
        const csRes = await fetch(`http://localhost:4098${targetPath}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(codeSearchBody),
          signal: AbortSignal.timeout(300_000),
        });
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(
          res,
          502,
          `Code-search server unreachable: ${err.message}`,
        );
      }
    }

    if (pathname === "/api/search/stats" && method === "GET") {
      const projectPath = url.searchParams.get("projectPath") ?? "";
      try {
        const csRes = await fetch(
          `http://localhost:4098/api/search/stats?projectPath=${encodeURIComponent(projectPath)}`,
        );
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(
          res,
          502,
          `Code-search server unreachable: ${err.message}`,
        );
      }
    }

    if (pathname.startsWith("/api/search/index/") && method === "DELETE") {
      const pathToRemove = pathname.slice("/api/search/index/".length);
      try {
        const csRes = await fetch(
          `http://localhost:4098/api/search/index/${pathToRemove}`,
          {
            method: "DELETE",
          },
        );
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(
          res,
          502,
          `Code-search server unreachable: ${err.message}`,
        );
      }
    }

    if (pathname === "/api/search/watch/start" && method === "POST") {
      const codeSearchBody = await parseBody(req);
      try {
        const csRes = await fetch(
          "http://localhost:4098/api/search/watch/start",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(codeSearchBody),
          },
        );
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(
          res,
          502,
          `Code-search server unreachable: ${err.message}`,
        );
      }
    }

    if (pathname === "/api/search/watch/stop" && method === "POST") {
      try {
        const csRes = await fetch(
          "http://localhost:4098/api/search/watch/stop",
          {
            method: "POST",
          },
        );
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(
          res,
          502,
          `Code-search server unreachable: ${err.message}`,
        );
      }
    }

    // Graph routes
    if (pathname.startsWith("/api/graph/") && method === "GET") {
      const targetPath = pathname.slice("/api".length);
      try {
        const csRes = await fetch(
          `http://localhost:4098${targetPath}${url.search}`,
        );
        const data = await csRes.json();
        return jsonResponse(res, csRes.status, data);
      } catch (err) {
        return errorResponse(
          res,
          502,
          `Code-search server unreachable: ${err.message}`,
        );
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
        text:
          typeof p.text === "string"
            ? p.text
            : typeof p.content === "string"
              ? p.content
              : "",
      }));
  }
  for (const key of ["text", "content", "message", "response", "reply"]) {
    const val = msg?.[key];
    if (typeof val === "string" && val.trim())
      return [{ type: "text", text: val.trim() }];
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
    console.log(
      "  POST /send                — send prompt { project, prompt, sessionId? }",
    );
    console.log("  GET  /watch/:project      — SSE stream of messages");
    console.log(
      "  POST /stop                — abort session { project, sessionId? }",
    );
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

  const repoRoot = path.resolve(
    fileURLToPath(import.meta.url),
    "..",
    "..",
    "..",
    "..",
  );
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
