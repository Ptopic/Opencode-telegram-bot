/**
 * OpenCode HTTP API client.
 * Shares the same HTTP call patterns as the Telegram bot.
 */
import axios from "axios";

/**
 * Collect SSE reply events from an OpenCode event stream.
 * Mirrors the Telegram bot's SSE parsing logic exactly.
 */
async function collectSSEvents(baseUrl, sessionId, timeoutMs = 30000) {
  const url = `${baseUrl}/session/${sessionId}/event`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, chunk } = await reader.read();
      if (done) break;

      buffer += decoder.decode(chunk, { stream: true });

      // Split on SSE event boundary (double newline)
      const eventBlocks = buffer.split("\n\n");
      buffer = eventBlocks.pop() ?? ""; // keep last incomplete block in buffer

      for (const block of eventBlocks) {
        const lines = block.split("\n");
        // Merge continued data: lines (SSE can have multi-line data)
        const dataLines = [];
        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trim());
          }
        }
        if (!dataLines.length) continue;

        const joined = dataLines.join("\n");
        if (joined === "[DONE]") continue;

        let event;
        try { event = JSON.parse(joined); } catch { continue; }

        // Unwrap wrapper format { payload: { ... } }
        const payload = event?.payload ?? event;

        // Look for assistant messages with text parts — mirrors bot's isAssistantLikeMessage
        const messages = payload?.messages ?? payload?.data?.messages ?? [];
        for (const msg of messages) {
          const role = msg?.role ?? msg?.type ?? "";
          if (typeof role === "string" && role.toLowerCase() !== "assistant") continue;
          const text = msg?.content ?? msg?.text ?? "";
          if (typeof text === "string" && text.trim()) {
            clearTimeout(timeout);
            return text.trim();
          }
          // Also check parts array
          const parts = msg?.parts ?? msg?.content?.parts ?? [];
          for (const part of parts) {
            if (part?.type === "text" && part?.text?.trim()) {
              clearTimeout(timeout);
              return part.text.trim();
            }
          }
        }
      }
    }
  } catch {
    // Timeout or error
  } finally {
    clearTimeout(timeout);
  }

  return "";
}

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
 */
export async function sendPrompt(baseUrl, sessionId, text, agent) {
  const payload = { parts: [{ type: "text", text }] };
  if (agent) payload.agent = agent;

  // Start SSE listener in parallel with sending the message
  // Replies may come via event stream instead of HTTP response body
  const ssePromise = collectSSEvents(baseUrl, sessionId, 30000);

  let res;
  try {
    res = await createClient(baseUrl).post(`/session/${sessionId}/message`, payload);
  } catch (err) {
    throw err;
  }

  const direct = extractReply(res.data);
  if (direct) return direct;

  // Direct reply empty — wait for SSE reply
  return ssePromise;
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
      // Normalize and strip all invisible Unicode to get clean ASCII name
      name: agent.name.normalize("NFKD").replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, "").replace(/\s+/g, " ").trim(),
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
