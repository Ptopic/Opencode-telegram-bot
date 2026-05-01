# Code Search Agent Rules

## Mandatory Tool Usage

**You MUST use the `code-search` MCP tool first for ALL code discovery queries.**

### Initial Discovery Rules

- Use `code-search` MCP tool for semantic code search, symbol lookup, and codebase queries
- `read` is allowed to inspect files after you have exact file paths or relevant results
- `grep` / `rg` are allowed only after `code-search` returns exact file paths or relevant results, and only to narrow to a specific section

### Still Prohibited for Initial Discovery

- `ast-grep` / `sg`
- `search` commands in bash
- Any direct shell-based file content search before `code-search`

## How to Use code-search

When you need to find code in the codebase:

1. Use the `code-search` tool with a natural language query
2. Use `read` on exact files returned by `code-search`
3. Use `grep` / `rg` only as follow-up narrowing on those returned files or results when needed
4. Example queries:
   - "Where is the search function defined?"
   - "Find all usages of the Database class"
   - "Show me the implementation of chunkFile"

## Why This Rule Exists

Our code-search tool provides:

- Semantic understanding (finds code by meaning, not just exact matches)
- Knowledge graph relationships (callers, callees, imports)
- Summary embeddings (LLM-generated context for better matching)
- Incremental indexing (fast re-searches with hash-based change detection)

Using `code-search` first preserves these benefits while still allowing `grep` / `rg` later for precise snippet narrowing.

## Enforcement

If you attempt to skip the `code-search`-first workflow or use prohibited search tools, the system will:

1. Block the command
2. Remind you to use `code-search` instead

Always use `code-search` first for code discovery tasks.
