/**
 * Config loader — reads ~/.opencode-telegram.json and merges with defaults.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = path.join(homedir(), ".opencode-telegram.json");

const DEFAULT_PROJECT_ROOTS = [
  { scope: "petar", path: "/Users/petartopic/Desktop/Petar", label: "Petar" },
  { scope: "profico", path: "/Users/petartopic/Desktop/Profico", label: "Profico" },
];

let _cached = null;

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

/** For testsability — reset cached config */
export function _clearCache() {
  _cached = null;
}
