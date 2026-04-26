import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..", "..");

export function mcpCommand() {
  const mcpServerPackage = path.resolve(repoRoot, "packages", "mcp-server");

  const codeSearchEntry = {
    "code-search": {
      type: "local",
      command: ["node", path.join(mcpServerPackage, "dist", "index.js")],
      environment: {
        CODE_SEARCH_API_URL: "http://localhost:4098",
      },
      enabled: true,
    },
  };

  console.log(JSON.stringify(codeSearchEntry, null, 2));
}
