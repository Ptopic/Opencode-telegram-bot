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
 */
export async function sendPrompt(baseUrl, sessionId, text, agent) {
  const payload = { parts: [{ type: "text", text }] };
  if (agent) payload.agent = agent;
  const res = await createClient(baseUrl).post(`/session/${sessionId}/message`, payload);
  return extractReply(res.data);
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
  const rawAgents = Array.isArray(res?.data) ? res.data : [];
  // Only return the top-level orchestrator agents, not internal subagents
  const MAIN_AGENTS = new Set(["Sisyphus", "Hephaestus", "Prometheus", "Atlas"]);
  return rawAgents
    .filter((a) => a && typeof a === "object" && typeof a.name === "string" && MAIN_AGENTS.has(a.name))
    .map((a) => ({
      name: a.name.trim(),
      description: typeof a.description === "string" ? a.description.trim() : "",
    }));
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
