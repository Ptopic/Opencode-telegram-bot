/**
 * code-status [--project <path>]
 * Check index status on the code-search server (port 4098).
 * Usage: opencode-telegram code-status [--project <path>]
 */
import axios from "axios";

const CODE_SEARCH_PORT = 4098;
const BASE_URL = `http://localhost:${CODE_SEARCH_PORT}`;

/**
 * @param {{ projectPath?: string }} options
 */
export async function codeStatusCommand(options = {}) {
  try {
    console.error("Fetching index status...");

    const response = await axios.get(`${BASE_URL}/api/search/stats`, { timeout: 10_000 });
    const { stats } = response.data;

    if (!stats) {
      console.log("No index statistics available.");
      return;
    }

    console.log("=== Code Index Status ===\n");

    if (stats.projectPath) {
      console.log(`Project: ${stats.projectPath}`);
    }

    console.log(`Total chunks: ${stats.totalChunks}`);
    console.log(`Total files:  ${stats.totalFiles}`);
    console.log(`Total lines:  ${stats.totalLines}`);

    if (stats.lastIndexed) {
      const lastIndexed = new Date(stats.lastIndexed);
      console.log(`Last indexed: ${lastIndexed.toLocaleString()}`);
    }

    if (stats.indexSizeBytes) {
      const sizeMB = (stats.indexSizeBytes / (1024 * 1024)).toFixed(2);
      console.log(`Index size:   ${sizeMB} MB`);
    }

    if (stats.languages && Object.keys(stats.languages).length > 0) {
      console.log("\nLanguages:");
      for (const [lang, count] of Object.entries(stats.languages)) {
        console.log(`  ${lang}: ${count} files`);
      }
    }

    console.log();
  } catch (err) {
    if (err.code === "ECONNREFUSED") {
      console.error(`Error: Cannot connect to code-search server at ${BASE_URL}`);
      console.error("Make sure the code-search server is running: pnpm --filter @opencode-telegram/code-search start");
      process.exit(1);
    }
    const message = err?.response?.data?.error ?? err?.message ?? "Unknown error";
    console.error(`Status check failed: ${message}`);
    process.exit(1);
  }
}
