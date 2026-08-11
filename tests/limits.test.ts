// Abuse/egress-guard tests: crawler no-indexing, read metering, room-creation
// caps + the operator gate, SSE concurrency/lifetime caps, and the message
// body-size knob. Each test builds its own app with tight env values via
// appWith(); the functional suites run with these knobs raised sky-high.
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";

const servers: any[] = [];
afterEach(() =>
  Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections?.();
          s.close(() => r());
        }),
    ),
  ),
);

// createApp reads env synchronously, so we can set → construct → restore.
// Un-tested knobs default wide open; empty string falls back to code default.
async function appWith(env: Record<string, string> = {}): Promise<string> {
  const merged: Record<string, string> = {
    BATON_FREE_MESSAGES: "10",
    BATON_RATE_MAX: "10000",
    BATON_READ_RATE_MAX: "100000",
    BATON_CREATES_PER_HOUR_PER_IP: "100000",
    BATON_CREATES_PER_DAY_GLOBAL: "100000",
    BATON_SSE_MAX_PER_IP: "1000",
    BATON_SSE_MAX_GLOBAL: "10000",
    BATON_SSE_MAX_SEC: "",
    BATON_MAX_BODY_BYTES: "",
    BATON_CREATE_SECRET: "",
    ...env,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(merged)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const app = createApp();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return new Promise<string>((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

describe("crawler controls", () => {
  it("serves a deny-all robots.txt", async () => {
    const base = await appWith();
    const r = await fetch(base + "/robots.txt");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("User-agent: *");
    expect(text).toContain("Disallow: /");
  });

  it("sets X-Robots-Tag noindex on every response", async () => {
    const base = await appWith();
    const create = await fetch(base + "/", { method: "POST" });
    const room = await create.json();
    for (const path of ["/", "/AGENTS.md", `/r/${room.slug}`, "/definitely-not-a-route"]) {
      const r = await fetch(base + path);
      expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
    }
  });
});

describe("read metering", () => {
  it("429s GETs past BATON_READ_RATE_MAX but leaves /healthz free", async () => {
    const base = await appWith({ BATON_READ_RATE_MAX: "3" });
    for (let i = 0; i < 3; i++) expect((await fetch(base + "/")).status).toBe(200);
    const over = await fetch(base + "/");
    expect(over.status).toBe(429);
    expect((await over.json()).scope).toBe("reads");
    expect((await fetch(base + "/healthz")).status).toBe(200);
    expect((await fetch(base + "/robots.txt")).status).toBe(200);
  });
});

describe("room-creation caps", () => {
  it("enforces the per-IP hourly cap", async () => {
    const base = await appWith({ BATON_CREATES_PER_HOUR_PER_IP: "2" });
    expect((await fetch(base + "/", { method: "POST" })).status).toBe(201);
    expect((await fetch(base + "/", { method: "POST" })).status).toBe(201);
    const over = await fetch(base + "/", { method: "POST" });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: "room_creation_rate_limited", scope: "ip_hour" });
  });

  it("enforces the global daily cap", async () => {
    const base = await appWith({ BATON_CREATES_PER_DAY_GLOBAL: "1" });
    expect((await fetch(base + "/", { method: "POST" })).status).toBe(201);
    const over = await fetch(base + "/", { method: "POST" });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: "room_creation_rate_limited", scope: "global_day" });
  });

  it("BATON_CREATE_SECRET gates creation to the operator and bypasses caps", async () => {
    const base = await appWith({ BATON_CREATE_SECRET: "op_test_secret", BATON_CREATES_PER_HOUR_PER_IP: "1" });
    const anon = await fetch(base + "/", { method: "POST" });
    expect(anon.status).toBe(401);
    expect((await anon.json()).error).toBe("room_creation_requires_operator_secret");
    const wrong = await fetch(base + "/", {
      method: "POST",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    // operator creates twice despite the per-IP cap of 1 — the gate replaces the caps
    for (let i = 0; i < 2; i++) {
      const ok = await fetch(base + "/", {
        method: "POST",
        headers: { authorization: "Bearer op_test_secret" },
      });
      expect(ok.status).toBe(201);
    }
  });
});

describe("message body cap", () => {
  it("BATON_MAX_BODY_BYTES shrinks the per-message limit", async () => {
    const base = await appWith({ BATON_MAX_BODY_BYTES: "512" });
    const room = await (await fetch(base + "/", { method: "POST" })).json();
    const big = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "a", body: "x".repeat(600) }),
    });
    expect(big.status).toBe(400);
    expect(await big.json()).toMatchObject({ error: "bad_body", limit: 512 });
    const small = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "a", body: "x".repeat(100) }),
    });
    expect(small.status).toBe(201);
  });
});

describe("SSE guards", () => {
  it("caps concurrent streams per IP and releases the slot on disconnect", async () => {
    const base = await appWith({ BATON_SSE_MAX_PER_IP: "1" });
    const room = await (await fetch(base + "/", { method: "POST" })).json();
    const url = `${base}/r/${room.slug}/messages`;

    const ac = new AbortController();
    const first = await fetch(url, { signal: ac.signal });
    expect(first.status).toBe(200);

    const second = await fetch(url);
    expect(second.status).toBe(429);
    expect((await second.json()).error).toBe("too_many_streams");

    ac.abort();
    // the slot frees when the server sees the close — poll briefly
    let reopened: globalThis.Response | null = null;
    for (let i = 0; i < 20; i++) {
      const ac2 = new AbortController();
      const r = await fetch(url, { signal: ac2.signal });
      if (r.status === 200) { reopened = r; ac2.abort(); break; }
      await new Promise((r2) => setTimeout(r2, 100));
    }
    expect(reopened?.status).toBe(200);
  });

  it("ends streams at BATON_SSE_MAX_SEC with a bye frame", async () => {
    const base = await appWith({ BATON_SSE_MAX_SEC: "1" });
    const room = await (await fetch(base + "/", { method: "POST" })).json();
    const res = await fetch(`${base}/r/${room.slug}/messages`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      const { done, value } = await reader.read();
      if (value) text += dec.decode(value, { stream: true });
      if (done) break;
    }
    expect(text).toContain("event: bye");
    expect(text).toContain("stream_lifetime_reached");
  }, 10000);
});
