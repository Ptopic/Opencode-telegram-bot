/**
 * OpenCode Agent Configuration
 *
 * This file defines the centralized tool policy, permissions, agent prompts,
 * and model assignments. When `opencode-telegram prompt <path>` is run, these
 * settings are merged into the target project's `.opencode/oh-my-openagent.jsonc`.
 *
 * This is the SINGLE SOURCE OF TRUTH — edit here, not in the JSONC template.
 */

// ─── Models ────────────────────────────────────────────────────────────────────
//
// Two model tiers: smart (deep reasoning) and normal (fast utility).
// `model set smarter/normal` writes here; `prompt <path>` applies to agents/categories.
//
export const models = {
  smart: "openai/gpt-5.4",
  normal: "minimax-coding-plan/MiniMax-M2.7-highspeed",
};

export const smartAgents = [
  "sisyphus",
  "oracle",
  "metis",
  "momus",
  "prometheus",
  "hephaestus",
];

export const normalAgents = [
  "ultrawork",
  "explore",
  "general",
  "librarian",
  "atlas",
  "sisyphus-junior",
  "multimodal-looker",
  "reviewer",
];

export const smartCategories = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "unspecified-high",
];

export const normalCategories = [
  "quick",
  "unspecified-low",
  "writing",
];

// ─── Tool Policy ────────────────────────────────────────────────────────────────
//
// Policy: allow ALL tools by default, then deny or restrict specific ones.
//
// `deniedTools`   → set to `false` in tools + `"deny"` in permission (hard block)
// `askTools`      → reserved list of tools to mark as `"ask"` later
// `bashRules`     → command-pattern permission map for the bash tool
//
// These apply to EVERY agent + the top-level config.
//
export const deniedTools = [
  // AST-based search (use code-search instead)
  "ast_grep_search",
  "ast_grep_replace",

  // Web search (use bx skill instead)
  "MiniMax_web_search",
  "webfetch",
  "web-search-prime_web_search_prime",
  "websearch_web_search_exa",
];

export const askTools = [];

export const bashRules = {
  "*": "ask",
  "bx": "allow",
  "bx *": "allow",
};

// ─── Agent Skills ──────────────────────────────────────────────────────────────
//
// Per-agent skill assignments. Overrides any `skills` in the JSONC template.
// Omitted agents get no skills array (removed if present in template).
//
export const agentSkills = {
  explore: ["code-search", "bx"],
  librarian: ["code-search", "bx"],
  reviewer: ["deep-code-review", "code-search"],
};

// ─── Agent Prompts ─────────────────────────────────────────────────────────────
//
// Each key is an agent name, and the value is the `prompt_append` string that
// gets injected into that agent's config. This replaces any existing
// `prompt_append` in the template.
//
// Two prompt groups exist:
//   1. "code-search" agents: full tool policy + code-search tools + prohibited
//      tools + web search policy + context
//   2. "web-only" agents: just web search policy
//

const CODE_SEARCH_TOOLS_LIST = `
## Code-Search Tools (USE THESE)
- code_search - Semantic code search using natural language queries
- code_search_code_search - Find code by meaning, not just exact matches
- code_search_code_graph_search - Graph-based code search
- code_search_code_graph_context - Get detailed context for a graph node
- code_search_code_graph_callers - Find all functions that call a specific function
- code_search_code_graph_callees - Find all functions called by a specific function
- code_search_code_index - Index code paths for search
- code_search_code_stats - Get statistics about the code index
- code_search_code_remove_index - Remove a path from the index
- code_search_code_watch_start - Start watching paths for changes
- code_search_code_watch_stop - Stop watching paths
- code_search_code_dead_code - Find potentially dead code
- read - Read file contents (use after code-search finds exact file paths)
- grep / rg - only use after code_search returns exact file paths or results, for narrowing to a specific section`;

const PROHIBITED_TOOLS = `
## PROHIBITED TOOLS (NEVER use — blocked at config level)
- ast_grep_search, ast_grep_replace - use code_search instead
- MiniMax_web_search, webfetch, web-search-prime, websearch_web_search_exa - use bx skill instead`;

const WEB_SEARCH_POLICY = `
## Web Search Policy (MANDATORY)
- For ALL web searches, you MUST use the \`bx\` command (Brave Search CLI) via the \`bx\` skill.
- NEVER use MiniMax web search (MiniMax_web_search), webfetch, web-search-prime_web_search_prime, websearch_web_search_exa, or any other web search tool.
- The ONLY permitted web search method is \`bx\` — use \`bx "query"\` for RAG/grounding, \`bx answers "query"\` for synthesized answers, \`bx web "query"\` for traditional search results, \`bx news "query"\` for news, etc.
- Bash is restricted to \`bx\` commands only. Do not use bash for any non-\`bx\` command.
- If you need to search the web, invoke the bx skill and use it. No other web search tool is allowed.`;

export const agentPrompts = {
  // ── Code-search agents ─────────────────────────────────────────────────────

  sisyphus: `
## Tool policy
You MUST use code_search first for code discovery. Only after code_search returns exact file paths or results may you use grep or rg to narrow to a specific section. Do NOT use glob, find, fd, ls, cat, sed, awk, bash search, ast_grep_search, ast_grep_replace, or similar tools for initial discovery. When delegating tasks to subagents, instruct them to follow the same code_search-first workflow.
${CODE_SEARCH_TOOLS_LIST}
${PROHIBITED_TOOLS}
${WEB_SEARCH_POLICY}
- When delegating to subagents, instruct them to also use only bx for web search. Never allow subagents to use MiniMax web search, webfetch, or any other non-Brave search tool.
 `,

  ultrawork: `
## Tool policy
Use code_search first for repository inspection. Only after code_search returns exact file paths or results may you use grep or rg to narrow to a specific section. NEVER use glob, find, fd, ls, cat, sed, awk, bash, ast_grep_search, ast_grep_replace, or any shell-based discovery for the initial search.
${CODE_SEARCH_TOOLS_LIST}
${PROHIBITED_TOOLS}
${WEB_SEARCH_POLICY}
 `,

  explore: `
## Tool policy
Use code_search for initial code discovery. Only after code_search returns exact file paths or results may you use grep or rg to narrow to a specific section. NEVER use glob, find, fd, ls, cat, sed, awk, bash, ast_grep_search, ast_grep_replace, or shell-based discovery for the initial search.
${CODE_SEARCH_TOOLS_LIST}
${PROHIBITED_TOOLS}
${WEB_SEARCH_POLICY}
 `,

  general: `
## Repository inspection workflow
Use code_search first for code discovery. Only after code_search returns exact file paths or results may you use grep or rg to narrow to a specific section. Do NOT use glob, find, fd, ls, cat, sed, awk, bash, ast_grep_search, ast_grep_replace, or any shell-based tool for the initial search.
${CODE_SEARCH_TOOLS_LIST}
${PROHIBITED_TOOLS}
${WEB_SEARCH_POLICY}
## code-search first, read second
When you need to find code:
1. Use code-search_code_search with natural language query
2. Use code-search_code_graph_* for dependency relationships
3. Use read for file contents once you have exact file paths from code-search results
4. Use grep/rg only as a follow-up filter on those returned results or files
 `,

  oracle: `
## Repository inspection workflow
Base code analysis on a code_search-first workflow. Only after code_search returns exact file paths or results may grep or rg be used to narrow to a specific section. Do NOT request or use glob, find, fd, ls, cat, sed, awk, bash, ast_grep_search, ast_grep_replace, or any shell-based tool for initial discovery.
${CODE_SEARCH_TOOLS_LIST}
${PROHIBITED_TOOLS}
${WEB_SEARCH_POLICY}
## Analysis approach
When debugging or analyzing architecture, always start with code-search to understand the codebase structure before forming hypotheses.
 `,

  librarian: `
## Repository inspection workflow
Use code_search first for code/document discovery within this repository. Only after code_search returns exact file paths or results may grep or rg be used to narrow to a specific section. Never use glob, list, bash, find, fd, ls, cat, sed, awk, ast_grep_search, ast_grep_replace, or shell discovery for the initial search.
${CODE_SEARCH_TOOLS_LIST}
${PROHIBITED_TOOLS}
${WEB_SEARCH_POLICY}
- When searching external resources, libraries and frameworks, use the bx skill for web search. No other web search tool is allowed.
 `,

  // ── Web-only agents (no code-search) ──────────────────────────────────────

  prometheus: `${WEB_SEARCH_POLICY}`,
  metis: `${WEB_SEARCH_POLICY}`,
  atlas: `${WEB_SEARCH_POLICY}`,
  "sisyphus-junior": `${WEB_SEARCH_POLICY}`,
  momus: `${WEB_SEARCH_POLICY}`,
  hephaestus: `${WEB_SEARCH_POLICY}`,
  "multimodal-looker": `${WEB_SEARCH_POLICY}`,
  reviewer: `
## You are a senior code reviewer
You perform thorough, structured code reviews. You have access to:
- code-search tools for code discovery
- bash for running linters, tests, and git diffs
- edit/write for applying targeted fixes

When a review is requested:
1. Load the deep-code-review skill (it will be injected automatically)
2. Run pre-flight checks (npm run lint, git diff, etc.)
3. Review all files in scope across all 5 categories
4. Triage findings as CRITICAL / WARNING / SUGGESTION / INFO
5. Present findings in the structured output format defined in your skill

Always quote actual code in findings. Explain why something is a problem, not just what is wrong.
 `,
};
