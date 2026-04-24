/**
 * code-search <query> [--project <path>] [--limit <n>]
 * Search indexed code on the code-search server (port 4098).
 * Usage: opencode-telegram code-search <query> [--project <path>] [--limit 10]
 */
import axios from "axios";

const CODE_SEARCH_PORT = 4098;
const BASE_URL = `http://localhost:${CODE_SEARCH_PORT}`;

/**
 * @param {string} query
 * @param {{ projectPath?: string, limit?: number }} options
 */
export async function codeSearchCommand(query, options = {}) {
  if (!query) {
    console.error("Usage: opencode-telegram code-search <query> [--project <path>] [--limit <n>]");
    process.exit(1);
  }

  const limit = options.limit ?? 10;

  try {
    console.error(`Searching for: "${query}" (limit: ${limit})`);

    const response = await axios.post(
      `${BASE_URL}/api/search/search`,
      {
        query,
        options: {
          limit,
          threshold: 0.3,
        },
      },
      { timeout: 60_000 }
    );

    const { results } = response.data;

    if (!results || results.length === 0) {
      console.log("No results found.");
      return;
    }

    console.error(`\nFound ${results.length} result(s):\n`);

    for (const result of results) {
      const { chunk, score, highlights } = result;
      const filePath = chunk.filePath;
      const lines = `${chunk.startLine}-${chunk.endLine}`;
      const relevancePct = Math.round(score * 100);

      console.log(`━━━ ${filePath}:${lines} (relevance: ${relevancePct}%) ━━━`);

      // Show snippet
      const snippet = chunk.content.slice(0, 300).replace(/\n/g, " ");
      console.log(`   ${snippet}${chunk.content.length > 300 ? "..." : ""}`);

      // Show highlights if available
      if (highlights && highlights.length > 0) {
        console.log(`   Match: ${highlights.join(" / ")}`);
      }

      console.log();
    }
  } catch (err) {
    if (err.code === "ECONNREFUSED") {
      console.error(`Error: Cannot connect to code-search server at ${BASE_URL}`);
      console.error("Make sure the code-search server is running: pnpm --filter @opencode-telegram/code-search start");
      process.exit(1);
    }
    const message = err?.response?.data?.error ?? err?.message ?? "Unknown error";
    console.error(`Search failed: ${message}`);
    process.exit(1);
  }
}
