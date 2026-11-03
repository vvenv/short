import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(root, "..", "server.mjs");

async function waitForHealth(base, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("server did not become healthy");
}

test("short server create, fetch, and redirect", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "short-test-"));
  const port = 18787 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      S_HOST: "127.0.0.1",
      S_PORT: String(port),
      S_DOMAIN: "s.wenfu.dev",
      MM_ORIGIN: "https://mm.wenfu.dev",
      S_DATA_DIR: dataDir,
      S_CORS_ORIGINS: "https://mm.wenfu.dev",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base);
    const created = await fetch(`${base}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://mm.wenfu.dev",
      },
      body: JSON.stringify({ payload: "abcPAYLOAD_test" }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get("access-control-allow-origin"), "https://mm.wenfu.dev");
    const body = await created.json();
    assert.match(body.id, /^[A-Za-z0-9_-]{8}$/);
    assert.equal(body.url, `https://s.wenfu.dev/${body.id}`);

    const got = await fetch(`${base}/api/${body.id}`);
    assert.equal(got.status, 200);
    const record = await got.json();
    assert.equal(record.payload, "abcPAYLOAD_test");

    const redirect = await fetch(`${base}/${body.id}`, { redirect: "manual" });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("location"), `https://mm.wenfu.dev/?s=${body.id}`);

    const missing = await fetch(`${base}/api/nope1234`);
    assert.equal(missing.status, 404);

    assert.equal(created.headers.get("x-content-type-options"), "nosniff");

    const badType = await fetch(`${base}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Origin: "https://mm.wenfu.dev",
      },
      body: JSON.stringify({ payload: "abc" }),
    });
    assert.equal(badType.status, 415);

    const blockedOrigin = await fetch(`${base}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ payload: "abcPAYLOAD_test" }),
    });
    assert.equal(blockedOrigin.status, 201);
    assert.equal(blockedOrigin.headers.get("access-control-allow-origin"), null);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("ignores spoofed X-Forwarded-For without trust proxy", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "short-test-"));
  const port = 19787 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      S_HOST: "127.0.0.1",
      S_PORT: String(port),
      S_DOMAIN: "s.wenfu.dev",
      MM_ORIGIN: "https://mm.wenfu.dev",
      S_DATA_DIR: dataDir,
      S_CORS_ORIGINS: "https://mm.wenfu.dev",
      S_RATE_MAX: "3",
      S_TRUST_PROXY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(base);
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": `1.1.1.${i}`,
          Origin: "https://mm.wenfu.dev",
        },
        body: JSON.stringify({ payload: `abcPAYLOAD_${i}` }),
      });
      assert.equal(res.status, 201);
    }
    const limited = await fetch(`${base}/api`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "9.9.9.9",
        Origin: "https://mm.wenfu.dev",
      },
      body: JSON.stringify({ payload: "abcPAYLOAD_overflow" }),
    });
    assert.equal(limited.status, 429);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
