import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OPENCODE_JSON_TEMPLATE = {
  $schema: "https://opencode.ai/config.json",
  instructions: [
    "You MUST use the code-search tool for ALL code search queries. NEVER use grep, ripgrep, rg, or any other search tool.",
    "The code-search MCP server provides semantic code search via vector embeddings, BM25, and knowledge graph. Use it instead of grep.",
  ],
  permission: {
    "*": "ask",
    grep: "deny",
    rg: "deny",
    bash: "ask",
    read: "allow",
    edit: "ask",
    write: "ask",
  },
  mcp: {
    "code-search": {
      type: "local",
      command: ["node", "/Users/petartopic/Desktop/Petar/Opencode-telegram-bot/packages/mcp-server/dist/index.js"],
      environment: { CODE_SEARCH_API_URL: "http://localhost:4098" },
      enabled: true,
    },
  },
};

const AGENTS_MD_CONTENT = `# Code Search Agent Rules

## Mandatory Tool Usage

**You MUST use the \`code-search\` MCP tool for ALL code search queries.**

### Prohibited Tools (NEVER use):
- \`grep\`
- \`ripgrep\` / \`rg\`
- \`ast-grep\` / \`sg\`
- \`search\` commands in bash
- Any direct file content search

### Required Tool:
- Use \`code-search\` MCP tool for semantic code search, symbol lookup, and codebase queries
- The code-search tool uses vector embeddings, BM25 keyword search, and knowledge graph for accurate code discovery

## How to Use code-search

When you need to find code in the codebase:

1. Use the \`code-search\` tool with a natural language query
2. Example queries:
   - "Where is the search function defined?"
   - "Find all usages of the Database class"
   - "Show me the implementation of chunkFile"

## Why This Rule Exists

Our code-search tool provides:
- Semantic understanding (finds code by meaning, not just exact matches)
- Knowledge graph relationships (callers, callees, imports)
- Summary embeddings (LLM-generated context for better matching)
- Incremental indexing (fast re-searches with hash-based change detection)

Using grep bypasses all these features and returns inferior results.

## Enforcement

If you attempt to use prohibited search tools, the system will:
1. Block the command
2. Remind you to use \`code-search\` instead

Always use \`code-search\` for code discovery tasks.
`;

export function promptCommand(targetPath) {
  const projectPath = targetPath || process.cwd();

  console.log(`Setting up OpenCode prompt config for: ${projectPath}`);

  const opencodeDir = path.join(projectPath, ".opencode");

  if (existsSync(opencodeDir)) {
    console.log(`Warning: ${opencodeDir} already exists.`);
    console.log("Skipping - please remove existing .opencode folder manually to re-create.");
    return;
  }

  try {
    mkdirSync(opencodeDir, { recursive: true });

    const opencodeJsonPath = path.join(opencodeDir, "opencode.json");
    writeFileSync(opencodeJsonPath, JSON.stringify(OPENCODE_JSON_TEMPLATE, null, 2));
    console.log(`Created: ${opencodeJsonPath}`);

    const agentsMdPath = path.join(opencodeDir, "AGENTS.md");
    writeFileSync(agentsMdPath, AGENTS_MD_CONTENT);
    console.log(`Created: ${agentsMdPath}`);

    console.log("\nDone! The .opencode folder has been created.");
    console.log("\nTo use:");
    console.log(`  cd ${projectPath}`);
    console.log("  opencode");
    console.log("\nThe agent will now use code-search instead of grep for code queries.");
  } catch (err) {
    console.error(`Failed to create .opencode folder: ${err.message}`);
    process.exit(1);
  }
}