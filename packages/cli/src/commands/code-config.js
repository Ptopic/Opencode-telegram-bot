import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { loadCodeSearchConfig, getCodeSearchConfigPath } from "../config.js";

const DEFAULT_CONFIG = {
  generateSummary: true,
  searchMode: "hybrid",
  bm25Weight: 0.25,
  vectorWeight: 0.35,
  graphWeight: 0.15,
  summaryWeight: 0.25,
};

const SEARCH_MODES = ["hybrid", "vector-graph", "vector-only"];

export async function codeConfigCommand(action, key, value) {
  const configPath = getCodeSearchConfigPath();

  if (action === "get") {
    const config = loadCodeSearchConfig();
    console.log(`Code-Search Global Config: ${configPath}\n`);
    console.log(`  generateSummary: ${config.generateSummary}`);
    console.log(`  searchMode:     ${config.searchMode} (${getSearchModeDescription(config.searchMode)})`);
    console.log(`  bm25Weight:     ${config.bm25Weight}`);
    console.log(`  vectorWeight:   ${config.vectorWeight}`);
    console.log(`  graphWeight:    ${config.graphWeight}`);
    console.log(`  summaryWeight:  ${config.summaryWeight}`);
    console.log();
    return;
  }

  if (action === "set") {
    if (!key) {
      console.error("Usage: opencode-telegram code-config set <key> <value>");
      console.error("Keys: generateSummary, searchMode, bm25Weight, vectorWeight, graphWeight, summaryWeight");
      process.exit(1);
    }

    if (!["generateSummary", "searchMode", "bm25Weight", "vectorWeight", "graphWeight", "summaryWeight"].includes(key)) {
      console.error(`Unknown key: ${key}`);
      console.error("Valid keys: generateSummary, searchMode, bm25Weight, vectorWeight, graphWeight, summaryWeight");
      process.exit(1);
    }

    if (key === "searchMode" && !SEARCH_MODES.includes(value)) {
      console.error(`Invalid searchMode: ${value}`);
      console.error(`Valid modes: ${SEARCH_MODES.join(", ")}`);
      console.error("  hybrid       - BM25 + vector + graph + summary (default)");
      console.error("  vector-graph - vector + graph only (no BM25)");
      console.error("  vector-only  - pure vector search");
      process.exit(1);
    }

    if (key === "generateSummary" && !["true", "false"].includes(value)) {
      console.error("generateSummary must be true or false");
      process.exit(1);
    }

    if (["bm25Weight", "vectorWeight", "graphWeight", "summaryWeight"].includes(key)) {
      const num = parseFloat(value);
      if (isNaN(num) || num < 0 || num > 1) {
        console.error(`${key} must be a number between 0 and 1`);
        process.exit(1);
      }
      value = num;
    } else if (key === "generateSummary") {
      value = value === "true";
    }

    const config = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, "utf8"))
      : { ...DEFAULT_CONFIG };

    config[key] = value;
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`Updated ${key} = ${value} in ${configPath}`);
    return;
  }

  if (action === "reset") {
    writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log(`Reset config to defaults in ${configPath}`);
    return;
  }

  console.error("Usage: opencode-telegram code-config <get|set|reset> [key] [value]");
  console.error("  opencode-telegram code-config get          # Show current config");
  console.error("  opencode-telegram code-config set <key> <value>  # Set a value");
  console.error("  opencode-telegram code-config reset         # Reset to defaults");
  process.exit(1);
}

function getSearchModeDescription(mode) {
  switch (mode) {
    case "hybrid": return "BM25 + vector + graph + summary";
    case "vector-graph": return "vector + graph only (no BM25)";
    case "vector-only": return "pure vector search";
  }
}