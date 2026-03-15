import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import { readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const TYPING_INTERVAL_MS = 4000;
const COMMAND_REFRESH_MS = 10 * 60 * 1000;
const COMMAND_CACHE_MS = 2 * 60 * 1000;
const MODE_CACHE_MS = 2 * 60 * 1000;
const WORKSPACE_HEALTH_TIMEOUT_MS = 20000;
const WORKSPACE_HEALTH_POLL_MS = 400;
const PROJECT_BUTTON_LIMIT = 80;
const INTERACTION_REQUEST_TIMEOUT_MS = Number(process.env.OPENCODE_INTERACTION_TIMEOUT_MS) || 45000;
const INTERACTION_RETRY_LIMIT = 1;
const EVENT_STREAM_TIMEOUT_MS = Number(process.env.OPENCODE_EVENT_STREAM_TIMEOUT_MS) || 240000;
const EVENT_STREAM_RETRY_BASE_MS = 1000;
const EVENT_STREAM_RETRY_MAX_MS = 10000;
const TELEGRAM_MESSAGE_MAX_LENGTH = 3900;
const TELEGRAM_SYNC_MESSAGE_LIMIT = 80;
const TELEGRAM_CLEAR_BATCH_SIZE = 50;
const TELEGRAM_LIVE_SYNC_INTERVAL_MS = Number(process.env.OPENCODE_TELEGRAM_LIVE_SYNC_INTERVAL_MS) || 5000;
const TELEGRAM_LIVE_SYNC_MAX_TRACKED_KEYS = 2000;
const TELEGRAM_SYNC_FINAL_ONLY = process.env.OPENCODE_TELEGRAM_SYNC_FINAL_ONLY !== "false";
const TELEGRAM_SYNC_INCLUDE_THINKING = process.env.OPENCODE_TELEGRAM_SYNC_INCLUDE_THINKING === "true";
const TELEGRAM_SYNC_INCLUDE_CODE_CHANGES = process.env.OPENCODE_TELEGRAM_SYNC_INCLUDE_CODE_CHANGES === "true";
const TELEGRAM_SYNC_MIRROR_USER_MESSAGES = process.env.OPENCODE_TELEGRAM_SYNC_MIRROR_USER_MESSAGES !== "false";
const TELEGRAM_SYNC_USER_PREFIX = process.env.OPENCODE_TELEGRAM_SYNC_USER_PREFIX || "❓";

const PROJECT_ROOTS = [
    { scope: "petar", path: "/Users/petartopic/Desktop/Petar", label: "Petar" },
    { scope: "profico", path: "/Users/petartopic/Desktop/Profico", label: "Profico" },
];

const BUILTIN_TELEGRAM_COMMANDS = [
    { command: "session", description: "Show current OpenCode session" },
    { command: "sessions", description: "List sessions with slugs" },
    { command: "refresh", description: "Resync Telegram chat from OpenCode session" },
    { command: "clear_sessions", description: "Delete all sessions in current project (/clear-sessions also works)" },
    { command: "projects", description: "List Desktop projects" },
    { command: "new", description: "Start a new OpenCode session" },
    { command: "switch", description: "Switch to session id" },
    { command: "run", description: "Send prompt text to OpenCode" },
    { command: "mode", description: "Set OpenCode mode (agent)" },
    { command: "commandsync", description: "Refresh Telegram commands" },
    { command: "help", description: "Show available commands" },
];

const FALLBACK_COMMANDS = [
    { name: "init", description: "Initialize project context" },
    { name: "undo", description: "Undo last change" },
    { name: "redo", description: "Redo last undone change" },
    { name: "share", description: "Share current session" },
];

const activeProjectPathByChat = new Map();
const sessionByChatProject = new Map();
const sessionDirectoryByChatProject = new Map();
const sessionProjectPathById = new Map();
const projectDirectoryByChat = new Map();
const workspaceRuntimeByProjectPath = new Map();
const commandAliasByProjectPath = new Map();
const commandCacheByProjectPath = new Map();
const modeCacheByProjectPath = new Map();
const telegramCommandMap = new Map();
const trackedMessageIdsByChat = new Map();
const seenSessionMessageKeysByChatProject = new Map();
const selectedModeByChatProject = new Map();

let liveSyncInFlight = false;

function trackMessageId(chatId, messageId) {
    if (typeof messageId !== "number") return;

    const existing = trackedMessageIdsByChat.get(chatId) ?? [];
    existing.push(messageId);
    trackedMessageIdsByChat.set(chatId, existing);
}

async function sendTrackedMessage(chatId, text, options) {
    const sent = await bot.sendMessage(chatId, text, options);
    trackMessageId(chatId, sent?.message_id);
    return sent;
}

function isIgnorableTelegramCallbackError(err) {
    const description = err?.response?.body?.description ?? err?.message ?? "";
    if (typeof description !== "string") return false;
    const normalized = description.toLowerCase();
    return (
        normalized.includes("query is too old") ||
        normalized.includes("query id is invalid")
    );
}

async function answerCallbackQuerySafely(queryId, options) {
    if (!queryId) return;
    try {
        await bot.answerCallbackQuery(queryId, options);
    } catch (err) {
        if (isIgnorableTelegramCallbackError(err)) {
            console.warn("Ignoring stale Telegram callback query", {
                queryId,
                description: err?.response?.body?.description ?? err?.message,
            });
            return;
        }

        console.error("Failed answering callback query", {
            queryId,
            description: err?.response?.body?.description ?? err?.message,
        });
    }
}

async function clearTrackedMessages(chatId) {
    const ids = trackedMessageIdsByChat.get(chatId) ?? [];
    trackedMessageIdsByChat.delete(chatId);
    
    if (ids.length === 0) return;

    const uniqueIds = [...new Set(ids)].sort((a, b) => b - a);

    // Delete messages in batches for better performance
    const deletePromises = [];
    for (const messageId of uniqueIds) {
        deletePromises.push(
            bot.deleteMessage(chatId, String(messageId)).catch(() => {
                // Message may not exist or be too old to delete
            }),
        );

        // Process in batches to avoid overwhelming the API
        if (deletePromises.length >= TELEGRAM_CLEAR_BATCH_SIZE) {
            await Promise.all(deletePromises);
            deletePromises.length = 0;
        }
    }

    // Wait for remaining deletions
    if (deletePromises.length > 0) {
        await Promise.all(deletePromises);
    }
}

function getTextFromParts(parts) {
    if (!Array.isArray(parts)) return "";

    return parts
        .map((part) => {
            if (!part || typeof part !== "object") return "";

            const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
            if (type === "reasoning" && !TELEGRAM_SYNC_INCLUDE_THINKING) return "";
            if (type && !["text", "reasoning"].includes(type)) return "";

            if (typeof part.text === "string") return part.text;
            if (typeof part.value === "string") return part.value;
            if (typeof part.content === "string") return part.content;

            if (Array.isArray(part.content)) {
                return part.content
                    .map((item) => {
                        if (!item || typeof item !== "object") return "";
                        if (typeof item.text === "string") return item.text;
                        if (typeof item.content === "string") return item.content;
                        return "";
                    })
                    .filter(Boolean)
                    .join("\n");
            }

            return "";
        })
        .join("\n")
        .trim();
}

function extractReply(data) {
    if (typeof data === "string") return data.trim();
    if (!data || typeof data !== "object") return "";

    const directCandidates = [
        data.response,
        data.message,
        data.reply,
        data.outputText,
        data.text,
        data.content,
        data.result?.text,
        data.result?.content,
        data.message?.content,
        data.message?.text,
    ];
    for (const value of directCandidates) {
        if (typeof value === "string" && value.trim() !== "") {
            return value.trim();
        }
    }

    const partCandidates = [
        data.parts,
        data.result?.parts,
        data.message?.parts,
        data.content,
        data.result?.content,
        data.message?.content,
        data.output,
    ];
    for (const parts of partCandidates) {
        const text = getTextFromParts(parts);
        if (text) return text;
    }

    const choiceText = data.choices?.[0]?.message?.content;
    if (typeof choiceText === "string" && choiceText.trim() !== "") {
        return choiceText.trim();
    }

    if (Array.isArray(choiceText)) {
        const text = choiceText
            .filter((part) => part && part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n")
            .trim();
        if (text) return text;
    }

    return "";
}

function looksLikeHtmlDocument(text) {
    return typeof text === "string" && /<!doctype html>/i.test(text);
}

function startTyping(chatId) {
    const sendTyping = () => {
        bot.sendChatAction(chatId, "typing").catch(() => {});
    };

    sendTyping();
    const timer = setInterval(sendTyping, TYPING_INTERVAL_MS);

    return () => clearInterval(timer);
}

function sanitizeTelegramCommand(name) {
    if (typeof name !== "string") return null;

    let command = name.trim().replace(/^\/+/, "").toLowerCase();
    command = command.replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_");
    command = command.replace(/^_+|_+$/g, "");

    if (!command) return null;
    if (!/^[a-z]/.test(command)) command = `cmd_${command}`;

    return command.slice(0, 32);
}

function slugifyTitle(title) {
    if (typeof title !== "string") return "";

    return title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
}

function sanitizeProjectSlug(value) {
    if (typeof value !== "string") return "";

    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
}

function shortSessionSuffix(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return "unknown";
    if (sessionId.startsWith("ses_")) return sessionId.slice(4, 8).toLowerCase();
    return sessionId.slice(0, 4).toLowerCase();
}

function defaultSessionTitle(chatId, workspaceName) {
    return workspaceName ? `telegram-${chatId}-${workspaceName}` : `telegram-${chatId}`;
}

function truncateText(value, maxLength) {
    if (typeof value !== "string") return "";
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 1)}...`;
}

function getChatProjectKey(chatId, projectPath) {
    return `${chatId}::${projectPath}`;
}

function parseChatProjectKey(value) {
    if (typeof value !== "string") return null;
    const splitAt = value.indexOf("::");
    if (splitAt <= 0 || splitAt >= value.length - 2) return null;

    const chatIdRaw = value.slice(0, splitAt);
    const projectPath = value.slice(splitAt + 2);
    const chatId = Number(chatIdRaw);
    if (!Number.isFinite(chatId)) return null;

    return { chatId, projectPath };
}

function normalizePath(value) {
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    if (trimmed === "") return null;

    const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
    return withoutTrailingSlash || "/";
}

function getSessionProjectPath(session) {
    const candidateValues = [
        session?.cwd,
        session?.projectPath,
        session?.workspacePath,
        session?.directory,
        session?.workingDirectory,
        session?.workdir,
        session?.meta?.cwd,
        session?.meta?.projectPath,
        session?.metadata?.cwd,
        session?.metadata?.projectPath,
        session?.context?.cwd,
        session?.context?.projectPath,
        session?.config?.cwd,
        session?.config?.projectPath,
    ];

    for (const candidate of candidateValues) {
        const normalized = normalizePath(candidate);
        if (normalized) return normalized;
    }

    return null;
}

function sessionBelongsToProject(session, projectPath) {
    const normalizedProjectPath = normalizePath(projectPath);
    if (!normalizedProjectPath) return false;

    const sessionPath = getSessionProjectPath(session);
    if (sessionPath) {
        return sessionPath === normalizedProjectPath || sessionPath.startsWith(`${normalizedProjectPath}/`);
    }

    const sessionId = typeof session?.id === "string" ? session.id : "";
    if (!sessionId) return false;

    const rememberedPath = sessionProjectPathById.get(sessionId);
    const normalizedRememberedPath = normalizePath(rememberedPath);
    if (!normalizedRememberedPath) return false;

    return (
        normalizedRememberedPath === normalizedProjectPath ||
        normalizedRememberedPath.startsWith(`${normalizedProjectPath}/`)
    );
}

function parseTimestamp(value) {
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? time : 0;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
        if (value > 9_000_000_000_000_000) return Math.floor(value / 1_000_000);
        if (value > 9_000_000_000_000) return Math.floor(value / 1_000);
        if (value < 1_000_000_000_000) return value * 1000;
        return value;
    }

    if (typeof value === "string" && value.trim() !== "") {
        const asNumber = Number(value);
        if (Number.isFinite(asNumber)) {
            if (asNumber > 9_000_000_000_000_000) return Math.floor(asNumber / 1_000_000);
            if (asNumber > 9_000_000_000_000) return Math.floor(asNumber / 1_000);
            if (asNumber < 1_000_000_000_000) return asNumber * 1000;
            return asNumber;
        }

        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) return parsed;
    }

    return 0;
}

function collectTimestampCandidates(value, keyPattern, depth = 0) {
    if (depth > 3 || !value || typeof value !== "object") return [];

    const output = [];

    if (Array.isArray(value)) {
        for (const item of value) {
            output.push(...collectTimestampCandidates(item, keyPattern, depth + 1));
        }
        return output;
    }

    for (const [key, candidate] of Object.entries(value)) {
        if (keyPattern.test(key)) {
            output.push(candidate);
        }

        output.push(...collectTimestampCandidates(candidate, keyPattern, depth + 1));
    }

    return output;
}

function parseUlidTimestamp(value) {
    if (typeof value !== "string" || value === "") return 0;

    const raw = value.startsWith("ses_") ? value.slice(4) : value;
    if (!/^[0-9A-HJKMNP-TV-Z]{26}/.test(raw)) return 0;

    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let result = 0;
    for (let i = 0; i < 10; i += 1) {
        const index = alphabet.indexOf(raw[i]);
        if (index < 0) return 0;
        result = result * 32 + index;
    }

    return Number.isFinite(result) ? result : 0;
}

function getSessionCreatedTimestamp(session) {
    const createdCandidates = [
        session?.time?.created,
        session?.time?.createdAt,
        session?.createdAt,
        session?.created_at,
        session?.created,
        session?.startTime,
        session?.startedAt,
        session?.meta?.createdAt,
        session?.metadata?.createdAt,
        ...collectTimestampCandidates(session, /created|start/i),
    ];

    for (const candidate of createdCandidates) {
        const parsed = parseTimestamp(candidate);
        if (parsed > 0) return parsed;
    }

    const updatedFallback = [
        session?.time?.updated,
        session?.time?.updatedAt,
        session?.updatedAt,
        session?.updated_at,
        session?.updated,
        ...collectTimestampCandidates(session, /updated|modified|last/i),
    ];
    for (const candidate of updatedFallback) {
        const parsed = parseTimestamp(candidate);
        if (parsed > 0) return parsed;
    }

    const sessionId = typeof session?.id === "string" ? session.id : "";
    const parsedFromId = parseUlidTimestamp(sessionId);
    if (parsedFromId > 0) return parsedFromId;

    return 0;
}

function getSessionUpdatedTimestamp(session) {
    const updatedCandidates = [
        session?.time?.updated,
        session?.time?.updatedAt,
        session?.updatedAt,
        session?.updated_at,
        session?.updated,
        session?.lastUpdated,
        session?.last_message_at,
        session?.lastMessageAt,
        session?.lastActivityAt,
        session?.last_activity_at,
        session?.meta?.updatedAt,
        session?.metadata?.updatedAt,
        ...collectTimestampCandidates(session, /updated|modified|last|activity/i),
    ];

    for (const candidate of updatedCandidates) {
        const parsed = parseTimestamp(candidate);
        if (parsed > 0) return parsed;
    }

    return 0;
}

function getSessionActivityTimestamp(session) {
    const updated = getSessionUpdatedTimestamp(session);
    if (updated > 0) return updated;

    return getSessionCreatedTimestamp(session);
}

function getSessionStateText(session) {
    const candidates = [
        session?.state,
        session?.status,
        session?.lifecycle?.state,
        session?.meta?.state,
        session?.metadata?.state,
        session?.session?.state,
    ];

    for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;
        const state = candidate.trim().toLowerCase();
        if (state) return state;
    }

    return "";
}

function pickOpenCodeCurrentSessionId(sessions) {
    if (!Array.isArray(sessions) || sessions.length === 0) return null;

    for (const session of sessions) {
        const id = typeof session?.id === "string" ? session.id : "";
        if (!id) continue;

        const flagCandidates = [
            session?.current,
            session?.isCurrent,
            session?.active,
            session?.isActive,
            session?.selected,
            session?.isSelected,
            session?.meta?.current,
            session?.meta?.active,
            session?.metadata?.current,
            session?.metadata?.active,
            session?.session?.current,
        ];

        if (flagCandidates.some((value) => value === true)) {
            return id;
        }

        const state = getSessionStateText(session);
        if (["current", "active", "selected", "running"].includes(state)) {
            return id;
        }
    }

    return null;
}

function buildSessionDirectory(sessions) {
    const items = [];
    const slugToSessionId = new Map();
    const sessionIdToSlug = new Map();
    const sessionIdToTitle = new Map();
    const usedSlugs = new Set();

    for (const session of sessions) {
        const id = typeof session?.id === "string" ? session.id : "";
        if (!id) continue;

        const rawTitle = typeof session?.title === "string" && session.title.trim() !== "" ? session.title.trim() : id;
        const base = slugifyTitle(rawTitle) || "session";
        const suffix = shortSessionSuffix(id);

        let slug = `${base}-${suffix}`;
        let idx = 2;
        while (usedSlugs.has(slug)) {
            slug = `${base}-${suffix}-${idx}`;
            idx += 1;
        }

        usedSlugs.add(slug);
        slugToSessionId.set(slug, id);
        sessionIdToSlug.set(id, slug);
        sessionIdToTitle.set(id, rawTitle);
        items.push({ id, title: rawTitle, slug });
    }

    return { items, slugToSessionId, sessionIdToSlug, sessionIdToTitle };
}

function describeSession(directory, sessionId) {
    const slug = directory?.sessionIdToSlug?.get(sessionId) ?? `session-${shortSessionSuffix(sessionId)}`;
    const title = directory?.sessionIdToTitle?.get(sessionId) ?? sessionId;
    return `slug: ${slug} | title: ${title}`;
}

function getSessionButtons(directory, currentSessionId) {
    return directory.items.slice(0, 30).map((item) => {
        const activeMark = item.id === currentSessionId ? "* " : "";
        return [
            {
                text: `${activeMark}${truncateText(item.slug, 60)}`,
                callback_data: `switch:${item.slug}`,
            },
        ];
    });
}

function getProjectButtons(directory) {
    return directory.items.slice(0, PROJECT_BUTTON_LIMIT).map((item) => [
        {
            text: truncateText(`${item.label} / ${item.name}`, 60),
            callback_data: `project:${item.slug}`,
        },
    ]);
}

function parseProjectFromPath(projectPath) {
    for (const root of PROJECT_ROOTS) {
        if (projectPath === root.path || projectPath.startsWith(`${root.path}/`)) {
            const name = projectPath.slice(root.path.length + 1);
            return { scope: root.scope, label: root.label, name };
        }
    }

    const segments = projectPath.split("/").filter(Boolean);
    return {
        scope: "custom",
        label: "Project",
        name: segments[segments.length - 1] || projectPath,
    };
}

function isRecoverableWorkspaceError(err) {
    const code = err?.code;
    if (["ECONNABORTED", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET"].includes(code)) {
        return true;
    }

    const status = err?.response?.status;
    if (typeof status === "number" && status >= 500) {
        return true;
    }

    return false;
}

function shouldRetryWorkspaceInteraction(err) {
    const code = err?.code;
    if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)) {
        return true;
    }

    const status = err?.response?.status;
    if (typeof status === "number" && status >= 500) {
        return true;
    }

    return false;
}

function unwrapSsePayload(payload) {
    if (payload && typeof payload === "object" && payload.payload && typeof payload.payload === "object") {
        return payload.payload;
    }

    return payload;
}

function getEventSessionId(event) {
    const candidates = [
        event?.sessionID,
        event?.sessionId,
        event?.session?.id,
        event?.info?.sessionID,
        event?.info?.sessionId,
        event?.info?.session?.id,
        event?.properties?.sessionID,
        event?.properties?.sessionId,
        event?.properties?.session?.id,
        event?.properties?.info?.sessionID,
        event?.properties?.info?.sessionId,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate !== "") return candidate;
    }

    return null;
}

function parseSseJsonEvents(chunkBuffer) {
    const events = [];
    let buffer = chunkBuffer;
    let separatorIndex = buffer.indexOf("\n\n");

    while (separatorIndex >= 0) {
        const frame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const lines = frame.split("\n");
        const dataLines = [];
        for (const line of lines) {
            if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trimStart());
            }
        }

        const rawPayload = dataLines.join("\n").trim();
        if (rawPayload && rawPayload !== "[DONE]") {
            try {
                events.push(JSON.parse(rawPayload));
            } catch {}
        }

        separatorIndex = buffer.indexOf("\n\n");
    }

    return { events, buffer };
}

function isAssistantLikeMessage(message) {
    return getMessageRole(message) === "assistant";
}

function getSessionMessages(data) {
    const isMessageLike = (candidate) => {
        if (!candidate || typeof candidate !== "object") return false;
        if (typeof candidate.role === "string") return true;
        if (typeof candidate.type === "string") return true;
        if (Array.isArray(candidate.parts)) return true;
        if (typeof candidate.content === "string") return true;
        if (Array.isArray(candidate.content)) return true;
        if (typeof candidate.message === "string") return true;
        if (typeof candidate.response === "string") return true;
        if (typeof candidate.text === "string") return true;
        return false;
    };

    const collectMessageArrays = (value, depth = 0) => {
        if (depth > 4 || !value || typeof value !== "object") return [];
        const arrays = [];

        if (Array.isArray(value)) {
            if (value.length > 0 && value.some((item) => isMessageLike(item))) {
                arrays.push(value);
            }

            for (const item of value) {
                arrays.push(...collectMessageArrays(item, depth + 1));
            }
            return arrays;
        }

        for (const nested of Object.values(value)) {
            arrays.push(...collectMessageArrays(nested, depth + 1));
        }

        return arrays;
    };

    const objectCollections = [
        data?.messages,
        data?.session?.messages,
        data?.result?.messages,
        data?.data?.messages,
    ]
        .filter((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate))
        .map((candidate) => Object.values(candidate).filter((item) => item && typeof item === "object"));

    const directArrays = [
        data?.messages,
        data?.session?.messages,
        data?.result?.messages,
        data?.data?.messages,
        ...collectTimestampCandidates(data, /messages?/i),
        ...collectMessageArrays(data),
        ...objectCollections,
    ];

    return directArrays.filter((candidate) => Array.isArray(candidate));
}

function extractLatestAssistantReplyFromSession(data) {
    const messageArrays = getSessionMessages(data);

    for (const messages of messageArrays) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const message = messages[i];
            if (!message || typeof message !== "object") continue;
            if (!isAssistantLikeMessage(message)) continue;

            const text = extractReply(message);
            if (text) return text;
        }
    }

    for (const messages of messageArrays) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
            const message = messages[i];
            if (!message || typeof message !== "object") continue;

            const text = extractReply(message);
            if (text) return text;
        }
    }

    return "";
}

function getMessageRole(message) {
    const candidates = [
        message?.role,
        message?.type,
        message?.info?.role,
        message?.info?.type,
        message?.author?.role,
        message?.info?.role,
        message?.metadata?.role,
        message?.properties?.role,
    ];

    for (const candidate of candidates) {
        if (typeof candidate !== "string") continue;

        const role = candidate.toLowerCase();
        if (["assistant", "user", "system", "tool"].includes(role)) {
            return role;
        }
    }

    return null;
}

function formatSessionMessageForTelegram(message) {
    const text = extractReply(message);
    const patchSummary = TELEGRAM_SYNC_INCLUDE_CODE_CHANGES ? buildPatchSummaryForMessage(message) : "";

    if (!text && !patchSummary) return null;

    const role = getMessageRole(message);
    const prefix = role === "assistant" ? "OpenCode" : role === "system" ? "System" : "Message";

    if (role === "user") {
        if (text && patchSummary) {
            return `${TELEGRAM_SYNC_USER_PREFIX} ${text}\n\n${patchSummary}`;
        }
        if (text) {
            return `${TELEGRAM_SYNC_USER_PREFIX} ${text}`;
        }
        return patchSummary;
    }

    if (text && patchSummary) {
        return `${prefix}:\n${text}\n\n${patchSummary}`;
    }

    if (text) {
        return `${prefix}:\n${text}`;
    }

    return `${prefix}:\n${patchSummary}`;
}

function shouldSyncMessageToTelegram(message) {
    const role = getMessageRole(message);
    const hasText = extractReply(message) !== "";
    const hasPatchSummary = TELEGRAM_SYNC_INCLUDE_CODE_CHANGES && buildPatchSummaryForMessage(message) !== "";
    if (!hasText && !hasPatchSummary) return false;

    if (!TELEGRAM_SYNC_FINAL_ONLY) {
        if (role === "user" && !TELEGRAM_SYNC_MIRROR_USER_MESSAGES) return false;
        return true;
    }

    if (role === "assistant") return true;
    if (role === "user") return TELEGRAM_SYNC_MIRROR_USER_MESSAGES;
    return false;
}

function getMessageParts(message) {
    if (!message || typeof message !== "object") return [];
    if (Array.isArray(message.parts)) return message.parts;
    if (Array.isArray(message?.message?.parts)) return message.message.parts;
    if (Array.isArray(message?.result?.parts)) return message.result.parts;
    return [];
}

function buildPatchSummaryForMessage(message) {
    const parts = getMessageParts(message);
    if (parts.length === 0) return "";

    const changedFiles = [];
    for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        if (part.type !== "patch" || !Array.isArray(part.files)) continue;
        for (const file of part.files) {
            if (typeof file === "string" && file.trim() !== "") {
                changedFiles.push(file.trim());
            }
        }
    }

    if (changedFiles.length === 0) return "";

    const unique = [...new Set(changedFiles)].slice(0, 40);
    return [
        "```text",
        "Code changes:",
        ...unique.map((file) => `- ${file}`),
        "```",
    ].join("\n");
}

function getSessionMessageKey(message, fallbackIndex = 0) {
    if (!message || typeof message !== "object") {
        return `fallback:${fallbackIndex}`;
    }

    const idCandidates = [
        message?.id,
        message?.messageId,
        message?.info?.id,
        message?.info?.messageID,
        message?.uuid,
        message?.ulid,
        message?.eventId,
        message?.metadata?.id,
        message?.properties?.id,
    ];

    for (const candidate of idCandidates) {
        if (typeof candidate === "string" && candidate.trim() !== "") {
            return `id:${candidate.trim()}`;
        }
        if (typeof candidate === "number" && Number.isFinite(candidate)) {
            return `id:${candidate}`;
        }
    }

    const role = getMessageRole(message) ?? "unknown";
    const text = extractReply(message).replace(/\s+/g, " ").trim();
    const preview = text ? text.slice(0, 400) : "";
    const length = text.length;
    const timestamp = parseTimestamp(
        message?.createdAt ??
            message?.created_at ??
            message?.timestamp ??
            message?.info?.time?.created ??
            message?.info?.time?.createdAt ??
            message?.info?.createdAt ??
            message?.info?.created_at ??
            message?.time?.createdAt ??
            message?.time?.created,
    );

    if (preview) {
        return `content:${role}:${timestamp}:${length}:${preview}`;
    }

    return `fallback:${fallbackIndex}`;
}

function rememberSessionMessageKeys(chatProjectKey, messages) {
    if (!chatProjectKey || !Array.isArray(messages) || messages.length === 0) return;

    const existing = seenSessionMessageKeysByChatProject.get(chatProjectKey) ?? [];
    const seen = new Set(existing);

    for (let i = 0; i < messages.length; i += 1) {
        const key = getSessionMessageKey(messages[i], i);
        if (!seen.has(key)) {
            existing.push(key);
            seen.add(key);
        }
    }

    if (existing.length > TELEGRAM_LIVE_SYNC_MAX_TRACKED_KEYS) {
        existing.splice(0, existing.length - TELEGRAM_LIVE_SYNC_MAX_TRACKED_KEYS);
    }

    seenSessionMessageKeysByChatProject.set(chatProjectKey, existing);
}

function isKnownSessionMessage(chatProjectKey, message, fallbackIndex = 0) {
    const keys = seenSessionMessageKeysByChatProject.get(chatProjectKey);
    if (!keys || keys.length === 0) return false;

    const known = new Set(keys);
    return known.has(getSessionMessageKey(message, fallbackIndex));
}

async function snapshotSessionMessagesAsSeen(chatId, workspace, sessionId) {
    const rawMessages = await fetchSessionMessages(workspace, sessionId);
    rememberSessionMessageKeys(getChatProjectKey(chatId, workspace.projectPath), rawMessages);
}

async function fetchSessionMessages(workspace, sessionId) {
    try {
        const messageRes = await axios.get(`${workspace.baseUrl}/session/${sessionId}/message`, {
            timeout: 15000,
            params: { limit: 500 },
        });

        const payload = messageRes?.data;
        const asArray = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.messages)
              ? payload.messages
              : [];

        if (asArray.length > 0) {
            return asArray;
        }
    } catch {}

    const sessionRes = await axios.get(`${workspace.baseUrl}/session/${sessionId}`, {
        timeout: 15000,
    });

    return getSyncableSessionMessages(sessionRes?.data);
}

function splitForTelegram(text, maxLength = TELEGRAM_MESSAGE_MAX_LENGTH) {
    if (typeof text !== "string") return [];

    const normalized = text.trim();
    if (!normalized) return [];
    if (normalized.length <= maxLength) return [normalized];

    const chunks = [];
    let remaining = normalized;

    while (remaining.length > maxLength) {
        let cut = remaining.lastIndexOf("\n", maxLength);
        if (cut <= 0) cut = remaining.lastIndexOf(" ", maxLength);
        if (cut <= 0) cut = maxLength;

        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }

    if (remaining) chunks.push(remaining);
    return chunks.filter(Boolean);
}

function getSyncableSessionMessages(data) {
    const arrays = getSessionMessages(data);
    if (arrays.length === 0) return [];

    const scored = arrays.map((messages) => {
        let score = 0;
        for (const message of messages) {
            const text = extractReply(message);
            if (text) score += 1;
            if (isAssistantLikeMessage(message)) score += 1;
        }
        return { messages, score };
    });

    scored.sort((a, b) => b.score - a.score || b.messages.length - a.messages.length);
    return scored[0]?.messages ?? [];
}

async function syncTelegramChatFromSession(chatId, workspace, sessionId, options = {}) {
    const clearChat = options.clearChat !== false;
    const chatProjectKey = getChatProjectKey(chatId, workspace.projectPath);
    sessionByChatProject.set(chatProjectKey, sessionId);

    const rawMessages = await fetchSessionMessages(workspace, sessionId);
    rememberSessionMessageKeys(chatProjectKey, rawMessages);
    const syncMessages = rawMessages
        .filter((message) => shouldSyncMessageToTelegram(message))
        .map((message) => formatSessionMessageForTelegram(message))
        .filter(Boolean);

    const truncated = syncMessages.length > TELEGRAM_SYNC_MESSAGE_LIMIT;
    const finalMessages = truncated ? syncMessages.slice(syncMessages.length - TELEGRAM_SYNC_MESSAGE_LIMIT) : syncMessages;

    const { directory } = await loadSessionDirectory(chatId, workspace);
    const sessionLine = describeSession(directory, sessionId);

    if (clearChat) {
        await clearTrackedMessages(chatId);
    }

    await sendTrackedMessage(chatId, `Synced from OpenCode\nProject: ${workspace.projectLabel}/${workspace.projectName}\n${sessionLine}`);

    if (finalMessages.length === 0) {
        await sendTrackedMessage(
            chatId,
            TELEGRAM_SYNC_FINAL_ONLY ? "Session has no assistant responses yet." : "Session has no text messages yet.",
        );
        return;
    }

    if (truncated) {
        await sendTrackedMessage(chatId, `Showing last ${TELEGRAM_SYNC_MESSAGE_LIMIT} messages.`);
    }

    for (const item of finalMessages) {
        const chunks = splitForTelegram(item);
        for (const chunk of chunks) {
            await sendTrackedMessage(chatId, chunk);
        }
    }
}

async function waitForSessionIdle(workspace, sessionId, timeoutMs = EVENT_STREAM_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let retryDelay = EVENT_STREAM_RETRY_BASE_MS;
    let lastError = null;

    while (Date.now() < deadline) {
        const controller = new AbortController();
        const remainingMs = Math.max(deadline - Date.now(), 1);
        const timeout = setTimeout(() => controller.abort(), remainingMs);

        try {
            let response = await fetch(`${workspace.baseUrl}/event`, {
                headers: { Accept: "text/event-stream" },
                signal: controller.signal,
            });

            if (!response.ok || !response.body) {
                response = await fetch(`${workspace.baseUrl}/global/event`, {
                    headers: { Accept: "text/event-stream" },
                    signal: controller.signal,
                });
            }

            if (!response.ok || !response.body) {
                throw new Error(`Event stream unavailable (${response.status})`);
            }

            retryDelay = EVENT_STREAM_RETRY_BASE_MS;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";

            while (Date.now() < deadline) {
                const { done, value } = await reader.read();
                if (done || !value) break;

                buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
                const parsed = parseSseJsonEvents(buffer);
                buffer = parsed.buffer;

                for (const rawEvent of parsed.events) {
                    const event = unwrapSsePayload(rawEvent);
                    if (!event || typeof event !== "object") continue;

                    const eventSessionId = getEventSessionId(event);
                    if (eventSessionId !== sessionId) continue;

                    const eventType = typeof event.type === "string" ? event.type : "";
                    if (eventType === "session.idle") {
                        clearTimeout(timeout);
                        controller.abort();
                        return;
                    }

                    if (eventType === "session.error") {
                        const reason = event?.properties?.error ?? event?.properties?.message ?? "unknown session error";
                        throw new Error(`Session error: ${String(reason)}`);
                    }
                }
            }

            throw new Error("Event stream closed before session became idle");
        } catch (err) {
            lastError = err;
            if (Date.now() >= deadline) break;
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            retryDelay = Math.min(retryDelay * 2, EVENT_STREAM_RETRY_MAX_MS);
        } finally {
            clearTimeout(timeout);
        }
    }

    throw lastError ?? new Error(`Timed out waiting for session ${sessionId} to become idle`);
}

async function fetchLatestSessionReply(workspace, sessionId) {
    const messages = await fetchSessionMessages(workspace, sessionId);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const text = extractReply(messages[i]);
        if (!text) continue;
        if (isAssistantLikeMessage(messages[i])) return text;
    }

    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const text = extractReply(messages[i]);
        if (text) return text;
    }

    return "";
}

async function recoverReplyFromEventStream(workspace, sessionId, sourceError) {
    console.warn("Recovering interaction via event stream", {
        projectPath: workspace.projectPath,
        projectName: workspace.projectName,
        sessionId,
        reason: sourceError?.message ?? String(sourceError ?? "unknown"),
    });

    await waitForSessionIdle(workspace, sessionId);
    return await fetchLatestSessionReply(workspace, sessionId);
}

async function runWorkspaceInteraction(workspace, sessionId, endpoint, payload) {
    try {
        const interaction = await postWorkspaceInteraction(workspace, sessionId, endpoint, payload);
        const directReply = extractReply(interaction?.res?.data);
        if (directReply) {
            return {
                workspace: interaction.workspace,
                response: interaction.res,
                reply: directReply,
            };
        }

        const recoveredReply = await recoverReplyFromEventStream(interaction.workspace, sessionId);
        if (recoveredReply) {
            return {
                workspace: interaction.workspace,
                response: interaction.res,
                reply: recoveredReply,
            };
        }

        return {
            workspace: interaction.workspace,
            response: interaction.res,
            reply: "",
        };
    } catch (err) {
        if (!isRecoverableWorkspaceError(err)) {
            throw err;
        }

        const recoveredReply = await recoverReplyFromEventStream(workspace, sessionId, err);
        if (!recoveredReply) {
            throw err;
        }

        return {
            workspace,
            response: null,
            reply: recoveredReply,
        };
    }
}

async function restartWorkspaceRuntime(projectPath, reason) {
    const runtime = ensureWorkspaceRecord(projectPath);
    const child = runtime.child;

    if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        try {
            await Promise.race([
                once(child, "exit"),
                new Promise((resolve) => setTimeout(resolve, 1500)),
            ]);
        } catch {}
    }

    runtime.status = "stopped";
    runtime.child = null;
    runtime.port = null;
    runtime.baseUrl = null;
    runtime.startPromise = null;
    runtime.lastUsedAt = Date.now();
    commandAliasByProjectPath.delete(projectPath);
    commandCacheByProjectPath.delete(projectPath);

    console.warn("Restarting workspace runtime", {
        projectPath,
        projectName: runtime.projectName,
        reason: reason?.message ?? String(reason ?? "unknown"),
    });

    return await ensureWorkspaceRuntime(projectPath);
}

async function postWorkspaceInteraction(workspace, sessionId, endpoint, payload) {
    let activeWorkspace = workspace;
    let attempt = 0;

    while (attempt <= INTERACTION_RETRY_LIMIT) {
        try {
            const res = await axios.post(`${activeWorkspace.baseUrl}/session/${sessionId}/${endpoint}`, payload, {
                timeout: INTERACTION_REQUEST_TIMEOUT_MS,
            });
            return { res, workspace: activeWorkspace };
        } catch (err) {
            const canRetry = attempt < INTERACTION_RETRY_LIMIT && shouldRetryWorkspaceInteraction(err);
            if (!canRetry) throw err;

            attempt += 1;
            activeWorkspace = await restartWorkspaceRuntime(activeWorkspace.projectPath, err);
        }
    }

    throw new Error("Workspace interaction retry limit exceeded");
}

async function findOpenPort() {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            server.close(() => {
                if (!address || typeof address !== "object") {
                    reject(new Error("Failed to allocate port"));
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

function ensureWorkspaceRecord(projectPath) {
    let runtime = workspaceRuntimeByProjectPath.get(projectPath);
    if (runtime) return runtime;

    const project = parseProjectFromPath(projectPath);
    runtime = {
        projectPath,
        projectName: project.name,
        projectLabel: project.label,
        status: "stopped",
        port: null,
        baseUrl: null,
        child: null,
        startPromise: null,
        lastUsedAt: Date.now(),
    };
    workspaceRuntimeByProjectPath.set(projectPath, runtime);
    return runtime;
}

async function waitForWorkspaceHealthy(baseUrl, timeoutMs) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const res = await axios.get(`${baseUrl}/global/health`, {
                timeout: 1200,
                validateStatus: () => true,
            });

            if (res.status >= 200 && res.status < 300 && res?.data?.healthy === true) {
                return;
            }
        } catch {}

        await new Promise((resolve) => setTimeout(resolve, WORKSPACE_HEALTH_POLL_MS));
    }

    throw new Error(`Workspace did not become healthy within ${timeoutMs}ms`);
}

async function ensureWorkspaceRuntime(projectPath) {
    const runtime = ensureWorkspaceRecord(projectPath);
    runtime.lastUsedAt = Date.now();

    if (runtime.status === "ready" && runtime.child && runtime.child.exitCode === null && runtime.baseUrl) {
        return runtime;
    }

    if (runtime.startPromise) {
        return await runtime.startPromise;
    }

    runtime.startPromise = (async () => {
        const port = await findOpenPort();
        const baseUrl = `http://127.0.0.1:${port}`;

        const child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
            cwd: projectPath,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        runtime.child = child;
        runtime.port = port;
        runtime.baseUrl = baseUrl;
        runtime.status = "starting";

        child.stdout?.on("data", (chunk) => {
            const text = chunk.toString().trim();
            if (text) {
                console.log(`[workspace:${runtime.projectName}] ${text}`);
            }
        });

        child.stderr?.on("data", (chunk) => {
            const text = chunk.toString().trim();
            if (text) {
                console.error(`[workspace:${runtime.projectName}:err] ${text}`);
            }
        });

        child.once("exit", (code, signal) => {
            if (runtime.child === child) {
                runtime.status = "stopped";
                runtime.child = null;
                runtime.port = null;
                runtime.baseUrl = null;
            }

            if (runtime.startPromise && runtime.child !== child) {
                return;
            }

            runtime.startPromise = null;
            console.warn("Workspace runtime exited", {
                projectPath,
                projectName: runtime.projectName,
                code,
                signal,
            });
        });

        child.once("error", (err) => {
            console.error("Workspace runtime spawn failed", {
                projectPath,
                projectName: runtime.projectName,
                message: err?.message,
            });
        });

        try {
            await waitForWorkspaceHealthy(baseUrl, WORKSPACE_HEALTH_TIMEOUT_MS);
            runtime.status = "ready";
            runtime.lastUsedAt = Date.now();
            return runtime;
        } catch (err) {
            runtime.status = "error";
            if (child.exitCode === null) {
                child.kill("SIGTERM");
            }
            throw err;
        } finally {
            runtime.startPromise = null;
        }
    })();

    return await runtime.startPromise;
}

function getActiveProjectPath(chatId) {
    return activeProjectPathByChat.get(chatId) ?? null;
}

async function getWorkspaceForChat(chatId) {
    const projectPath = getActiveProjectPath(chatId);
    if (!projectPath) {
        return null;
    }

    const runtime = await ensureWorkspaceRuntime(projectPath);
    return runtime;
}

async function loadProjectDirectory(chatId) {
    const allItems = [];

    for (const root of PROJECT_ROOTS) {
        try {
            const entries = await readdir(root.path, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                if (entry.name.startsWith(".")) continue;

                allItems.push({
                    name: entry.name,
                    path: `${root.path}/${entry.name}`,
                    scope: root.scope,
                    label: root.label,
                });
            }
        } catch (err) {
            console.warn("Failed to read project root", {
                projectRoot: root.path,
                message: err?.message,
            });
        }
    }

    allItems.sort((a, b) => {
        const byLabel = a.label.localeCompare(b.label);
        if (byLabel !== 0) return byLabel;
        return a.name.localeCompare(b.name);
    });

    const slugToProject = new Map();
    const usedSlugs = new Set();
    const items = allItems.map((item) => {
        const base = sanitizeProjectSlug(`${item.scope}-${item.name}`) || "project";
        let slug = base;
        let idx = 2;
        while (usedSlugs.has(slug)) {
            slug = `${base}-${idx}`;
            idx += 1;
        }

        usedSlugs.add(slug);
        const project = { ...item, slug };
        slugToProject.set(slug, project);
        return project;
    });

    const directory = { items, slugToProject };
    projectDirectoryByChat.set(chatId, directory);
    return directory;
}

async function loadSessionDirectory(chatId, workspace) {
    const res = await axios.get(`${workspace.baseUrl}/session`);
    const sessions = Array.isArray(res?.data) ? res.data : [];

    for (const session of sessions) {
        const sessionId = typeof session?.id === "string" ? session.id : "";
        if (!sessionId) continue;

        const sessionPath = getSessionProjectPath(session);
        if (sessionPath) {
            sessionProjectPathById.set(sessionId, sessionPath);
        }
    }

    const projectSessions = sessions.filter((session) => sessionBelongsToProject(session, workspace.projectPath));
    const selectedSessions = projectSessions.length > 0 ? projectSessions : sessions;

    const sortedSessions = [...selectedSessions].sort((a, b) => {
        const aActivity = getSessionActivityTimestamp(a);
        const bActivity = getSessionActivityTimestamp(b);
        return bActivity - aActivity;
    });

    const directory = buildSessionDirectory(sortedSessions);
    sessionDirectoryByChatProject.set(getChatProjectKey(chatId, workspace.projectPath), directory);
    return {
        directory,
        sessions: sortedSessions,
        currentSessionId: pickOpenCodeCurrentSessionId(sortedSessions),
    };
}

function pickSessionIdForChat(sessions, existingSessionId, opencodeCurrentSessionId, options = {}) {
    const preferMostRecent = options.preferMostRecent === true;
    const validSessionIds = new Set(
        sessions
            .map((session) => (typeof session?.id === "string" ? session.id : ""))
            .filter(Boolean),
    );

    if (opencodeCurrentSessionId && validSessionIds.has(opencodeCurrentSessionId)) {
        return opencodeCurrentSessionId;
    }

    if (!preferMostRecent && existingSessionId && validSessionIds.has(existingSessionId)) {
        return existingSessionId;
    }

    const mostRecentSessionId = typeof sessions[0]?.id === "string" ? sessions[0].id : null;
    if (mostRecentSessionId) return mostRecentSessionId;

    if (existingSessionId && validSessionIds.has(existingSessionId)) {
        return existingSessionId;
    }

    return null;
}

async function getOrCreateSession(chatId, workspace, options = {}) {
    const allowCreate = options.allowCreate !== false;
    const preferMostRecent = options.preferMostRecent === true;
    const sessionKey = getChatProjectKey(chatId, workspace.projectPath);
    const existingSession = sessionByChatProject.get(sessionKey);

    const { sessions, currentSessionId } = await loadSessionDirectory(chatId, workspace);
    const pickedSessionId = pickSessionIdForChat(sessions, existingSession, currentSessionId, {
        preferMostRecent,
    });

    if (pickedSessionId) {
        sessionByChatProject.set(sessionKey, pickedSessionId);
        return pickedSessionId;
    }

    if (!allowCreate) {
        sessionByChatProject.delete(sessionKey);
        return null;
    }

    const createRes = await axios.post(`${workspace.baseUrl}/session`, {
        title: defaultSessionTitle(chatId, workspace.projectName),
    });

    const sessionId = createRes?.data?.id;
    if (!sessionId || typeof sessionId !== "string") {
        throw new Error("Failed to create OpenCode session");
    }

    sessionProjectPathById.set(sessionId, workspace.projectPath);
    sessionByChatProject.set(sessionKey, sessionId);
    await loadSessionDirectory(chatId, workspace);
    return sessionId;
}

async function createNewSession(chatId, workspace, title) {
    const createRes = await axios.post(`${workspace.baseUrl}/session`, {
        title: title && title.trim() !== "" ? title.trim() : defaultSessionTitle(chatId, workspace.projectName),
    });

    const sessionId = createRes?.data?.id;
    if (!sessionId || typeof sessionId !== "string") {
        throw new Error("Failed to create OpenCode session");
    }

    const sessionKey = getChatProjectKey(chatId, workspace.projectPath);
    sessionProjectPathById.set(sessionId, workspace.projectPath);
    sessionByChatProject.set(sessionKey, sessionId);
    await loadSessionDirectory(chatId, workspace);
    return sessionId;
}

async function clearSessionsForProject(chatId, workspace) {
    const { directory } = await loadSessionDirectory(chatId, workspace);
    if (directory.items.length === 0) {
        return { deleted: 0, failed: [] };
    }

    const failed = [];

    for (const item of directory.items) {
        try {
            await axios.delete(`${workspace.baseUrl}/session/${item.id}`);
            sessionProjectPathById.delete(item.id);
        } catch (err) {
            failed.push(item.slug);
            console.error("Failed deleting OpenCode session", {
                sessionId: item.id,
                slug: item.slug,
                status: err?.response?.status,
                message: err?.message,
            });
        }
    }

    const sessionKey = getChatProjectKey(chatId, workspace.projectPath);
    sessionByChatProject.delete(sessionKey);

    const { directory: refreshedDirectory } = await loadSessionDirectory(chatId, workspace);
    const nextSessionId = refreshedDirectory.items[0]?.id;
    if (nextSessionId) {
        sessionByChatProject.set(sessionKey, nextSessionId);
    }

    return { deleted: directory.items.length - failed.length, failed };
}

async function switchSessionBySelector(chatId, workspace, wanted) {
    const { directory } = await loadSessionDirectory(chatId, workspace);
    const wantedLower = wanted.toLowerCase();
    let targetSessionId = directory.slugToSessionId.get(wantedLower);

    if (!targetSessionId) {
        const exactIdMatch = directory.items.find((item) => item.id === wanted);
        if (exactIdMatch) targetSessionId = exactIdMatch.id;
    }

    if (!targetSessionId) {
        const exactTitleMatch = directory.items.find((item) => item.title.toLowerCase() === wantedLower);
        if (exactTitleMatch) targetSessionId = exactTitleMatch.id;
    }

    if (!targetSessionId) {
        const partialMatches = directory.items.filter(
            (item) => item.slug.includes(wantedLower) || item.title.toLowerCase().includes(wantedLower),
        );

        if (partialMatches.length === 1) {
            targetSessionId = partialMatches[0].id;
        } else if (partialMatches.length > 1) {
            const options = partialMatches
                .slice(0, 10)
                .map((item) => `${item.slug} - ${item.title}`)
                .join("\n");
            return { ok: false, message: `Multiple matches found:\n${options}` };
        }
    }

    if (!targetSessionId) {
        return { ok: false, message: "Session not found. Run /sessions and copy the slug exactly." };
    }

    await axios.get(`${workspace.baseUrl}/session/${targetSessionId}`);
    sessionByChatProject.set(getChatProjectKey(chatId, workspace.projectPath), targetSessionId);
    return {
        ok: true,
        message: `Switched to session: ${describeSession(directory, targetSessionId)}`,
        sessionId: targetSessionId,
    };
}

async function refreshCommandsForProject(projectPath) {
    const runtime = workspaceRuntimeByProjectPath.get(projectPath);
    if (!runtime || runtime.status !== "ready" || !runtime.baseUrl) return [];

    const cached = commandCacheByProjectPath.get(projectPath);
    if (cached && Date.now() - cached.updatedAt < COMMAND_CACHE_MS) {
        return cached.commands;
    }

    try {
        const res = await axios.get(`${runtime.baseUrl}/command`);
        const commands = Array.isArray(res?.data)
            ? res.data
            : Array.isArray(res?.data?.commands)
                ? res.data.commands
                : [];

        const aliasMap = new Map();
        const output = [];

        for (const command of commands) {
            const originalName = typeof command?.name === "string" ? command.name : "";
            if (!originalName) continue;

            const telegramName = sanitizeTelegramCommand(originalName);
            if (!telegramName) continue;

            aliasMap.set(telegramName, originalName);

            const descriptionSource =
                typeof command?.description === "string" && command.description.trim() !== ""
                    ? command.description.trim()
                    : `Run /${originalName}`;

            output.push({
                command: telegramName,
                description: descriptionSource.slice(0, 256),
            });
        }

        commandAliasByProjectPath.set(projectPath, aliasMap);
        commandCacheByProjectPath.set(projectPath, { updatedAt: Date.now(), commands: output });
        return output;
    } catch (err) {
        console.error("Failed loading OpenCode commands", {
            projectPath,
            baseUrl: runtime.baseUrl,
            status: err?.response?.status,
            message: err?.message,
        });
        return [];
    }
}

async function syncTelegramCommands() {
    telegramCommandMap.clear();

    const commandMap = new Map();
    const seen = new Set();

    for (const command of BUILTIN_TELEGRAM_COMMANDS) {
        commandMap.set(command.command, command);
        telegramCommandMap.set(command.command, command.command);
        seen.add(command.command);
    }

    const uniqueProjects = [...new Set(activeProjectPathByChat.values())];
    const dynamicByProject = await Promise.all(uniqueProjects.map((path) => refreshCommandsForProject(path)));
    const dynamicCommands = dynamicByProject.flat();

    if (dynamicCommands.length === 0) {
        for (const fallback of FALLBACK_COMMANDS) {
            if (seen.has(fallback.name)) continue;
            seen.add(fallback.name);
            telegramCommandMap.set(fallback.name, fallback.name);
            commandMap.set(fallback.name, {
                command: fallback.name,
                description: fallback.description,
            });
        }
    } else {
        for (const command of dynamicCommands) {
            if (!command?.command || seen.has(command.command)) continue;
            seen.add(command.command);
            commandMap.set(command.command, command);
            telegramCommandMap.set(command.command, command.command);
        }
    }

    const mergedCommands = [...commandMap.values()].slice(0, 100);
    await bot.setMyCommands(mergedCommands);
    await bot.setMyCommands(mergedCommands, { scope: { type: "all_private_chats" } });
    await bot.setMyCommands(mergedCommands, { scope: { type: "all_group_chats" } });

    console.log(`Synced ${mergedCommands.length} Telegram commands`);
}

async function switchProjectBySlug(chatId, slug) {
    let directory = projectDirectoryByChat.get(chatId);
    if (!directory) {
        directory = await loadProjectDirectory(chatId);
    }

    let project = directory.slugToProject.get(slug);
    if (!project) {
        directory = await loadProjectDirectory(chatId);
        project = directory.slugToProject.get(slug);
    }

    if (!project) {
        return { ok: false, message: "Project not found. Run /projects again." };
    }

    const runtime = await ensureWorkspaceRuntime(project.path);
    activeProjectPathByChat.set(chatId, project.path);
    const sessionId = await getOrCreateSession(chatId, runtime);
    await syncTelegramCommands();
    await syncTelegramChatFromSession(chatId, runtime, sessionId, { clearChat: true });

    return {
        ok: true,
        message: `Switched project to ${project.label}/${project.name}\nPath: ${project.path}\nOpenCode: ${runtime.baseUrl} (port ${runtime.port})\nSession synced to Telegram.`,
    };
}

async function liveSyncTelegramChatsFromSessions() {
    if (liveSyncInFlight) return;
    liveSyncInFlight = true;

    try {
        for (const [chatProjectKey, sessionId] of sessionByChatProject.entries()) {
            if (typeof sessionId !== "string" || sessionId.trim() === "") continue;

            const parsed = parseChatProjectKey(chatProjectKey);
            if (!parsed) continue;

            const { chatId, projectPath } = parsed;
            if (activeProjectPathByChat.get(chatId) !== projectPath) continue;

            const runtime = workspaceRuntimeByProjectPath.get(projectPath);
            if (!runtime || !runtime.baseUrl || runtime.status !== "ready") continue;

            try {
                const rawMessages = await fetchSessionMessages(runtime, sessionId);
                if (rawMessages.length === 0) continue;

                const freshMessages = [];
                for (let i = 0; i < rawMessages.length; i += 1) {
                    const message = rawMessages[i];
                    if (!shouldSyncMessageToTelegram(message)) continue;
                    const formatted = formatSessionMessageForTelegram(message);
                    if (!formatted) continue;
                    if (isKnownSessionMessage(chatProjectKey, message, i)) continue;
                    freshMessages.push(message);
                }

                if (freshMessages.length === 0) {
                    rememberSessionMessageKeys(chatProjectKey, rawMessages);
                    continue;
                }

                for (const message of freshMessages) {
                    const formatted = formatSessionMessageForTelegram(message);
                    if (!formatted) continue;

                    const chunks = splitForTelegram(formatted);
                    for (const chunk of chunks) {
                        await sendTrackedMessage(chatId, chunk);
                    }
                }

                rememberSessionMessageKeys(chatProjectKey, rawMessages);
            } catch (err) {
                console.warn("Live session sync failed", {
                    chatId,
                    projectPath,
                    sessionId,
                    status: err?.response?.status,
                    message: err?.message,
                });
            }
        }
    } finally {
        liveSyncInFlight = false;
    }
}

function getActiveProjectCommandMap(chatId) {
    const projectPath = getActiveProjectPath(chatId);
    if (!projectPath) return null;
    return commandAliasByProjectPath.get(projectPath) ?? null;
}

function getActiveProjectDescription(chatId) {
    const projectPath = getActiveProjectPath(chatId);
    if (!projectPath) return null;
    const project = parseProjectFromPath(projectPath);
    return `${project.label}/${project.name}`;
}

function getSelectedMode(chatId, workspace) {
    if (!workspace?.projectPath) return null;
    return selectedModeByChatProject.get(getChatProjectKey(chatId, workspace.projectPath)) ?? null;
}

function setSelectedMode(chatId, workspace, modeName) {
    if (!workspace?.projectPath) return;
    const key = getChatProjectKey(chatId, workspace.projectPath);
    if (typeof modeName === "string" && modeName.trim() !== "") {
        selectedModeByChatProject.set(key, modeName.trim());
        return;
    }
    selectedModeByChatProject.delete(key);
}

function withSelectedMode(chatId, workspace, payload) {
    const mode = getSelectedMode(chatId, workspace);
    if (!mode) return payload;
    return { ...payload, agent: mode };
}

function getModeButtons(modes, currentMode) {
    const rows = [];
    for (let i = 0; i < modes.length; i += 2) {
        const row = [];
        const left = modes[i];
        const right = modes[i + 1];

        if (left) {
            const label = left.name === currentMode ? `✅ ${left.name}` : left.name;
            row.push({ text: label, callback_data: `mode:${encodeURIComponent(left.name)}` });
        }

        if (right) {
            const label = right.name === currentMode ? `✅ ${right.name}` : right.name;
            row.push({ text: label, callback_data: `mode:${encodeURIComponent(right.name)}` });
        }

        if (row.length > 0) rows.push(row);
    }

    return rows;
}

async function loadSelectableModes(workspace) {
    if (!workspace?.projectPath || !workspace?.baseUrl) return [];

    const cached = modeCacheByProjectPath.get(workspace.projectPath);
    if (cached && Date.now() - cached.updatedAt < MODE_CACHE_MS) {
        return cached.modes;
    }

    try {
        const res = await axios.get(`${workspace.baseUrl}/agent`, { timeout: 10000 });
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
                return mode !== "subagent";
            })
            .map((agent) => ({
                name: agent.name.trim(),
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

        modeCacheByProjectPath.set(workspace.projectPath, {
            updatedAt: Date.now(),
            modes,
        });

        return modes;
    } catch (err) {
        console.error("Failed loading OpenCode modes", {
            projectPath: workspace.projectPath,
            baseUrl: workspace.baseUrl,
            status: err?.response?.status,
            message: err?.message,
        });
        return [];
    }
}

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    trackMessageId(chatId, msg.message_id);
    const text = msg.text ?? msg.caption;
    if (!text) return;

    const stopTyping = startTyping(chatId);

    try {
        const trimmed = text.trim();
        const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
        const isCommand = firstToken.startsWith("/");

        let workspace = null;
        const telegramCommand = isCommand ? firstToken.slice(1).split("@")[0].toLowerCase().replace(/-/g, "_") : "";
        const canRunWithoutProject = ["projects", "help", "commandsync"].includes(telegramCommand);

        if (!canRunWithoutProject) {
            workspace = await getWorkspaceForChat(chatId);
            if (!workspace) {
                await sendTrackedMessage(chatId, "Select a project first with /projects.");
                return;
            }
        }

        let res;

        if (isCommand) {
            if (telegramCommand === "commandsync") {
                await syncTelegramCommands();
                await sendTrackedMessage(chatId, "Commands refreshed.");
                return;
            }

            if (telegramCommand === "help") {
                const commands = [...new Set([...BUILTIN_TELEGRAM_COMMANDS.map((c) => c.command), ...telegramCommandMap.keys()])];
                if (commands.includes("clear_sessions")) {
                    commands.push("clear-sessions");
                }

                const helpText = [...new Set(commands)]
                    .sort()
                    .map((name) => `/${name}`)
                    .join("\n");
                await sendTrackedMessage(chatId, `Available commands:\n${helpText}`);
                return;
            }

            if (telegramCommand === "projects") {
                const directory = await loadProjectDirectory(chatId);
                if (directory.items.length === 0) {
                    await sendTrackedMessage(chatId, "No projects found in Desktop/Petar or Desktop/Profico.");
                    return;
                }

                await sendTrackedMessage(chatId, "Projects (tap to switch):", {
                    reply_markup: {
                        inline_keyboard: getProjectButtons(directory),
                    },
                });
                return;
            }

            if (telegramCommand === "sessions") {
                const { directory } = await loadSessionDirectory(chatId, workspace);
                if (directory.items.length === 0) {
                    await sendTrackedMessage(chatId, "No sessions found.");
                    return;
                }

                const currentSessionId = sessionByChatProject.get(getChatProjectKey(chatId, workspace.projectPath));
                await sendTrackedMessage(chatId, "Sessions (tap to switch):", {
                    reply_markup: {
                        inline_keyboard: getSessionButtons(directory, currentSessionId),
                    },
                });
                return;
            }

            if (telegramCommand === "clear_sessions") {
                const result = await clearSessionsForProject(chatId, workspace);
                if (result.deleted === 0 && result.failed.length === 0) {
                    await sendTrackedMessage(chatId, "No sessions to clear for this project.");
                    return;
                }

                if (result.failed.length === 0) {
                    await sendTrackedMessage(chatId, `Cleared ${result.deleted} session(s) for this project.`);
                    return;
                }

                await sendTrackedMessage(
                    chatId,
                    `Cleared ${result.deleted} session(s). Failed ${result.failed.length}: ${result.failed.join(", ")}`,
                );
                return;
            }

            if (telegramCommand === "new") {
                const wantedTitle = trimmed.slice(firstToken.length).trim();
                const newSessionId = await createNewSession(chatId, workspace, wantedTitle);
                await clearTrackedMessages(chatId);
                const directory = sessionDirectoryByChatProject.get(getChatProjectKey(chatId, workspace.projectPath));
                await sendTrackedMessage(chatId, `Started new session: ${describeSession(directory, newSessionId)}`);
                return;
            }

            if (telegramCommand === "session") {
                const current = await getOrCreateSession(chatId, workspace);
                const { directory } = await loadSessionDirectory(chatId, workspace);
                const projectLine = getActiveProjectDescription(chatId) ?? workspace.projectName;
                const modeLine = getSelectedMode(chatId, workspace) ?? "default";
                await sendTrackedMessage(
                    chatId,
                    `Current project: ${projectLine}\nCurrent session: ${describeSession(directory, current)}\nMode: ${modeLine}`,
                );
                return;
            }

            if (telegramCommand === "mode") {
                const modes = await loadSelectableModes(workspace);
                if (modes.length === 0) {
                    await sendTrackedMessage(chatId, "No selectable modes found from OpenCode /agent endpoint.");
                    return;
                }

                const wanted = trimmed.slice(firstToken.length).trim();
                if (wanted) {
                    const selected = modes.find((mode) => mode.name.toLowerCase() === wanted.toLowerCase());
                    if (!selected) {
                        const names = modes.map((mode) => mode.name).join(", ");
                        await sendTrackedMessage(chatId, `Mode not found. Available: ${names}`);
                        return;
                    }

                    setSelectedMode(chatId, workspace, selected.name);
                    await sendTrackedMessage(chatId, `Mode set to ${selected.name}.`);
                    return;
                }

                const currentMode = getSelectedMode(chatId, workspace);
                await sendTrackedMessage(chatId, `Select OpenCode mode\nCurrent: ${currentMode ?? "default"}`, {
                    reply_markup: {
                        inline_keyboard: getModeButtons(modes, currentMode),
                    },
                });
                return;
            }

            if (telegramCommand === "refresh") {
                const current = await getOrCreateSession(chatId, workspace, {
                    allowCreate: false,
                    preferMostRecent: true,
                });
                if (!current) {
                    await sendTrackedMessage(chatId, "No sessions found for this project.");
                    return;
                }
                await syncTelegramChatFromSession(chatId, workspace, current, { clearChat: true });
                return;
            }

            if (telegramCommand === "switch") {
                const wanted = trimmed.slice(firstToken.length).trim();
                if (!wanted) {
                    await sendTrackedMessage(chatId, "Usage: /switch <slug>");
                    return;
                }

                const result = await switchSessionBySelector(chatId, workspace, wanted);
                if (!result.ok || !result.sessionId) {
                    await sendTrackedMessage(chatId, result.message);
                    return;
                }

                await syncTelegramChatFromSession(chatId, workspace, result.sessionId, { clearChat: true });
                return;
            }

            const sessionId = await getOrCreateSession(chatId, workspace);

            if (telegramCommand === "run") {
                const prompt = trimmed.slice(firstToken.length).trim();
                if (!prompt) {
                    await sendTrackedMessage(chatId, "Usage: /run <prompt text>");
                    return;
                }

                const interaction = await runWorkspaceInteraction(workspace, sessionId, "message", {
                    ...withSelectedMode(chatId, workspace, {}),
                    parts: [{ type: "text", text: prompt }],
                });
                workspace = interaction.workspace;
                res = interaction.response;
                if (interaction.reply) {
                    await sendTrackedMessage(chatId, interaction.reply);
                    await snapshotSessionMessagesAsSeen(chatId, workspace, sessionId).catch(() => {});
                    return;
                }
            } else {
                const projectCommandMap = getActiveProjectCommandMap(chatId);
                const command = projectCommandMap?.get(telegramCommand) ?? telegramCommandMap.get(telegramCommand) ?? telegramCommand;
                const argumentsText = trimmed.slice(firstToken.length).trim();

                const interaction = await runWorkspaceInteraction(workspace, sessionId, "command", {
                    ...withSelectedMode(chatId, workspace, {}),
                    command,
                    arguments: argumentsText,
                });
                workspace = interaction.workspace;
                res = interaction.response;
                if (interaction.reply) {
                    await sendTrackedMessage(chatId, interaction.reply);
                    await snapshotSessionMessagesAsSeen(chatId, workspace, sessionId).catch(() => {});
                    return;
                }
            }
        } else {
            const sessionId = await getOrCreateSession(chatId, workspace);
            const interaction = await runWorkspaceInteraction(workspace, sessionId, "message", {
                ...withSelectedMode(chatId, workspace, {}),
                parts: [{ type: "text", text }],
            });
            workspace = interaction.workspace;
            res = interaction.response;
            if (interaction.reply) {
                await sendTrackedMessage(chatId, interaction.reply);
                await snapshotSessionMessagesAsSeen(chatId, workspace, sessionId).catch(() => {});
                return;
            }
        }

        let reply = extractReply(res?.data);

        if (looksLikeHtmlDocument(reply)) {
            reply = "⚠️ OpenCode endpoint misconfigured (HTML returned)";
        }

        if (!reply || reply.trim() === "") {
            const payload = res?.data;
            const keys = payload && typeof payload === "object" ? Object.keys(payload) : [];
            let preview = "";

            try {
                preview = JSON.stringify(payload).slice(0, 800);
            } catch {
                preview = "[unserializable payload]";
            }

            console.warn("OpenCode reply had no text", { keys, preview });
            reply = "✅ Request processed (no text response)";
        }

        await sendTrackedMessage(chatId, reply);
        const sessionId = sessionByChatProject.get(getChatProjectKey(chatId, workspace.projectPath));
        if (sessionId) {
            await snapshotSessionMessagesAsSeen(chatId, workspace, sessionId).catch(() => {});
        }
    } catch (err) {
        console.error("Telegram message handling failed", {
            message: err?.message,
            status: err?.response?.status,
            data: err?.response?.data,
        });
        await sendTrackedMessage(chatId, "⚠️ OpenCode server error");
    } finally {
        stopTyping();
    }
});

bot.on("callback_query", async (query) => {
    const chatId = query?.message?.chat?.id;
    const data = query?.data ?? "";

    console.log("Callback received", { chatId, data, hasMessage: !!query?.message });

    if (!chatId || (!data.startsWith("switch:") && !data.startsWith("project:") && !data.startsWith("mode:"))) {
        console.log("Callback ignored - invalid chatId or data", { chatId, data });
        await answerCallbackQuerySafely(query?.id);
        return;
    }

    try {
        console.log("Processing callback", { data, chatId });

        let callbackWorkspace = null;
        const result = data.startsWith("project:")
            ? await switchProjectBySlug(chatId, data.slice("project:".length))
            : data.startsWith("switch:")
              ? await (async () => {
                const projectPath = getActiveProjectPath(chatId);
                console.log("Switch session - active project path", { projectPath, chatId });
                if (!projectPath) {
                    return { ok: false, message: "Select a project first with /projects." };
                }
                const workspace = await ensureWorkspaceRuntime(projectPath);
                callbackWorkspace = workspace;
                const selector = data.slice("switch:".length);
                console.log("Switching session", { selector, workspace: workspace.projectName });
                return await switchSessionBySelector(chatId, workspace, selector);
              })()
              : await (async () => {
                const projectPath = getActiveProjectPath(chatId);
                if (!projectPath) {
                    return { ok: false, message: "Select a project first with /projects." };
                }

                const workspace = await ensureWorkspaceRuntime(projectPath);
                callbackWorkspace = workspace;
                const requested = decodeURIComponent(data.slice("mode:".length));
                const modes = await loadSelectableModes(workspace);
                const selected = modes.find((mode) => mode.name === requested);
                if (!selected) {
                    return { ok: false, message: "Mode no longer available. Run /mode again." };
                }

                setSelectedMode(chatId, workspace, selected.name);
                return { ok: true, message: `Mode set to ${selected.name}.` };
              })();

        console.log("Callback result", { ok: result?.ok, message: result?.message?.slice(0, 50) });

        await answerCallbackQuerySafely(query?.id, {
            text: truncateText(result.message, 180),
            show_alert: false,
        });

        if (data.startsWith("switch:") && result?.ok && result?.sessionId && callbackWorkspace) {
            await syncTelegramChatFromSession(chatId, callbackWorkspace, result.sessionId, { clearChat: true });
            return;
        }

        await sendTrackedMessage(chatId, result.message);
    } catch (err) {
        console.error("Callback switch failed", {
            message: err?.message,
            stack: err?.stack?.split("\n").slice(0, 3),
        });
        await answerCallbackQuerySafely(query?.id, {
            text: "Failed to switch",
            show_alert: true,
        });
        await sendTrackedMessage(chatId, `⚠️ Error: ${err?.message ?? "Unknown error"}`);
    }
});

bot.on("polling_error", (err) => {
    console.error("Telegram polling error", {
        code: err?.code,
        message: err?.message,
        description: err?.response?.body?.description,
    });
});

process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection", reason);
});

syncTelegramCommands().catch((err) => {
    console.error("Failed to sync Telegram commands", err?.message ?? err);
});

setInterval(() => {
    syncTelegramCommands().catch((err) => {
        console.error("Failed to refresh Telegram commands", err?.message ?? err);
    });
}, COMMAND_REFRESH_MS);

setInterval(() => {
    liveSyncTelegramChatsFromSessions().catch((err) => {
        console.error("Live Telegram sync failed", err?.message ?? err);
    });
}, TELEGRAM_LIVE_SYNC_INTERVAL_MS);
