/**
 * Config loader — reads ~/.opencode-telegram.json and merges with defaults.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");

const CONFIG_PATH = path.join(homedir(), ".opencode-telegram.json");

const CODE_SEARCH_CONFIG_PATH = path.join(REPO_ROOT, ".opencode-telegram-code-search.json");

const DEFAULT_PROJECT_ROOTS = [
  { scope: "petar", path: "/Users/petartopic/Desktop/Petar", label: "Petar" },
  { scope: "profico", path: "/Users/petartopic/Desktop/Profico", label: "Profico" },
];

const DEFAULT_CODE_SEARCH_CONFIG = {
  generateSummary: true,
  searchMode: "hybrid",
  bm25Weight: 0.25,
  vectorWeight: 0.35,
  graphWeight: 0.15,
  summaryWeight: 0.25,
};

let _cached = null;
let _codeSearchCached = null;

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

export function loadCodeSearchConfig() {
  if (_codeSearchCached) return _codeSearchCached;

  if (!existsSync(CODE_SEARCH_CONFIG_PATH)) {
    _codeSearchCached = { ...DEFAULT_CODE_SEARCH_CONFIG };
    return _codeSearchCached;
  }

  try {
    const raw = JSON.parse(readFileSync(CODE_SEARCH_CONFIG_PATH, "utf8"));
    _codeSearchCached = { ...DEFAULT_CODE_SEARCH_CONFIG, ...raw };
  } catch {
    _codeSearchCached = { ...DEFAULT_CODE_SEARCH_CONFIG };
  }

  return _codeSearchCached;
}

export function getCodeSearchConfigPath() {
  return CODE_SEARCH_CONFIG_PATH;
}

/** For testsability — reset cached config */
export function _clearCache() {
  _cached = null;
  _codeSearchCached = null;
}
