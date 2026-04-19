/**
 * project start <path>  — spawn a new OpenCode server instance for a project
 * project stop <path>   — stop the OpenCode server instance for a project
 * project list          — list running instances (alias: opencode-telegram projects list)
 */
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { probeHealth } from "../api-client.js";
import { getProjectRoots } from "../config.js";
import {
  deleteInstance,
  getInstance,
  listInstances,
  updateInstanceStatus,
  upsertInstance,
} from "../db.js";

const INSTANCE_PORT_START = 50000;
const INSTANCE_PORT_END = 59999;
const INSTANCE_STARTUP_TIMEOUT_MS = 30_000;

// ── Instance helpers ───────────────────────────────────────────────────────────

function findInstanceForPath(projectPath) {
  const normalized = projectPath.replace(/\/+$/, "").toLowerCase();
  const inst = getInstance(normalized);
  if (!inst) return null;

  // Verify the PID is still alive before returning the entry
  if (typeof inst.pid === "number") {
    try {
      process.kill(inst.pid, 0); // signal 0 just checks if process exists
    } catch {
      // Process is dead — treat as no entry
      return null;
    }
  }
  return {
    projectPath: inst.project_path,
    baseUrl: inst.base_url,
    port: inst.port,
    pid: inst.pid,
    status: inst.status,
    startedAt: inst.started_at,
  };
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

async function allocatePort() {
  const allInstances = listInstances();
  const usedPorts = new Set(allInstances.map((i) => i.port).filter(Boolean));
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

async function spawnInstanceForProject(projectDirectory) {
  const existing = findInstanceForPath(projectDirectory);
  if (existing && existing.status === "ready") {
    const portInUse = await isPortInUse(existing.port);
    if (portInUse) {
      // Port is bound — check PID and health
      let pidAlive = false;
      if (typeof existing.pid === "number") {
        try { process.kill(existing.pid, 0); pidAlive = true; } catch { pidAlive = false; }
      }
      if (pidAlive) {
        // PID alive, port in use — wait for HTTP server to respond
        console.log(`[spawn] PID ${existing.pid} alive, port ${existing.port} in use — waiting for server...`);
        const health = await probeHealth(existing.baseUrl, 30_000);
        if (health.ok) {
          console.log(`[spawn] Server healthy at ${existing.baseUrl}`);
          return { baseUrl: existing.baseUrl, port: existing.port, pid: existing.pid };
        }
        console.log(`[spawn] Server unhealthy after wait: ${health.reason} — PID alive but server not responding, killing it`);
        try { process.kill(existing.pid, "SIGTERM"); } catch {}
        await new Promise((r) => setTimeout(r, 1000));
        try { process.kill(existing.pid, "SIGKILL"); } catch {}
      } else {
        console.log(`[spawn] PID ${existing.pid} is dead — cleaning up stale entry`);
      }
      // Clean up stale instance and proceed to respawn
      deleteInstance(projectDirectory);
    }
  }

  const port = await allocatePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`Spawning OpenCode instance for ${projectDirectory} on port ${port}...`);

  // Create initial instance entry with 'starting' status
  upsertInstance({
    projectPath: projectDirectory,
    baseUrl,
    port,
    pid: null,
    status: "starting",
  });

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
      upsertInstance({
        projectPath: projectDirectory,
        baseUrl: inst.baseUrl,
        port: inst.port,
        pid: inst.pid,
        status: "ready",
      });
      resolve(inst);
    };

    const rejectOnce = (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      updateInstanceStatus(projectDirectory, "failed");
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
  const instance = findInstanceForPath(projectDirectory);

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

  deleteInstance(projectDirectory);
  console.log(`Instance stopped.`);
}

// ── Commands ───────────────────────────────────────────────────────────────────

export async function projectStartCommand(projectPath) {
  if (!projectPath) {
    projectPath = process.cwd();
    console.log(`No path given — using current directory: ${projectPath}`);
  }

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
  const roots = getProjectRoots();

  console.log("=== Running Instances ===");
  const running = listInstances();
  if (running.length === 0) {
    console.log("No running instances.");
  }

  for (const inst of running) {
    if (!inst?.base_url) continue;
    const health = await probeHealth(inst.base_url, 2000).catch(() => ({ ok: false }));
    const status = health.ok ? `● ${inst.base_url}` : `✗ ${health.reason ?? "unhealthy"}`;
    console.log(`  ${status}  ${inst.project_path}`);
  }

  console.log("\n=== Project Roots ===");
  for (const root of roots) {
    console.log(`  ${root.label} (${root.scope}): ${root.path}`);
  }
}