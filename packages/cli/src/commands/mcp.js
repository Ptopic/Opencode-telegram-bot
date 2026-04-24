import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// repoRoot: packages/cli/src/commands/mcp.js -> packages/cli/src/commands -> packages/cli/src -> packages/cli -> packages -> repo root
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * Print MCP server launch configuration and command for connecting
 * code-search tools to OpenCode agents.
 */
export function mcpCommand() {
  const mcpServerPackage = path.resolve(repoRoot, "packages", "mcp-server");

  console.log("\n🔌  OpenCode MCP Server — code-search tools\n");

  console.log("┌─ Project path ────────────────────────────────────────────────┐");
  console.log(`│  ${mcpServerPackage.padEnd(60)}│`);
  console.log("└──────────────────────────────────────────────────────────────┘\n");

  console.log("┌─ JSON config (add to OpenCode config) ────────────────────────┐");
  const config = {
    mcpServers: {
      "code-search": {
        command: "node",
        args: [path.join(mcpServerPackage, "dist", "index.js")],
        env: {
          CODE_SEARCH_API_URL: "http://localhost:4098",
        },
      },
    },
  };
  console.log(JSON.stringify(config, null, 2).split("\n").map((l) => `│  ${l.padEnd(60)}│`).join("\n"));
  console.log("└──────────────────────────────────────────────────────────────┘\n");

  console.log("┌─ Direct launch command (for testing) ─────────────────────────┐");
  const directCmd = `node ${path.join(mcpServerPackage, "dist", "index.js")}`;
  console.log(`│  ${directCmd.padEnd(60)}│`);
  console.log("└──────────────────────────────────────────────────────────────┘\n");

  console.log("┌─ Prerequisites ───────────────────────────────────────────────┐");
  console.log("│  1. Build the MCP server:                                     │");
  console.log("│     cd packages/mcp-server && npm run build                   │");
  console.log("│                                                                 │");
  console.log("│  2. Start the code-search API server (port 4098):             │");
  console.log("│     cd packages/code-search && npm run dev                     │");
  console.log("│                                                                 │");
  console.log("│  3. Start OpenCode (port 4097):                               │");
  console.log("│     opencode-telegram serve --port=4097                       │");
  console.log("│                                                                 │");
  console.log("│  4. Connect MCP server to OpenCode:                           │");
  console.log("│     Add the JSON config above to OpenCode's mcp-config.json   │");
  console.log("└──────────────────────────────────────────────────────────────┘\n");

  console.log("┌─ Available MCP tools ─────────────────────────────────────────┐");
  const tools = [
    { name: "code_index", desc: "Index code paths for semantic search" },
    { name: "code_search", desc: "Search indexed code with natural language query" },
    { name: "code_stats", desc: "Get index statistics (chunks, files, languages)" },
    { name: "code_remove_index", desc: "Remove a path from the index" },
    { name: "code_watch_start", desc: "Start watching paths for changes" },
    { name: "code_watch_stop", desc: "Stop watching paths" },
    { name: "code_graph", desc: "Get call graph context for a function" },
    { name: "code_dead_code", desc: "Find unused/dead code in the project" },
  ];
  for (const t of tools) {
    const line = `│  ${t.name.padEnd(20)} ${t.desc}`;
    console.log(line.padEnd(62) + "│");
  }
  console.log("└──────────────────────────────────────────────────────────────┘\n");

  console.log("┌─ Per-project isolation ───────────────────────────────────────┐");
  console.log("│  projectPath is required for code_search and code_stats.       │");
  console.log("│  OpenCode agents pass it automatically based on session CWD.  │");
  console.log("└──────────────────────────────────────────────────────────────┘\n");
}
