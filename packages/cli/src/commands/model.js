import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(__filename, "../../../../..");
const CONFIG_MJS_PATH = path.join(REPO_ROOT, "--help/config.mjs");

const FAVORITE_MODELS = [
  { id: "synthetic/hf:zai-org/GLM-5.1",             label: "GLM 5.1",               tier: "smart" },
  { id: "openai/gpt-5.5",                            label: "GPT-5.5",                tier: "smart" },
  { id: "openai/gpt-5.4",                            label: "GPT-5.4",                tier: "smart" },
  { id: "synthetic/hf:zai-org/GLM-5",               label: "GLM 5",                  tier: "smart" },
  { id: "openai/gpt-5.3-codex",                      label: "GPT-5.3 Codex",         tier: "smart" },
  { id: "synthetic/hf:zai-org/GLM-4.7",             label: "GLM 4.7",                tier: "smart" },
  { id: "minimax-coding-plan/MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", tier: "normal" },
  { id: "openai/gpt-5.4-fast",                       label: "GPT-5.4 Fast",           tier: "normal" },
  { id: "openai/gpt-5.3-codex-spark",                label: "GPT-5.3 Codex Spark",   tier: "normal" },
  { id: "synthetic/hf:zai-org/GLM-4.7-Flash",       label: "GLM 4.7 Flash",          tier: "normal" },
];

async function loadConfigMjs() {
  const configUrl = "file://" + CONFIG_MJS_PATH.replace(/\\/g, "/");
  const mod = await import(configUrl);
  return {
    models: mod.models || {},
    smartAgents: mod.smartAgents || [],
    normalAgents: mod.normalAgents || [],
    smartCategories: mod.smartCategories || [],
    normalCategories: mod.normalCategories || [],
  };
}

function writeModelToConfig(tier, modelId) {
  const raw = readFileSync(CONFIG_MJS_PATH, "utf8");

  // Find the current models export to preserve the other tier's value
  const modelsRegex = /export\s+const\s+models\s*=\s*\{([\s\S]*?)\}/;
  const match = raw.match(modelsRegex);
  if (!match) {
    console.error("Could not find `export const models = {...}` in config.mjs");
    process.exit(1);
  }

  const otherKey = tier === "smart" ? "normal" : "smart";
  const otherMatch = match[1].match(new RegExp(`${otherKey}:\\s*"([^"]*?)"`));
  const otherValue = otherMatch ? otherMatch[1] : "";

  const newBlock = `export const models = {\n  smart: "${tier === "smart" ? modelId : otherValue}",\n  normal: "${tier === "normal" ? modelId : otherValue}",\n}`;
  const updated = raw.replace(match[0], newBlock);
  writeFileSync(CONFIG_MJS_PATH, updated);
}

async function pickModel(tier) {
  const models = FAVORITE_MODELS.filter((m) => m.tier === tier);

  console.log(`\n  Available ${tier.toUpperCase()} models:\n`);
  models.forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.label}`);
    console.log(`     id: ${m.id}`);
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise((resolve) => {
    rl.question(`\n  Select model (1-${models.length}) or type a model ID: `, resolve);
  });
  rl.close();

  const trimmed = answer.trim();
  if (!trimmed) {
    console.error("No selection made. Aborting.");
    process.exit(1);
  }

  const num = parseInt(trimmed, 10);
  if (!isNaN(num) && num >= 1 && num <= models.length) {
    return models[num - 1].id;
  }

  return trimmed;
}

export async function modelSetSmarterCommand(modelId) {
  const newModel = modelId || (await pickModel("smart"));

  writeModelToConfig("smart", newModel);

  const config = await loadConfigMjs();

  console.log(`\n  SMART model set to: ${newModel}`);
  console.log(`\n  Agents:    ${config.smartAgents.join(", ")}`);
  console.log(`  Categories: ${config.smartCategories.join(", ")}`);
  console.log(`\n  Config: ${CONFIG_MJS_PATH}`);
  console.log(`\n  Apply to project:  opencode-telegram prompt <project-path>`);
}

export async function modelSetNormalCommand(modelId) {
  const newModel = modelId || (await pickModel("normal"));

  writeModelToConfig("normal", newModel);

  const config = await loadConfigMjs();

  console.log(`\n  NORMAL model set to: ${newModel}`);
  console.log(`\n  Agents:    ${config.normalAgents.join(", ")}`);
  console.log(`  Categories: ${config.normalCategories.join(", ")}`);
  console.log(`\n  Config: ${CONFIG_MJS_PATH}`);
  console.log(`\n  Apply to project:  opencode-telegram prompt <project-path>`);
}

export async function modelListCommand() {
  const config = await loadConfigMjs();

  console.log("\n  Current model assignments:\n");

  console.log(`  SMART  model: ${config.models.smart || "(not set)"}`);
  console.log(`    Agents:    ${config.smartAgents.join(", ")}`);
  console.log(`    Categories: ${config.smartCategories.join(", ")}`);

  console.log(`\n  NORMAL model: ${config.models.normal || "(not set)"}`);
  console.log(`    Agents:    ${config.normalAgents.join(", ")}`);
  console.log(`    Categories: ${config.normalCategories.join(", ")}`);

  console.log(`\n  Config: ${CONFIG_MJS_PATH}`);
  console.log(`  Apply:  opencode-telegram prompt <project-path>\n`);
}

export async function modelCommand(sub, modelId) {
  if (!sub || sub === "list") {
    return modelListCommand();
  }

  if (sub === "set") {
    const setIdx = process.argv.indexOf("set");
    const targetTier = process.argv[setIdx + 1];
    const targetModelId = process.argv[setIdx + 2];

    if (targetTier === "smarter") {
      return modelSetSmarterCommand(targetModelId);
    }
    if (targetTier === "normal") {
      return modelSetNormalCommand(targetModelId);
    }

    console.error("Usage: opencode-telegram model set <smarter|normal> [model-id]");
    console.error("       opencode-telegram model list");
    process.exit(1);
  }

  if (sub === "smarter") {
    return modelSetSmarterCommand(modelId);
  }
  if (sub === "normal") {
    return modelSetNormalCommand(modelId);
  }

  console.error("Usage: opencode-telegram model <list|set> [smarter|normal] [model-id]");
  console.error("       opencode-telegram model smarter [model-id]");
  console.error("       opencode-telegram model normal [model-id]");
  process.exit(1);
}
