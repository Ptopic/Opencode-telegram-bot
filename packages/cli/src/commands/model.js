/**
 * model set smarter|normal [model-id]
 *
 * Switch the "smart" (GLM 5.1) or "normal" (MiniMax M2.7) model in
 * --help/.opencode/oh-my-openagent.jsonc. After changing, run
 * `opencode-telegram prompts <project>` to apply the config to a project.
 *
 * - `model set smarter`  — list favorite models, pick one, update SMART agents/categories
 * - `model set normal`   — list favorite models, pick one, update NORMAL agents/categories
 * - `model set smarter <model-id>` — skip interactive picker, set directly
 * - `model list`         — show current smart & normal model assignments
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(__filename, "../../../../..");
const HELP_OPENAGENT_PATH = path.join(REPO_ROOT, "--help/.opencode/oh-my-openagent.jsonc");

const SMART_AGENTS = ["sisyphus", "oracle", "metis", "momus", "prometheus", "hephaestus"];
const NORMAL_AGENTS = ["ultrawork", "explore", "general", "librarian", "atlas", "sisyphus-junior", "multimodal-looker"];

const SMART_CATEGORIES = ["visual-engineering", "ultrabrain", "deep", "artistry", "unspecified-high"];
const NORMAL_CATEGORIES = ["quick", "unspecified-low", "writing"];

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

function stripJsoncComments(text) {
  let result = "";
  let inString = false;
  let stringChar = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      result += ch;
      if (ch === stringChar && text[i - 1] !== "\\") {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) result += text[i];
      continue;
    }

    result += ch;
  }
  return result;
}

function stripTrailingCommas(text) {
  let result = "";
  let inString = false;
  let stringChar = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      result += ch;
      if (ch === stringChar && text[i - 1] !== "\\") {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      continue;
    }
    result += ch;
  }
  return result.replace(/,\s*([\]}])/g, "$1");
}

function parseJsonc(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const stripped = stripJsoncComments(raw);
  const noTrailing = stripTrailingCommas(stripped);
  return JSON.parse(noTrailing);
}

function readOpenagentConfig() {
  if (!existsSync(HELP_OPENAGENT_PATH)) {
    console.error(`Config not found: ${HELP_OPENAGENT_PATH}`);
    process.exit(1);
  }
  return parseJsonc(HELP_OPENAGENT_PATH);
}

function writeOpenagentConfig(config) {
  const raw = readFileSync(HELP_OPENAGENT_PATH, "utf8");
  const updated = applyModelChangesToRaw(raw, config);
  writeFileSync(HELP_OPENAGENT_PATH, updated);
}

/**
 * Given the raw JSONC text and a parsed+modified config, apply model changes
 * by doing targeted string replacements for each model field.
 */
function applyModelChangesToRaw(rawText, newConfig) {
  let result = rawText;

  for (const [agentName, agentConfig] of Object.entries(newConfig.agents || {})) {
    if (agentConfig?.model) {
      const agentPattern = new RegExp(
        `("${agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\{[^}]*?"model"\\s*:\\s*")([^"]*?)(")`,
        "s"
      );
      const match = result.match(agentPattern);
      if (match) {
        result = result.replace(match[0], match[1] + agentConfig.model + match[3]);
      }
    }
  }

  for (const [catName, catConfig] of Object.entries(newConfig.categories || {})) {
    if (catConfig?.model) {
      const catPattern = new RegExp(
        `("${catName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*\\{[^}]*?"model"\\s*:\\s*")([^"]*?)(")`,
        "s"
      );
      const match = result.match(catPattern);
      if (match) {
        result = result.replace(match[0], match[1] + catConfig.model + match[3]);
      }
    }
  }

  return result;
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

  const config = readOpenagentConfig();

  for (const agentName of SMART_AGENTS) {
    if (config.agents?.[agentName]) {
      config.agents[agentName].model = newModel;
    }
  }

  for (const catName of SMART_CATEGORIES) {
    if (config.categories?.[catName]) {
      config.categories[catName].model = newModel;
    }
  }

  writeOpenagentConfig(config);

  console.log(`\n  SMART model set to: ${newModel}`);
  console.log(`\n  Updated agents:    ${SMART_AGENTS.join(", ")}`);
  console.log(`  Updated categories: ${SMART_CATEGORIES.join(", ")}`);
  console.log(`\n  Config: ${HELP_OPENAGENT_PATH}`);
  console.log(`\n  Apply to project:  opencode-telegram prompts <project-path>`);
}

export async function modelSetNormalCommand(modelId) {
  const newModel = modelId || (await pickModel("normal"));

  const config = readOpenagentConfig();

  for (const agentName of NORMAL_AGENTS) {
    if (config.agents?.[agentName]) {
      config.agents[agentName].model = newModel;
    }
  }

  for (const catName of NORMAL_CATEGORIES) {
    if (config.categories?.[catName]) {
      config.categories[catName].model = newModel;
    }
  }

  writeOpenagentConfig(config);

  console.log(`\n  NORMAL model set to: ${newModel}`);
  console.log(`\n  Updated agents:    ${NORMAL_AGENTS.join(", ")}`);
  console.log(`  Updated categories: ${NORMAL_CATEGORIES.join(", ")}`);
  console.log(`\n  Config: ${HELP_OPENAGENT_PATH}`);
  console.log(`\n  Apply to project:  opencode-telegram prompts <project-path>`);
}

export async function modelListCommand() {
  const config = readOpenagentConfig();

  console.log("\n  Current model assignments:\n");

  const smartModel = config.agents?.sisyphus?.model || "(not set)";
  const normalModel = config.agents?.explore?.model || "(not set)";

  console.log(`  SMART  model: ${smartModel}`);
  console.log(`    Agents:    ${SMART_AGENTS.join(", ")}`);
  console.log(`    Categories: ${SMART_CATEGORIES.join(", ")}`);

  console.log(`\n  NORMAL model: ${normalModel}`);
  console.log(`    Agents:    ${NORMAL_AGENTS.join(", ")}`);
  console.log(`    Categories: ${NORMAL_CATEGORIES.join(", ")}`);

  console.log("\n  Per-agent overrides:");
  for (const [name, cfg] of Object.entries(config.agents || {})) {
    if (cfg?.model) {
      const tier = SMART_AGENTS.includes(name) ? "SMART" : NORMAL_AGENTS.includes(name) ? "NORMAL" : "?";
      console.log(`    ${tier.padEnd(6)} ${name.padEnd(20)} ${cfg.model}`);
    }
  }

  console.log("\n  Per-category overrides:");
  for (const [name, cfg] of Object.entries(config.categories || {})) {
    if (cfg?.model) {
      const tier = SMART_CATEGORIES.includes(name) ? "SMART" : NORMAL_CATEGORIES.includes(name) ? "NORMAL" : "?";
      console.log(`    ${tier.padEnd(6)} ${name.padEnd(20)} ${cfg.model}`);
    }
  }

  console.log(`\n  Config: ${HELP_OPENAGENT_PATH}`);
  console.log(`  Apply:  opencode-telegram prompts <project-path>\n`);
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
