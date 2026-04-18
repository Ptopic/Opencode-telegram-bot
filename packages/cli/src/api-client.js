/**
 * OpenCode HTTP API client.
 * Shares the same HTTP call patterns as the Telegram bot.
 */
import axios from "axios";

const DEFAULT_TIMEOUT_MS = 120_000;

function createClient(baseUrl) {
  const client = axios.create({ baseURL: baseUrl, timeout: DEFAULT_TIMEOUT_MS });
  return client;
}

/**
 * Health check an OpenCode instance.
 * @returns {{ ok: boolean, version?: string, reason?: string }}
 */
export async function probeHealth(baseUrl) {
  try {
    const res = await axios.get(`${baseUrl}/global/health`, { timeout: 5000 });
    const payload = res?.data ?? {};
    if (payload?.healthy !== true) return { ok: false, reason: "Instance reported unhealthy" };
    return { ok: true, version: payload?.version };
  } catch (err) {
    return { ok: false, reason: err?.message || "Connection failed" };
  }
}

/**
 * List all sessions on an OpenCode instance.
 */
export async function listSessions(baseUrl) {
  const res = await createClient(baseUrl).get("/session");
  return res.data?.sessions ?? res.data ?? [];
}

/**
 * Get a single session by ID.
 */
export async function getSession(baseUrl, sessionId) {
  const res = await createClient(baseUrl).get(`/session/${sessionId}`);
  return res.data;
}

/**
 * Create a new session.
 */
export async function createSession(baseUrl, { title, directory, cwd }) {
  const res = await createClient(baseUrl).post("/session", {
    title: title || `cli-session-${Date.now()}`,
    directory,
    cwd: cwd || directory,
  });
  return res.data;
}

/**
 * Delete a session.
 */
export async function deleteSession(baseUrl, sessionId) {
  await createClient(baseUrl).delete(`/session/${sessionId}`);
}

/**
 * Send a prompt to a session and return the reply text.
 * Uses POST /session/{id}/message { parts: [{ type: "text", text }], agent? }
 * Falls back to SSE event stream if direct reply is empty (mirrors Telegram bot behavior).
 */
export async function sendPrompt(baseUrl, sessionId, text, agent) {
  const payload = { parts: [{ type: "text", text }] };
  if (agent) payload.agent = agent;
  const res = await createClient(baseUrl).post(`/session/${sessionId}/message`, payload);
  const directReply = extractReply(res.data);
  if (directReply) return directReply;

  // Direct reply empty — recover via SSE event stream (same as Telegram bot)
  return recoverReplyFromEventStream(baseUrl, sessionId);
}

// ── SSE recovery helpers (mirrors Telegram bot) ──────────────────────────────

function unwrapSsePayload(payload) {
  if (payload && typeof payload === "object" && payload.payload && typeof payload.payload === "object") {
    return payload.payload;
  }
  return payload;
}

function getEventSessionId(event) {
  for (const key of [
    "sessionID", "sessionId", "session.id",
    "info.sessionID", "info.sessionId", "info.session.id",
    "properties.sessionID", "properties.sessionId", "properties.session.id",
    "properties.info.sessionID", "properties.info.sessionId",
  ]) {
    const val = key.includes(".")
      ? key.split(".").reduce((o, k) => o?.[k], event)
      : event?.[key];
    if (typeof val === "string" && val) return val;
  }
  return null;
}

function parseSseJsonEvents(chunkBuffer) {
  const events = [];
  let buffer = chunkBuffer;
  let sep;
  while ((sep = buffer.indexOf("\n\n")) >= 0) {
    const frame = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    const lines = frame.split("\n");
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const raw = dataLines.join("\n").trim();
    if (raw && raw !== "[DONE]") {
      try { events.push(JSON.parse(raw)); } catch {}
    }
  }
  return { events, buffer };
}

async function fetchSessionMessages(baseUrl, sessionId) {
  try {
    const res = await createClient(baseUrl).get(`/session/${sessionId}/message`, {
      timeout: 15000,
      params: { limit: 500 },
    });
    const payload = res?.data;
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.messages)) return payload.messages;
  } catch {}
  return [];
}

function extractReplyFromMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractReply(messages[i]);
    if (text) return text;
  }
  return "";
}

async function waitForSessionIdle(baseUrl, sessionId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const remaining = Math.max(deadline - Date.now(), 1);
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      let response = await fetch(`${baseUrl}/event`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        response = await fetch(`${baseUrl}/global/event`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
      }
      if (!response.ok || !response.body) throw new Error(`Event stream unavailable (${response.status})`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (Date.now() < deadline) {
        const { done, value } = await reader.read();
        if (done || !value) break;

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        const { events, buffer: newBuf } = parseSseJsonEvents(buffer);
        buffer = newBuf;

        for (const rawEvent of events) {
          const event = unwrapSsePayload(rawEvent);
          if (!event || typeof event !== "object") continue;
          if (getEventSessionId(event) !== sessionId) continue;

          const eventType = typeof event.type === "string" ? event.type : "";
          if (eventType === "session.idle") {
            clearTimeout(timer);
            controller.abort();
            return;
          }
          if (eventType === "session.error") {
            clearTimeout(timer);
            controller.abort();
            throw new Error(String(event?.properties?.error ?? event?.properties?.message ?? "session error"));
          }
        }
      }
    } catch {
      // retry
    } finally {
      clearTimeout(timer);
    }

    await new Promise((r) => setTimeout(r, 200));
  }
}

async function recoverReplyFromEventStream(baseUrl, sessionId) {
  try {
    await waitForSessionIdle(baseUrl, sessionId);
    const messages = await fetchSessionMessages(baseUrl, sessionId);
    return extractReplyFromMessages(messages);
  } catch {
    return "";
  }
}

/**
 * Abort current execution in a session.
 */
export async function abortSession(baseUrl, sessionId) {
  await createClient(baseUrl).post(`/session/${sessionId}/abort`, {});
}

/**
 * Get available agent modes.
 * OpenCode /agent returns an array of agent descriptors.
 */
export async function listModes(baseUrl) {
  const res = await createClient(baseUrl).get("/agent", { timeout: 10_000 });
  const rawAgents = Array.isArray(res?.data)
    ? res.data
    : Array.isArray(res?.data?.agents)
    ? res.data.agents
    : [];

  const modes = rawAgents
    .filter((agent) => agent && typeof agent === "object")
    .filter((agent) => typeof agent.name === "string" && agent.name.trim() !== "")
    .filter((agent) => {
      const mode = typeof agent.mode === "string" ? agent.mode.toLowerCase() : "";
      if (mode === "subagent") return false;
      // Only include agents with a non-empty description (filters out internal agents like compaction/summary/title)
      const description = typeof agent.description === "string" ? agent.description.trim() : "";
      if (!description) return false;
      return true;
    })
    .map((agent) => ({
      name: agent.name.replace(/^[\u200B\u200C\u200D\uFEFF\u00A0\s]+/, "").replace(/[\u200B\u200C\u200D\uFEFF\u00A0\s]+$/, ""),
      description: typeof agent.description === "string" ? agent.description.trim() : "",
    }));

  modes.sort((a, b) => {
    const rank = (name) => {
      const lower = name.toLowerCase();
      if (lower === "build") return 0;
      if (lower === "plan") return 1;
      return 10;
    };
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  });

  return modes;
}

/**
 * Set the agent mode for a session.
 */
export async function setMode(baseUrl, sessionId, modeName) {
  await createClient(baseUrl).post(`/session/${sessionId}/mode`, { mode: modeName });
}

/**
 * List session messages.
 */
export async function getSessionMessages(baseUrl, sessionId) {
  const res = await createClient(baseUrl).get(`/session/${sessionId}/message`);
  return res.data?.messages ?? res.data ?? [];
}

/**
 * Extract reply text from an OpenCode response, trying multiple common shapes.
 */
function extractReply(data) {
  if (!data) return "";

  // Top-level candidates
  for (const key of ["response", "message", "reply", "outputText", "text", "content"]) {
    if (typeof data[key] === "string" && data[key].trim()) return data[key].trim();
  }

  // result wrapper
  for (const key of ["result", "data"]) {
    const val = data[key];
    if (typeof val === "string" && val.trim()) return val.trim();
    if (val && typeof val === "object" && typeof val.text === "string") return val.text.trim();
  }

  // choices[0].message.content (OpenAI-compatible)
  const choiceText = data?.choices?.[0]?.message?.content;
  if (typeof choiceText === "string" && choiceText.trim()) return choiceText.trim();

  // parts array
  if (Array.isArray(data?.parts)) {
    const text = data.parts
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }

  return "";
}
