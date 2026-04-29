import axios from "axios";
import fs from "node:fs";
import path from "node:path";

const CODE_SEARCH_PORT = 4098;
const BASE_URL = `http://localhost:${CODE_SEARCH_PORT}`;

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  "coverage",
  ".nyc_output",
  ".env",
  "venv",
  ".venv",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".json"
]);

function isIgnored(dirPath, entryName) {
  if (IGNORE_DIRS.has(entryName)) return true;
  if (entryName.startsWith(".")) return true;
  if (entryName.endsWith(".pyc")) return true;
  if (entryName === "package-lock.json" || entryName === "pnpm-lock.yaml" || entryName === "yarn.lock") return true;
  if (entryName === ".DS_Store" || entryName === "Thumbs.db") return true;
  return false;
}

function countFiles(dirPath) {
  let fileCount = 0;
  let dirCount = 0;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (isIgnored(dirPath, entry.name)) continue;

      if (entry.isDirectory()) {
        dirCount++;
        const { files, dirs } = countFiles(path.join(dirPath, entry.name));
        fileCount += files;
        dirCount += dirs;
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          fileCount++;
        }
      }
    }
  } catch {}

  return { files: fileCount, dirs: dirCount };
}

export async function codeIndexCommand(projectPath, options = {}) {
  if (!projectPath) {
    projectPath = process.cwd();
  }

  const normalizedPath = path.resolve(projectPath).replace(/\/+$/, "");

  if (!fs.existsSync(normalizedPath)) {
    console.error(`Error: Path does not exist: ${normalizedPath}`);
    process.exit(1);
  }

  if (!fs.statSync(normalizedPath).isDirectory()) {
    console.error(`Error: Path is not a directory: ${normalizedPath}`);
    process.exit(1);
  }

  if (options.watch) {
    console.log(`Indexing: ${normalizedPath}\n`);

    const startTime = Date.now();
    try {
      const response = await axios.post(
        `${BASE_URL}/api/search/index`,
        { paths: [normalizedPath] },
        { timeout: 600_000, maxContentLength: Infinity, maxBodyLength: Infinity }
      );
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const { stats } = response.data;
      console.log(`\n✅ Initial index complete in ${elapsed}s (${stats.totalChunks.toLocaleString()} chunks)`);
    } catch (err) {
      if (err.code === "ECONNREFUSED") {
        console.error(`Error: Cannot connect to code-search server at ${BASE_URL}`);
        console.error("Make sure the code-search server is running:");
        console.error("  cd packages/code-search && pnpm dev");
        process.exit(1);
      }
      console.error(`Initial indexing failed: ${err?.response?.data?.error ?? err.message}`);
      process.exit(1);
    }

    try {
      await axios.post(`${BASE_URL}/api/search/watch/start`, { paths: [normalizedPath] });
      console.log(`\n👀 Watching for changes in: ${normalizedPath}`);
      console.log("   Changed files will be re-indexed automatically.");
      console.log("   Press Ctrl+C to stop.\n");
      process.stdin.resume();
      await new Promise(() => {});
      return;
    } catch (err) {
      if (err.code === "ECONNREFUSED") {
        console.error(`Error: Cannot connect to code-search server at ${BASE_URL}`);
        console.error("Make sure the code-search server is running:");
        console.error("  cd packages/code-search && pnpm dev");
        process.exit(1);
      }
      console.error(`Failed to start watcher: ${err?.response?.data?.error ?? err.message}`);
      process.exit(1);
    }
  }

  console.log(`Scanning: ${normalizedPath}`);
  const { files, dirs } = countFiles(normalizedPath);
  console.log(`Found ${files.toLocaleString()} files in ${dirs.toLocaleString()} directories\n`);

  console.log(`Indexing: ${normalizedPath}`);
  console.log("This may take a few minutes for large codebases...\n");

  const startTime = Date.now();

  try {
    const response = await axios.post(
      `${BASE_URL}/api/search/index`,
      { paths: [normalizedPath] },
      {
        timeout: 600_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const { stats } = response.data;

    console.log(`\n✅ Indexing complete in ${elapsed}s`);
    console.log(`   Files indexed: ${stats.totalFiles.toLocaleString()}`);
    console.log(`   Chunks created: ${stats.totalChunks.toLocaleString()}`);
    console.log(`   Total lines: ${stats.totalLines.toLocaleString()}`);

    if (stats.languages && Object.keys(stats.languages).length > 0) {
      console.log(`   Languages:`);
      for (const [lang, count] of Object.entries(stats.languages).sort((a, b) => b[1] - a[1])) {
        console.log(`     ${lang}: ${count.toLocaleString()} files`);
      }
    }

    console.log(`\nSearch endpoint: POST ${BASE_URL}/api/search/search`);
    console.log(`Example: curl -X POST ${BASE_URL}/api/search/search -H 'Content-Type: application/json' -d '{"query": "your query", "projectPath": "${normalizedPath}"}'`);
  } catch (err) {
    if (err.code === "ECONNREFUSED") {
      console.error(`\n❌ Error: Cannot connect to code-search server at ${BASE_URL}`);
      console.error("\nMake sure the code-search server is running:");
      console.error("  cd packages/code-search && pnpm dev");
      process.exit(1);
    }
    const message = err?.response?.data?.error ?? err?.message ?? "Unknown error";
    console.error(`\n❌ Indexing failed: ${message}`);
    process.exit(1);
  }
}
