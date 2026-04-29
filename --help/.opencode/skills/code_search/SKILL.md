---
name: code-search
description: Semantic code search using vector embeddings, BM25, and knowledge graph. Use this skill when you need to find code by meaning, not just exact matches.
---

# Code Search Skill

You have access to the code-search MCP server which provides semantic code search via vector embeddings, BM25, and knowledge graph.

## Available Tools

- `code_search` - Semantic code search using natural language queries
- `code_index` - Index code paths for search
- `code_stats` - Get statistics about the code index
- `code_remove_index` - Remove a path from the index
- `code_watch_start` - Start watching paths for changes
- `code_watch_stop` - Stop watching paths
- `code_graph_search` - Graph-based code search
- `code_graph_context` - Get detailed context for a graph node
- `code_graph_callers` - Find all functions that call a specific function
- `code_graph_callees` - Find all functions called by a specific function
- `code_dead_code` - Find potentially dead code

## Usage

1. Use `code-search_code_search` with a natural language query to find code
2. Use `code-search_code_graph_*` tools for dependency analysis
3. Use `read` to view specific files after finding them

## Workflow

1. `code-search_code_search(query="what you're looking for")`
2. `code-search_code_graph_callers(qualifiedName="module.functionName")` for dependencies
3. `read(filePath="path/to/file.ts")` to view files

## Prohibition

NEVER use grep, ripgrep, rg, glob, find, ls, cat, sed, awk, or bash for code discovery. Always use code-search tools first.
