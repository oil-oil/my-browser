import http from "node:http";
import { randomUUID } from "node:crypto";

const host = "127.0.0.1";
const port = 17654;
const queue = [];
const results = new Map();
let lastClientSeenAt = null;
let lastClientId = null;
let lastCommandQueuedAt = null;
let lastResultReceivedAt = null;

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function send(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  });
  res.end(JSON.stringify(payload, null, 2));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 200, { ok: true });
    return;
  }

  const url = new URL(req.url, `http://${host}:${port}`);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      send(res, 200, {
        ok: true,
        queue: queue.length,
        results: results.size,
        lastClientId,
        lastClientSeenAt,
        lastCommandQueuedAt,
        lastResultReceivedAt
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/next") {
      lastClientId = url.searchParams.get("clientId");
      lastClientSeenAt = new Date().toISOString();
      send(res, 200, queue.shift() ?? null);
      return;
    }

    if (req.method === "POST" && url.pathname === "/command") {
      const command = await readJson(req);
      const id = command.id || randomUUID();
      const saved = { id, ...command };
      queue.push(saved);
      results.set(id, { pending: true, id });
      lastCommandQueuedAt = new Date().toISOString();
      send(res, 200, saved);
      return;
    }

    if (req.method === "POST" && url.pathname === "/result") {
      const result = await readJson(req);
      lastResultReceivedAt = new Date().toISOString();
      results.set(result.id, { pending: false, receivedAt: lastResultReceivedAt, ...result });
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/clear") {
      const body = await readJson(req);
      const cleared = { queue: queue.length, results: results.size };
      if (body.queue !== false) queue.splice(0);
      if (body.results !== false) results.clear();
      send(res, 200, { ok: true, cleared });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/result/")) {
      const id = decodeURIComponent(url.pathname.slice("/result/".length));
      send(res, 200, results.get(id) ?? null);
      return;
    }

    send(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    send(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
});

server.listen(port, host, () => {
  console.log(`Local Browser Operator agent listening at http://${host}:${port}`);
});
