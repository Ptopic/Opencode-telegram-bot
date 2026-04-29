import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../--help/.opencode");

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfig(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) {
    return structuredClone(source);
  }
  const merged = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeConfig(merged[key], value);
    } else {
      merged[key] = structuredClone(value);
    }
  }
  return merged;
}

export function promptCommand(targetPath) {
  const projectPath = targetPath || process.cwd();
  console.log(`Setting up OpenCode prompt config for: ${projectPath}`);
  const opencodeDir = path.join(projectPath, ".opencode");

  try {
    mkdirSync(opencodeDir, { recursive: true });
    cpSync(SOURCE_DIR, opencodeDir, { recursive: true, overwrite: true });

    const opencodeJsonPath = path.join(opencodeDir, "opencode.json");
    const sourceConfig = JSON.parse(readFileSync(path.join(SOURCE_DIR, "opencode.json"), "utf8"));
    const existingConfig = existsSync(opencodeJsonPath) ? JSON.parse(readFileSync(opencodeJsonPath, "utf8")) : null;
    const nextConfig = existingConfig ? mergeConfig(existingConfig, sourceConfig) : sourceConfig;
    writeFileSync(opencodeJsonPath, JSON.stringify(nextConfig, null, 2));
    console.log(`${existingConfig ? "Updated" : "Created"}: ${opencodeJsonPath}`);
    console.log(`${existingConfig ? "Updated" : "Created"}: ${opencodeDir}/ (full directory)`);

    console.log("\nDone! The project .opencode config has been updated.");
    console.log("\nTo use:");
    console.log(`  cd ${projectPath}`);
    console.log("  opencode");
    console.log("\nThe agent will now use code-search instead of grep for code queries.");
  } catch (err) {
    console.error(`Failed to set up .opencode folder: ${err.message}`);
    process.exit(1);
  }
}
