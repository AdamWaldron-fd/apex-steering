import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateManifest, encodeState } from "./manifest-bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const PORT = parseInt(process.env.SANDBOX_PORT || "5555");
const MAIN_URL = process.env.MAIN_URL || "http://localhost:4444";
const EDGE_URL = process.env.EDGE_URL || "http://localhost:3077";

// ─── MIME types for media serving ────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".m3u8": "application/vnd.apple.mpegurl",
  ".mpd": "application/dash+xml",
  ".m4s": "video/mp4",
  ".mp4": "video/mp4",
  ".cmfv": "video/mp4",
  ".cmfa": "audio/mp4",
  ".m4a": "audio/mp4",
  ".m4v": "video/mp4",
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".txt": "text/plain",
};

function mimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function serveStaticFile(
  filePath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const stat = fs.statSync(filePath);
  const mime = mimeType(filePath);

  // Range request support for media segments
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Type": mime,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Content-Length": stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  }

  return true;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // ── Static: UI ──────────────────────────────────────────────
    if (url.pathname === "/") {
      const html = fs.readFileSync(
        path.join(PROJECT_ROOT, "ui/index.html"),
        "utf-8",
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
      return;
    }

    // ── Static: UI assets (JS, CSS modules) ─────────────────────
    if (url.pathname.startsWith("/ui/")) {
      const safePath = path.normalize(url.pathname).replace(/^\/+/, "");
      const filePath = path.join(PROJECT_ROOT, safePath);
      if (!filePath.startsWith(path.join(PROJECT_ROOT, "ui"))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": mimeType(filePath) });
        res.end(content);
        return;
      }
    }

    // ── Static: Test content (fake CDN origins) ──────────────────
    if (url.pathname.startsWith("/test/")) {
      const safePath = path.normalize(url.pathname).replace(/^\/+/, "");
      const filePath = path.join(PROJECT_ROOT, safePath);
      // Ensure we stay within the test directory
      if (!filePath.startsWith(path.join(PROJECT_ROOT, "test"))) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      if (serveStaticFile(filePath, req, res)) return;
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

    // Sandbox-specific: hot-swap providers and contracts
    if (url.pathname === "/api/sandbox/providers" && req.method === "POST") {
      const body = await readBody(req);
      const r = await proxyRequest(`${MAIN_URL}/providers`, "POST", body);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
      return;
    }

    if (url.pathname === "/api/sandbox/contracts" && req.method === "POST") {
      const body = await readBody(req);
      const r = await proxyRequest(`${MAIN_URL}/contracts`, "POST", body);
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
    // Match both /api/steer/* (UI requests) and /steer/* (RELOAD-URI from edge).
    // The edge server uses BASE_PATH="/steer" so RELOAD-URIs resolve to /steer?_ss=...
    // HLS.js/dash.js follow these relative URIs against the sandbox origin.
    if (url.pathname.startsWith("/api/steer") || url.pathname.startsWith("/steer")) {
      const edgePath = url.pathname.startsWith("/api/steer")
        ? url.pathname.replace("/api/steer", "/steer")
        : url.pathname;
      const qs = url.search;
      const r = await proxyRequest(`${EDGE_URL}${edgePath}${qs}`, "GET");
      res.writeHead(r.status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache",
        "Access-Control-Allow-Origin": "*",
      });
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
  console.log(`  sandbox ready on :${PORT}`);
});
