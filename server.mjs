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
const DATA_DIR = path.resolve(process.env.S_DATA_DIR || path.join(__dirname, "data"));
const MAX_PAYLOAD_BYTES = Number(process.env.S_MAX_PAYLOAD || 512 * 1024);
const ID_LEN = 8;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_WRITE = Number(process.env.S_RATE_MAX || 30);
const RATE_MAX_READ = Number(process.env.S_RATE_MAX_READ || 120);
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.S_TRUST_PROXY || ""));

const ID_RE = /^[A-Za-z0-9_-]{4,32}$/;
const PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const ORIGIN_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?$/;

const CORS_ORIGINS = new Set(
  String(process.env.S_CORS_ORIGINS || `${MM_ORIGIN},http://localhost:4173,http://127.0.0.1:4173`)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (!ORIGIN_RE.test(MM_ORIGIN) && !/^http:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/.test(MM_ORIGIN)) {
  console.error(`[s-wenfu] invalid MM_ORIGIN: ${MM_ORIGIN}`);
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

const rateBuckets = new Map();

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

function clientIp(req) {
  if (TRUST_PROXY) {
    // Prefer nginx X-Real-IP ($remote_addr). Never take the first XFF hop —
    // clients can spoof it when nginx uses $proxy_add_x_forwarded_for.
    const realIp = req.headers["x-real-ip"];
    if (typeof realIp === "string" && realIp.trim()) {
      return realIp.trim();
    }
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      const parts = forwarded.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimited(ip, kind, max) {
  const key = `${ip}:${kind}`;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count > max;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.start >= RATE_WINDOW_MS * 2) rateBuckets.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

function json(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(data);
}

function text(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
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
  const file = path.resolve(DATA_DIR, `${id}.json`);
  if (!file.startsWith(`${DATA_DIR}${path.sep}`)) {
    throw new Error("invalid path");
  }
  return file;
}

function readRecord(id) {
  try {
    const raw = fs.readFileSync(recordPath(id), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data.payload !== "string") return null;
    if (!PAYLOAD_RE.test(data.payload)) return null;
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
  fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
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
  if (rateLimited(ip, "w", RATE_MAX_WRITE)) {
    json(res, 429, { error: "请求过于频繁" }, corsHeaders(req));
    return;
  }
  const contentType = String(req.headers["content-type"] || "");
  if (contentType && !contentType.toLowerCase().startsWith("application/json")) {
    json(res, 415, { error: "需要 application/json" }, corsHeaders(req));
    return;
  }
  let raw;
  try {
    raw = await readBody(req, MAX_PAYLOAD_BYTES + 2048);
  } catch (error) {
    const status = error.status || 400;
    json(res, status, { error: status === 413 ? "请求体过大" : "读取失败" }, corsHeaders(req));
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
    console.error("[s-wenfu] write failed:", error);
    json(res, 500, { error: "写入失败" }, corsHeaders(req));
  }
}

function handleGetApi(req, res, id) {
  if (rateLimited(clientIp(req), "r", RATE_MAX_READ)) {
    json(res, 429, { error: "请求过于频繁" }, corsHeaders(req));
    return;
  }
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

function handleRedirect(req, res, id) {
  if (rateLimited(clientIp(req), "r", RATE_MAX_READ)) {
    text(res, 429, "Too many requests");
    return;
  }
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
    ...SECURITY_HEADERS,
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
      ...SECURITY_HEADERS,
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
    handleRedirect(req, res, pathname.slice(1));
    return;
  }

  if (req.method === "GET" && pathname === "/") {
    text(res, 200, "s.wenfu.dev short links\n");
    return;
  }

  text(res, 404, "Not found");
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 50;

server.listen(PORT, HOST, () => {
  console.log(
    `[s-wenfu] http://${HOST}:${PORT} domain=${DOMAIN} mm=${MM_ORIGIN} data=${DATA_DIR} trustProxy=${TRUST_PROXY}`,
  );
});
