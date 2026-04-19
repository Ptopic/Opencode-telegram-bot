/**
 * SQLite database layer for opencode-telegram.
 * Single source of truth for instances, sessions, and mode state.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.join(homedir(), ".opencode-telegram.db");

let _db = null;

export function getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id              TEXT PRIMARY KEY,
      project_path    TEXT UNIQUE NOT NULL,
      base_url        TEXT NOT NULL,
      port            INTEGER NOT NULL,
      pid             INTEGER,
      status          TEXT DEFAULT 'starting',
      started_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_sessions (
      project_path    TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      mode            TEXT,
      updated_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      scope           TEXT PRIMARY KEY,
      path            TEXT NOT NULL,
      label           TEXT NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_instances_project_path ON instances(project_path);
    CREATE INDEX IF NOT EXISTS idx_active_sessions_project_path ON active_sessions(project_path);
  `);
}

function hashPath(projectPath) {
  return createHash("sha256").update(projectPath.toLowerCase()).digest("hex").slice(0, 16);
}

function now() {
  return Date.now();
}

// ── Instances ────────────────────────────────────────────────────────────────

export function upsertInstance({ projectPath, baseUrl, port, pid, status }) {
  const db = getDb();
  const id = hashPath(projectPath);
  const stmt = db.prepare(`
    INSERT INTO instances (id, project_path, base_url, port, pid, status, started_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_path) DO UPDATE SET
      base_url = excluded.base_url,
      port = excluded.port,
      pid = excluded.pid,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);
  return stmt.run(id, projectPath.toLowerCase().replace(/\/+$/, ""), baseUrl, port, pid, status, now(), now());
}

export function getInstance(projectPath) {
  const db = getDb();
  const normalized = projectPath.toLowerCase().replace(/\/+$/, "");
  const stmt = db.prepare("SELECT * FROM instances WHERE lower(project_path) = ?");
  return stmt.get(normalized);
}

export function listInstances() {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM instances ORDER BY project_path");
  return stmt.all();
}

export function updateInstanceStatus(projectPath, status) {
  const db = getDb();
  const stmt = db.prepare("UPDATE instances SET status = ?, updated_at = ? WHERE project_path = ?");
  return stmt.run(status, now(), projectPath.toLowerCase().replace(/\/+$/, ""));
}

export function deleteInstance(projectPath) {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM instances WHERE project_path = ?");
  return stmt.run(projectPath.toLowerCase().replace(/\/+$/, ""));
}

export function clearAllInstances() {
  const db = getDb();
  db.exec("DELETE FROM instances");
}

// ── Active Sessions ─────────────────────────────────────────────────────────

export function setActiveSession(projectPath, { sessionId, mode }) {
  const db = getDb();
  const normalizedPath = projectPath.toLowerCase().replace(/\/+$/, "");
  const existing = db.prepare("SELECT * FROM active_sessions WHERE project_path = ?").get(normalizedPath);

  if (existing) {
    const updates = { sessionId: sessionId ?? existing.session_id };
    if (mode !== undefined) updates.mode = mode;
    const stmt = db.prepare(`
      UPDATE active_sessions
      SET session_id = ?, mode = ?, updated_at = ?
      WHERE project_path = ?
    `);
    return stmt.run(updates.sessionId, updates.mode ?? existing.mode, now(), normalizedPath);
  } else {
    const stmt = db.prepare(`
      INSERT INTO active_sessions (project_path, session_id, mode, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    return stmt.run(normalizedPath, sessionId, mode ?? null, now());
  }
}

export function getActiveSession(projectPath) {
  const db = getDb();
  const normalizedPath = projectPath.toLowerCase().replace(/\/+$/, "");
  const row = db.prepare("SELECT * FROM active_sessions WHERE project_path = ?").get(normalizedPath);
  if (!row) return null;
  return {
    sessionId: row.session_id,
    mode: row.mode,
    updatedAt: row.updated_at,
  };
}

export function setMode(projectPath, mode) {
  const db = getDb();
  const normalizedPath = projectPath.toLowerCase().replace(/\/+$/, "");
  const existing = db.prepare("SELECT session_id FROM active_sessions WHERE project_path = ?").get(normalizedPath);
  if (existing) {
    const stmt = db.prepare("UPDATE active_sessions SET mode = ?, updated_at = ? WHERE project_path = ?");
    return stmt.run(mode, now(), normalizedPath);
  } else {
    const stmt = db.prepare("INSERT INTO active_sessions (project_path, session_id, mode, updated_at) VALUES (?, ?, ?, ?)");
    return stmt.run(normalizedPath, null, mode, now());
  }
}

// ── Projects (config) ───────────────────────────────────────────────────────

export function listProjects() {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM projects ORDER BY scope");
  return stmt.all().map((row) => ({
    scope: row.scope,
    path: row.path,
    label: row.label,
    updatedAt: row.updated_at,
  }));
}

export function upsertProject({ scope, path, label }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO projects (scope, path, label, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope) DO UPDATE SET
      path = excluded.path,
      label = excluded.label,
      updated_at = excluded.updated_at
  `);
  return stmt.run(scope, path, label, now());
}

export function initializeDefaultProjects() {
  const defaults = [
    { scope: "petar", path: "/Users/petartopic/Desktop/Petar", label: "Personal" },
    { scope: "profico", path: "/Users/petartopic/Desktop/Profico", label: "Work" },
  ];
  for (const proj of defaults) {
    upsertProject(proj);
  }
}
