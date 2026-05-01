import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SOURCE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../--help/.opencode");
const CONFIG_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../--help/config.mjs");

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

function stripJsoncComments(text) {
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j++;
        j++;
      }
      result += text.slice(i, j + 1);
      i = j + 1;
    } else if (text[i] === "/" && text[i + 1] === "/") {
      let j = i + 2;
      while (j < text.length && text[j] !== "\n") j++;
      i = j;
    } else if (text[i] === "/" && text[i + 1] === "*") {
      let j = i + 2;
      while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
      i = j + 2;
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}

function parseJsonc(text) {
  const stripped = stripJsoncComments(text);
  const noTrailing = stripped.replace(/,\s*([\]}])/g, "$1");
  return JSON.parse(noTrailing);
}

async function loadConfig() {
  const configUrl = "file://" + CONFIG_JS_PATH.replace(/\\/g, "/");
  const mod = await import(configUrl);
  return {
    deniedTools: mod.deniedTools || [],
    bashRules: mod.bashRules || {},
    agentSkills: mod.agentSkills || {},
    agentPrompts: mod.agentPrompts || {},
    models: mod.models || {},
    smartAgents: mod.smartAgents || [],
    normalAgents: mod.normalAgents || [],
    smartCategories: mod.smartCategories || [],
    normalCategories: mod.normalCategories || [],
  };
}

function applyConfigToJsonc(data, config) {
  const deniedToolEntries = Object.fromEntries(
    config.deniedTools.map((tool) => [tool, false])
  );
  const deniedPermEntries = Object.fromEntries(
    config.deniedTools.map((tool) => [tool, "deny"])
  );
  
  data.tools = { ...data.tools, ...deniedToolEntries };
  data.permission = {
    ...data.permission,
    ...deniedPermEntries,
    bash: config.bashRules,
  };

  if (data.agents) {
    for (const [agentName, agentConfig] of Object.entries(data.agents)) {
      agentConfig.tools = {
        ...agentConfig.tools,
        ...deniedToolEntries,
      };

      agentConfig.permission = {
        ...agentConfig.permission,
        ...deniedPermEntries,
        bash: config.bashRules,
      };

      if (config.agentPrompts[agentName]) {
        agentConfig.prompt_append = config.agentPrompts[agentName];
      }

      if (agentName in config.agentSkills) {
        agentConfig.skills = config.agentSkills[agentName];
      } else if ("skills" in agentConfig) {
        delete agentConfig.skills;
      }

      if (config.smartAgents.includes(agentName)) {
        agentConfig.model = config.models.smart;
      } else if (config.normalAgents.includes(agentName)) {
        agentConfig.model = config.models.normal;
      }
    }
  }

  if (data.categories) {
    for (const [catName, catConfig] of Object.entries(data.categories)) {
      if (config.smartCategories.includes(catName)) {
        catConfig.model = config.models.smart;
      } else if (config.normalCategories.includes(catName)) {
        catConfig.model = config.models.normal;
      }
    }
  }

  return data;
}

export async function promptCommand(targetPath) {
  const projectPath = targetPath || process.cwd();
  console.log(`Setting up OpenCode prompt config for: ${projectPath}`);
  const opencodeDir = path.join(projectPath, ".opencode");

  try {
    mkdirSync(opencodeDir, { recursive: true });
    cpSync(SOURCE_DIR, opencodeDir, { recursive: true, overwrite: true });
    const config = await loadConfig();

    const opencodeJsonPath = path.join(opencodeDir, "opencode.json");
    const sourceConfig = JSON.parse(readFileSync(path.join(SOURCE_DIR, "opencode.json"), "utf8"));
    const existingConfig = existsSync(opencodeJsonPath) ? JSON.parse(readFileSync(opencodeJsonPath, "utf8")) : null;
    const nextConfig = existingConfig ? mergeConfig(existingConfig, sourceConfig) : sourceConfig;
    nextConfig.permission = {
      ...nextConfig.permission,
      ...Object.fromEntries(config.deniedTools.map((tool) => [tool, "deny"])),
      bash: config.bashRules,
    };
    writeFileSync(opencodeJsonPath, JSON.stringify(nextConfig, null, 2));
    console.log(`${existingConfig ? "Updated" : "Created"}: ${opencodeJsonPath}`);
    console.log(`${existingConfig ? "Updated" : "Created"}: ${opencodeDir}/ (full directory)`);

    // ── Merge config.mjs into oh-my-openagent.jsonc ──────────────────────
    const agentJsoncPath = path.join(opencodeDir, "oh-my-openagent.jsonc");
    if (existsSync(agentJsoncPath)) {
      const raw = readFileSync(agentJsoncPath, "utf8");
      const data = parseJsonc(raw);
      applyConfigToJsonc(data, config);
      writeFileSync(agentJsoncPath, JSON.stringify(data, null, 2));
      console.log(`Merged config.mjs → ${agentJsoncPath}`);
      console.log(`  models:       smart=${config.models.smart}, normal=${config.models.normal}`);
      console.log(`  deniedTools:  [${config.deniedTools.join(", ")}]`);
      console.log(`  bashRules:    ${JSON.stringify(config.bashRules)}`);
      console.log(`  agentSkills:  ${Object.entries(config.agentSkills).map(([k, v]) => `${k}: [${v.join(", ")}]`).join(", ")}`);
      console.log(`  agentPrompts: [${Object.keys(config.agentPrompts).join(", ")}]`);
    }

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
