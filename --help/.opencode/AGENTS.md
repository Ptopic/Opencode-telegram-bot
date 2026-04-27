# Code Search Agent Rules

## Mandatory Tool Usage

**You MUST use the `code-search` MCP tool for ALL code search queries.**

### Prohibited Tools (NEVER use):
- `grep`
- `ripgrep` / `rg`
- `ast-grep` / `sg`
- `search` commands in bash
- Any direct file content search

### Required Tool:
- Use `code-search` MCP tool for semantic code search, symbol lookup, and codebase queries
- The code-search tool uses vector embeddings, BM25 keyword search, and knowledge graph for accurate code discovery

## How to Use code-search

When you need to find code in the codebase:

1. Use the `code-search` tool with a natural language query
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
2. Remind you to use `code-search` instead

Always use `code-search` for code discovery tasks.
