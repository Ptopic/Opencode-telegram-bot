/**
 * Config loader — reads ~/.opencode-telegram.json (project roots)
 * and .opencode-telegram-config.json (all other settings).
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");

const CONFIG_PATH = path.join(homedir(), ".opencode-telegram.json");

const GLOBAL_CONFIG_PATH = path.join(REPO_ROOT, ".opencode-telegram-config.json");

const DEFAULT_PROJECT_ROOTS = [
  { scope: "petar", path: "/Users/petartopic/Desktop/Petar", label: "Petar" },
  { scope: "profico", path: "/Users/petartopic/Desktop/Profico", label: "Profico" },
];

const DEFAULT_GLOBAL_CONFIG = {
  generateSummary: true,
  searchMode: "hybrid",
  bm25Weight: 0.25,
  vectorWeight: 0.35,
  graphWeight: 0.15,
  summaryWeight: 0.25,
  toolCallDisplay: false,
};

let _cached = null;
let _globalCached = null;

export function loadConfig() {
  if (_cached) return _cached;

  if (!existsSync(CONFIG_PATH)) {
    _cached = { projectRoots: DEFAULT_PROJECT_ROOTS };
    return _cached;
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    _cached = {
      projectRoots: Array.isArray(raw.projectRoots) && raw.projectRoots.length > 0
        ? raw.projectRoots
        : DEFAULT_PROJECT_ROOTS,
    };
  } catch {
    _cached = { projectRoots: DEFAULT_PROJECT_ROOTS };
  }

  return _cached;
}

export function getProjectRoots() {
  return loadConfig().projectRoots;
}

export function loadGlobalConfig() {
  if (_globalCached) return _globalCached;

  if (!existsSync(GLOBAL_CONFIG_PATH)) {
    _globalCached = { ...DEFAULT_GLOBAL_CONFIG };
    return _globalCached;
  }

  try {
    const raw = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8"));
    _globalCached = {
      ...DEFAULT_GLOBAL_CONFIG,
      generateSummary: raw.generateSummary === true || raw.generateSummary === false ? raw.generateSummary : true,
      searchMode: ["hybrid", "vector-graph", "vector-only"].includes(raw.searchMode) ? raw.searchMode : "hybrid",
      bm25Weight: typeof raw.bm25Weight === "number" ? raw.bm25Weight : 0.25,
      vectorWeight: typeof raw.vectorWeight === "number" ? raw.vectorWeight : 0.35,
      graphWeight: typeof raw.graphWeight === "number" ? raw.graphWeight : 0.15,
      summaryWeight: typeof raw.summaryWeight === "number" ? raw.summaryWeight : 0.25,
      toolCallDisplay: raw.toolCallDisplay === true,
    };
  } catch {
    _globalCached = { ...DEFAULT_GLOBAL_CONFIG };
  }

  return _globalCached;
}

export function getGlobalConfigPath() {
  return GLOBAL_CONFIG_PATH;
}

export function setGlobalConfigValue(key, value) {
  let raw = {};
  if (existsSync(GLOBAL_CONFIG_PATH)) {
    try {
      raw = JSON.parse(readFileSync(GLOBAL_CONFIG_PATH, "utf8"));
    } catch {}
  }
  raw[key] = value;
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(raw, null, 2));
  _globalCached = null;
  return loadGlobalConfig();
}

export function loadCodeSearchConfig() {
  const global = loadGlobalConfig();
  return {
    generateSummary: global.generateSummary,
    searchMode: global.searchMode,
    bm25Weight: global.bm25Weight,
    vectorWeight: global.vectorWeight,
    graphWeight: global.graphWeight,
    summaryWeight: global.summaryWeight,
  };
}

export function getCodeSearchConfigPath() {
  return GLOBAL_CONFIG_PATH;
}

export function loadServerConfig() {
  const global = loadGlobalConfig();
  return {
    toolCallDisplay: global.toolCallDisplay,
  };
}

export function getServerConfigPath() {
  return GLOBAL_CONFIG_PATH;
}

export function setServerConfigValue(key, value) {
  return setGlobalConfigValue(key, value);
}

/** For testability — reset cached config */
export function _clearCache() {
  _cached = null;
  _globalCached = null;
}
