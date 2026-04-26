import { startServer } from "./api/server.js";
import { CodeSearchEngine } from "./engine.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnv(envPath: string) {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match?.[1]) continue;
    const key = match[1];
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

const envPath = path.join(__dirname, "..", ".env");
console.log("Loading env from:", envPath);
console.log("File exists:", fs.existsSync(envPath));
loadEnv(envPath);

console.log("VOYAGEAI_API_KEY:", process.env.VOYAGEAI_API_KEY ? "loaded" : "MISSING");
console.log("VOYAGE_API_KEY:", process.env.VOYAGE_API_KEY ? "loaded" : "MISSING");

const engine = new CodeSearchEngine();
await engine.initialize();

console.log("Starting Code Search API server on port 4098...");

const { close } = await startServer({
  engine,
  config: {
    port: 4098,
    host: "localhost",
    cors: true,
  },
});

console.log(`Code Search API running on http://localhost:4098`);
console.log(`  GET  /health`);
console.log(`  POST /api/search/index`);
console.log(`  POST /api/search/search`);
console.log(`  GET  /api/search/stats`);
console.log(`  ...`);

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await close();
  await engine.close();
  process.exit(0);
});
