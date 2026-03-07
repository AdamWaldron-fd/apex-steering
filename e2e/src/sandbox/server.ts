import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateManifest, encodeState } from "./manifest-bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SANDBOX_PORT || "5555");
const MAIN_URL = process.env.MAIN_URL || "http://localhost:4444";
const EDGE_URL = process.env.EDGE_URL || "http://localhost:3077";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c));
    req.on("end", () => resolve(data));
  });
}

async function proxyRequest(
  targetUrl: string,
  method: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  const resp = await fetch(targetUrl, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body || undefined,
  });
  return { status: resp.status, body: await resp.text() };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ── Static: UI ──────────────────────────────────────────────
    if (url.pathname === "/") {
      const html = fs.readFileSync(
        path.join(__dirname, "../../../ui/index.html"),
        "utf-8",
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    // ── Static: Fixtures ────────────────────────────────────────
    if (url.pathname.startsWith("/fixtures/")) {
      const file = path.join(
        __dirname,
        "../../fixtures",
        url.pathname.replace("/fixtures/", ""),
      );
      if (fs.existsSync(file)) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(fs.readFileSync(file, "utf-8"));
        return;
      }
    }

    // ── Manifest updater bridge ─────────────────────────────────
    if (url.pathname === "/api/manifest" && req.method === "POST") {
      const { manifest, request_json } = JSON.parse(await readBody(req));
      const reqJson =
        typeof request_json === "string"
          ? request_json
          : JSON.stringify(request_json);
      const result = updateManifest(manifest, reqJson);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(result);
      return;
    }

    if (url.pathname === "/api/encode-state" && req.method === "POST") {
      const body = await readBody(req);
      const result = encodeState(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ encoded: result }));
      return;
    }

    // ── Proxy: main-steering ────────────────────────────────────
    if (url.pathname === "/api/session/init") {
      const qs = url.search;
      const r = await proxyRequest(
        `${MAIN_URL}/session/init${qs}`,
        "GET",
      );
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
      return;
    }

    if (
      url.pathname.match(
        /^\/api\/(priorities|exclude|clear|status|fleet)/,
      )
    ) {
      const endpoint = url.pathname.replace("/api/", "");
      const body =
        req.method === "POST" ? await readBody(req) : undefined;
      const r = await proxyRequest(
        `${MAIN_URL}/${endpoint}`,
        req.method || "GET",
        body,
      );
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
      return;
    }

    // ── Proxy: edge-steering ────────────────────────────────────
    if (url.pathname === "/api/steer") {
      const qs = url.search;
      const r = await proxyRequest(`${EDGE_URL}/steer${qs}`, "GET");
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
      return;
    }

    if (url.pathname === "/api/edge/control" && req.method === "POST") {
      const body = await readBody(req);
      const r = await proxyRequest(`${EDGE_URL}/control`, "POST", body);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
      return;
    }

    if (url.pathname === "/api/edge/reset" && req.method === "POST") {
      const r = await proxyRequest(`${EDGE_URL}/reset`, "POST", "{}");
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
      return;
    }

    // ── Health aggregation ──────────────────────────────────────
    if (url.pathname === "/api/health") {
      const [mainHealth, edgeHealth] = await Promise.allSettled([
        fetch(`${MAIN_URL}/health`).then((r) => r.ok),
        fetch(`${EDGE_URL}/health`).then((r) => r.ok),
      ]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          main_steering:
            mainHealth.status === "fulfilled" && mainHealth.value,
          edge_steering:
            edgeHealth.status === "fulfilled" && edgeHealth.value,
        }),
      );
      return;
    }

    // ── 404 ─────────────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
});

server.listen(PORT, () => {
  console.log(`\napex-steering-test sandbox: http://localhost:${PORT}`);
  console.log(`  Main steering: ${MAIN_URL}`);
  console.log(`  Edge steering: ${EDGE_URL}\n`);
});
