import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAIN_PORT = process.env.MAIN_PORT ?? "4444";
const EDGE_PORT = process.env.EDGE_PORT ?? "3077";

let mainProc: ChildProcess;
let edgeProc: ChildProcess;

async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

export async function setup(): Promise<void> {
  const root = path.resolve(__dirname, "../..");

  // Start apex-main-steering
  mainProc = spawn("node", ["dist/server.js", "--port", MAIN_PORT], {
    cwd: path.join(root, "../packages/main-steering"),
    env: { ...process.env },
    stdio: "pipe",
  });
  mainProc.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[main-steering] ${msg}`);
  });

  // Start apex-edge-steering
  edgeProc = spawn("node", ["scripts/server.mjs", "--port", EDGE_PORT], {
    cwd: path.join(root, "../crates/edge-steering"),
    env: { ...process.env, PATH: process.env.PATH },
    stdio: "pipe",
  });
  edgeProc.stderr?.on("data", (d: Buffer) => {
    const msg = d.toString().trim();
    if (msg) console.error(`[edge-steering] ${msg}`);
  });

  // Wait for both to be healthy
  console.log("  Waiting for servers...");
  await Promise.all([
    waitForHealth(`http://localhost:${MAIN_PORT}/health`),
    waitForHealth(`http://localhost:${EDGE_PORT}/health`),
  ]);

  // Register edge as fleet member on main-steering
  await fetch(`http://localhost:${MAIN_PORT}/fleet/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      platform: "cloudflare",
      control_url: `http://localhost:${EDGE_PORT}/control`,
      region: "us-east",
    }),
  });

  // Reset edge state to clean baseline
  await fetch(`http://localhost:${EDGE_PORT}/reset`, { method: "POST" });

  console.log(`  Main steering: http://localhost:${MAIN_PORT}`);
  console.log(`  Edge steering: http://localhost:${EDGE_PORT}`);
}

export async function teardown(): Promise<void> {
  mainProc?.kill();
  edgeProc?.kill();
}
