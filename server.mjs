#!/usr/bin/env node
/**
 * short — first-party short links for wenfu.dev (https://s.wenfu.dev/).
 * Zero npm deps — Node built-ins only.
 *
 * POST /api          { payload } -> { id, url }
 * GET  /api/:id      { payload }
 * GET  /:id          302 -> MM_ORIGIN/?s=:id
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = process.env.S_HOST || "127.0.0.1";
const PORT = Number(process.env.S_PORT || 8787);
const DOMAIN = (process.env.S_DOMAIN || "s.wenfu.dev").replace(/\/$/, "");
const MM_ORIGIN = (process.env.MM_ORIGIN || "https://mm.wenfu.dev").replace(/\/$/, "");
const DATA_DIR = process.env.S_DATA_DIR || path.join(__dirname, "data");
const MAX_PAYLOAD_BYTES = Number(process.env.S_MAX_PAYLOAD || 512 * 1024);
const ID_LEN = 8;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = Number(process.env.S_RATE_MAX || 30);

const ID_RE = /^[A-Za-z0-9_-]{4,32}$/;
const PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;

const CORS_ORIGINS = new Set(
  String(process.env.S_CORS_ORIGINS || `${MM_ORIGIN},http://localhost:4173,http://127.0.0.1:4173`)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

fs.mkdirSync(DATA_DIR, { recursive: true });

const rateBuckets = new Map();

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimited(ip) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX;
}

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(data);
}

function text(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.has(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };
  }
  return {};
}

function recordPath(id) {
  return path.join(DATA_DIR, `${id}.json`);
}

function readRecord(id) {
  try {
    const raw = fs.readFileSync(recordPath(id), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data.payload !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

function newId() {
  for (let i = 0; i < 8; i++) {
    const id = crypto.randomBytes(6).toString("base64url").slice(0, ID_LEN);
    if (!ID_RE.test(id)) continue;
    if (!fs.existsSync(recordPath(id))) return id;
  }
  throw new Error("无法分配短链 id");
}

function writeRecord(id, payload) {
  const file = recordPath(id);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({
    id,
    payload,
    createdAt: Date.now(),
  });
  fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o644 });
  fs.renameSync(tmp, file);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求体过大"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handlePostApi(req, res) {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    json(res, 429, { error: "请求过于频繁" }, corsHeaders(req));
    return;
  }
  let raw;
  try {
    raw = await readBody(req, MAX_PAYLOAD_BYTES + 2048);
  } catch (error) {
    json(res, error.status || 400, { error: error.message || "读取失败" }, corsHeaders(req));
    return;
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    json(res, 400, { error: "无效的 JSON" }, corsHeaders(req));
    return;
  }
  const payload = body && typeof body.payload === "string" ? body.payload.trim() : "";
  if (!payload || !PAYLOAD_RE.test(payload)) {
    json(res, 400, { error: "无效的 payload" }, corsHeaders(req));
    return;
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    json(res, 413, { error: "payload 过大" }, corsHeaders(req));
    return;
  }
  try {
    const id = newId();
    writeRecord(id, payload);
    json(
      res,
      201,
      { id, url: `https://${DOMAIN}/${id}` },
      corsHeaders(req),
    );
  } catch (error) {
    json(res, 500, { error: error.message || "写入失败" }, corsHeaders(req));
  }
}

function handleGetApi(req, res, id) {
  if (!ID_RE.test(id)) {
    json(res, 400, { error: "无效的 id" }, corsHeaders(req));
    return;
  }
  const record = readRecord(id);
  if (!record) {
    json(res, 404, { error: "未找到" }, corsHeaders(req));
    return;
  }
  json(res, 200, { id, payload: record.payload }, corsHeaders(req));
}

function handleRedirect(res, id) {
  if (!ID_RE.test(id)) {
    text(res, 404, "Not found");
    return;
  }
  const record = readRecord(id);
  if (!record) {
    text(res, 404, "Not found");
    return;
  }
  const location = `${MM_ORIGIN}/?s=${encodeURIComponent(id)}`;
  res.writeHead(302, {
    Location: location,
    "Cache-Control": "no-store",
  });
  res.end();
}

function parseUrl(req) {
  try {
    return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = parseUrl(req);
  if (!url) {
    text(res, 400, "Bad request");
    return;
  }
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS" && (pathname === "/api" || pathname.startsWith("/api/"))) {
    res.writeHead(204, {
      ...corsHeaders(req),
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api") {
    await handlePostApi(req, res);
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/")) {
    handleGetApi(req, res, pathname.slice("/api/".length));
    return;
  }

  if (req.method === "GET" && /^\/[A-Za-z0-9_-]+$/.test(pathname)) {
    handleRedirect(res, pathname.slice(1));
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    text(res, 200, "s.wenfu.dev short links\n");
    return;
  }

  text(res, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[s-wenfu] http://${HOST}:${PORT} domain=${DOMAIN} mm=${MM_ORIGIN} data=${DATA_DIR}`);
});
