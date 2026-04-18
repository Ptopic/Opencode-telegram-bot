/**
 * project start <path>  — spawn a new OpenCode server instance for a project
 * project stop <path>   — stop the OpenCode server instance for a project
 * project list          — list running instances (alias: opencode-telegram projects list)
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { probeHealth } from "../api-client.js";
import { getProjectRoots } from "../config.js";

const STATE_FILE = path.join(homedir(), ".opencode-telegram-instances.json");
const INSTANCE_PORT_START = 50000;
const INSTANCE_PORT_END = 59999;
const INSTANCE_STARTUP_TIMEOUT_MS = 30_000;

// ── State helpers ──────────────────────────────────────────────────────────────

function readState() {
  if (!existsSync(STATE_FILE)) return { instances: {}, activeSession: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { instances: {}, activeSession: {} };
  }
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn("Failed to save state:", err.message);
  }
}

function findInstanceForPath(state, projectPath) {
  const normalized = projectPath.replace(/\/+$/, "").toLowerCase();
  for (const [p, inst] of Object.entries(state.instances ?? {})) {
    const np = p.replace(/\/+$/, "").toLowerCase();
    if (np !== normalized) continue;
    // Verify the PID is still alive before returning the entry
    if (typeof inst.pid === "number") {
      try {
        process.kill(inst.pid, 0); // signal 0 just checks if process exists
      } catch {
        // Process is dead — treat as no entry
        return null;
      }
    }
    return { projectPath: p, ...inst };
  }
  return null;
}

// ── Port helpers ───────────────────────────────────────────────────────────────

async function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" }, () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function allocatePort(state) {
  const usedPorts = new Set(Object.values(state.instances ?? {}).map((i) => i.port).filter(Boolean));
  for (let port = INSTANCE_PORT_START; port <= INSTANCE_PORT_END; port++) {
    if (usedPorts.has(port)) continue;
    if (!(await isPortInUse(port))) return port;
  }
  throw new Error("No available ports in range");
}

async function waitForPort(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let settled = false;
    let timer = null;

    const cleanup = () => {
      settled = true;
      if (timer) clearTimeout(timer);
    };

    const tryConnect = () => {
      if (settled) return;
      const socket = createConnection({ port, host: "127.0.0.1" }, () => {
        cleanup();
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (settled) return;
        if (Date.now() >= deadline) {
          cleanup();
          reject(new Error(`Port ${port} did not become available within ${timeoutMs}ms`));
        } else {
          timer = setTimeout(tryConnect, 100);
        }
      });
    };

    tryConnect();
  });
}

// ── Instance lifecycle ─────────────────────────────────────────────────────────

function spawnChild(command, args, options) {
  return spawn(command, args, {
    stdio: "ignore",
    env: { ...process.env },
    ...options,
  });
}

async function spawnInstanceForProject(projectDirectory) {
  const state = readState();
  const existing = findInstanceForPath(state, projectDirectory);
  if (existing && existing.status === "ready") {
    const portInUse = await isPortInUse(existing.port);
    if (portInUse) {
      // Port is in use — wait for the HTTP server to actually respond
      console.log(`[spawn] Port ${existing.port} in use — waiting for server to be healthy...`);
      const health = await probeHealth(existing.baseUrl, 30_000);
      if (health.ok) {
        console.log(`[spawn] Server healthy at ${existing.baseUrl}`);
        return { baseUrl: existing.baseUrl, port: existing.port, pid: existing.pid };
      }
      console.log(`[spawn] Server unhealthy after wait: ${health.reason} — will respawn`);
    }
  }
  const port = await allocatePort(state);
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Spawning OpenCode instance for ${projectDirectory} on port ${port}...`);

  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let portFound = false;
    let healthCheckInterval = null;
    let startupTimeout = null;
    let resolved = false;

    const cleanup = () => {
      if (healthCheckInterval) { clearInterval(healthCheckInterval); healthCheckInterval = null; }
      if (startupTimeout) { clearTimeout(startupTimeout); startupTimeout = null; }
    };

    const resolveOnce = (inst) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      state.instances[projectDirectory] = {
        port: inst.port,
        baseUrl: inst.baseUrl,
        status: "ready",
        pid: inst.pid,
        startedAt: Date.now(),
      };
      saveState(state);
      resolve(inst);
    };

    const rejectOnce = (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    };

    startupTimeout = setTimeout(() => {
      if (!resolved) {
        rejectOnce(new Error(`Startup timeout after ${INSTANCE_STARTUP_TIMEOUT_MS}ms`));
      }
    }, INSTANCE_STARTUP_TIMEOUT_MS);

    const child = spawn("opencode", ["serve", "--port", String(port), "--print-logs"], {
      cwd: projectDirectory,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child.unref();

    child.on("error", rejectOnce);
    child.on("exit", (code, signal) => {
      if (!resolved) {
        rejectOnce(new Error(`OpenCode process exited: code=${code}, signal=${signal}\n${stdoutBuffer}\n${stderrBuffer}`));
      }
    });

    child.stdout?.on("data", (data) => {
      stdoutBuffer += data.toString();
      if (!portFound && /opencode server listening on/i.test(stdoutBuffer)) {
        portFound = true;
      }
    });

    child.stderr?.on("data", (data) => {
      stderrBuffer += data.toString();
    });

    healthCheckInterval = setInterval(async () => {
      if (resolved) { cleanup(); return; }
      if (!portFound) {
        if (await isPortInUse(port)) portFound = true;
        return;
      }
      try {
        await waitForPort(port, 2000);
        const health = await probeHealth(baseUrl, 3000);
        if (health.ok) {
          resolveOnce({ baseUrl, port, pid: child.pid });
        }
      } catch {}
    }, 500);
  });
}

async function stopInstanceForProject(projectDirectory) {
  const state = readState();
  const instance = findInstanceForPath(state, projectDirectory);

  if (!instance) {
    console.log(`No running instance found for: ${projectDirectory}`);
    return;
  }

  console.log(`Stopping instance: ${instance.baseUrl} (pid ${instance.pid})`);

  const pid = instance.pid;
  const childPid = pid;

  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(childPid), "/f", "/t"]);
    } else {
      process.kill(-childPid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-childPid, "SIGKILL");
        } catch {}
      }, 2000);
    }
  } catch (err) {
    console.warn(`Kill warning: ${err.message}`);
  }

  // Remove from state
  delete state.instances[projectDirectory];
  saveState(state);
  console.log(`Instance stopped.`);
}

// ── Commands ───────────────────────────────────────────────────────────────────

export async function projectStartCommand(projectPath) {
  if (!projectPath) {
    projectPath = process.cwd();
    console.log(`No path given — using current directory: ${projectPath}`);
  }

  const state = readState();
  const existing = findInstanceForPath(state, projectPath);

  try {
    const instance = await spawnInstanceForProject(projectPath);
    console.log(`Instance ready: ${instance.baseUrl}`);
    console.log(`Project: ${projectPath}`);
    console.log(`PID: ${instance.pid}`);
  } catch (err) {
    console.error(`Failed to start instance: ${err.message}`);
    process.exit(1);
  }
}

export async function projectStopCommand(projectPath) {
  if (!projectPath) {
    projectPath = process.cwd();
    console.log(`No path given — using current directory: ${projectPath}`);
  }

  try {
    await stopInstanceForProject(projectPath);
  } catch (err) {
    console.error(`Failed to stop instance: ${err.message}`);
    process.exit(1);
  }
}

export async function projectListCommand() {
  const state = readState();
  const roots = getProjectRoots();

  console.log("=== Running Instances ===");
  const running = Object.entries(state.instances ?? {});
  if (running.length === 0) {
    console.log("No running instances.");
  }

  for (const [projectPath, instance] of running) {
    if (!instance?.baseUrl) continue;
    const health = await probeHealth(instance.baseUrl, 2000).catch(() => ({ ok: false }));
    const status = health.ok ? `● ${instance.baseUrl}` : `✗ ${health.reason ?? "unhealthy"}`;
    console.log(`  ${status}  ${projectPath}`);
  }

  console.log("\n=== Project Roots ===");
  for (const root of roots) {
    console.log(`  ${root.label} (${root.scope}): ${root.path}`);
  }
}
