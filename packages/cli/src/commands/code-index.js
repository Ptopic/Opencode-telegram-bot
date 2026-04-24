/**
 * code-index <projectPath> [--watch]
 * Index a project on the code-search server (port 4098).
 * Usage: opencode-telegram code-index <projectPath> [--watch]
 */
import axios from "axios";

const CODE_SEARCH_PORT = 4098;
const BASE_URL = `http://localhost:${CODE_SEARCH_PORT}`;

/**
 * @param {string} projectPath
 * @param {{ watch?: boolean }} options
 */
export async function codeIndexCommand(projectPath, options = {}) {
  if (!projectPath) {
    projectPath = process.cwd();
    console.error(`No path given — using current directory: ${projectPath}`);
  }

  const normalizedPath = projectPath.replace(/\/+$/, "");

  try {
    // Start watching if --watch flag is set
    if (options.watch) {
      console.error(`Starting file watcher for: ${normalizedPath}`);
      await axios.post(`${BASE_URL}/api/search/watch/start`, { paths: [normalizedPath] });
      console.error("File watcher started.");
      // Keep process alive for watching
      console.error("Watching for changes... Press Ctrl+C to stop.");
      process.stdin.resume();
      return;
    }

    // Index the path
    console.error(`Indexing: ${normalizedPath}`);
    const response = await axios.post(
      `${BASE_URL}/api/search/index`,
      { paths: [normalizedPath] },
      { timeout: 300_000 } // 5 minute timeout for large repos
    );

    const { stats } = response.data;

    console.error(`Indexed ${stats.totalFiles} files, ${stats.totalChunks} chunks`);
    console.error(`Languages: ${Object.entries(stats.languages || {}).map(([lang, count]) => `${lang} (${count})`).join(", ")}`);
    console.log(JSON.stringify({ success: true, stats }, null, 2));
  } catch (err) {
    if (err.code === "ECONNREFUSED") {
      console.error(`Error: Cannot connect to code-search server at ${BASE_URL}`);
      console.error("Make sure the code-search server is running: pnpm --filter @opencode-telegram/code-search start");
      process.exit(1);
    }
    const message = err?.response?.data?.error ?? err?.message ?? "Unknown error";
    console.error(`Indexing failed: ${message}`);
    process.exit(1);
  }
}
