import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { createApp } from "../src/server.js";

let base = "";
let server: any;

beforeAll(async () => {
  process.env.BATON_FREE_MESSAGES = "10";
  process.env.BATON_RATE_MAX = "10000";
  const app = createApp();
  await new Promise<void>((r) => {
    server = app.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      base = `http://127.0.0.1:${port}`;
      r();
    });
  });
});
afterAll(() => new Promise<void>((r) => {
  server.closeAllConnections?.();
  server.close(() => r());
}));

async function j(res: Response) { return res.json(); }

describe("landing & manuals", () => {
  it("GET / returns html with prompt-injection warning", async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t.toLowerCase()).toContain("prompt-injection");
    expect(t).toContain("Baton");
  });
  it("GET /AGENTS.md", async () => {
    const r = await fetch(base + "/AGENTS.md");
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain("AGENTS.md");
    expect(t.toLowerCase()).toContain("prompt-injection");
  });
});

describe("public room flow", () => {
  it("creates a room and posts/reads messages", async () => {
    const c = await fetch(base + "/", { method: "POST" });
    expect(c.status).toBe(201);
    const room = await j(c as any);
    expect(room.slug).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(room.private).toBe(false);
    expect(room.secret).toBeUndefined();

    const a = await fetch(`${base}/r/${room.slug}/AGENTS.md`);
    expect(a.status).toBe(200);
    const aText = (await a.text()).toLowerCase();
    expect(aText).toContain("untrusted");
    expect(aText).toContain("not provided");
    expect(aText).toContain("fromverified");

    const html = await fetch(`${base}/r/${room.slug}`);
    expect(html.status).toBe(200);

    const post = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "alice", body: "hi" }),
    });
    expect(post.status).toBe(201);
    const list = await fetch(`${base}/r/${room.slug}/messages.json`).then(j as any);
    expect(list.messages.length).toBe(1);
    expect(list.messages[0].body).toBe("hi");
    // envelope self-describes trust model
    expect(list._meta).toBeDefined();
    expect(list._meta.auth).toBe("none");
    expect(list._meta.fromVerified).toBe(false);
    expect(list._meta.warning).toMatch(/not verified/i);
  });
});

describe("signed rooms", () => {
  it("rejects unsigned posts; accepts valid HMAC; rejects stale prev_id and bad sig", async () => {
    const c = await fetch(base + "/?signed=1", { method: "POST" });
    const room = await j(c as any);
    expect(room.signed).toBe(true);
    expect(typeof room.signingKey).toBe("string");

    // unsigned post -> 401
    const r1 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "a", body: "hi" }),
    });
    expect(r1.status).toBe(401);

    // valid signed post
    const sign = (prevId: number, from: string, body: string) =>
      crypto.createHmac("sha256", room.signingKey)
        .update(`${prevId}|${from}|${body}`).digest("hex");
    const r2 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "0",
        "x-signature": sign(0, "alice", "hello"),
      },
      body: JSON.stringify({ from: "alice", body: "hello" }),
    });
    expect(r2.status).toBe(201);

    // stale prev_id -> 409
    const r3 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "0",
        "x-signature": sign(0, "alice", "hello-2"),
      },
      body: JSON.stringify({ from: "alice", body: "hello-2" }),
    });
    expect(r3.status).toBe(409);
    expect((await r3.json()).currentPrevId).toBe(1);

    // bad signature -> 401
    const r4 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "1",
        "x-signature": sign(1, "alice", "different"), // sig over different body
      },
      body: JSON.stringify({ from: "alice", body: "hello-2" }),
    });
    expect(r4.status).toBe(401);

    // envelope reflects signed
    const list = await fetch(`${base}/r/${room.slug}/messages.json`).then(j as any);
    expect(list._meta.auth).toBe("hmac");
    expect(list._meta.fromVerified).toBe(true);
  });

  it("rejects from values containing | (HMAC canonicalization guard)", async () => {
    const c = await fetch(base + "/?signed=1", { method: "POST" });
    const room = await j(c as any);
    const sign = (prevId: number, from: string, body: string) =>
      crypto.createHmac("sha256", room.signingKey)
        .update(`${prevId}|${from}|${body}`).digest("hex");
    const r = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "0",
        "x-signature": sign(0, "a|b", "c"),
      },
      body: JSON.stringify({ from: "a|b", body: "c" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("bad_from");
  });

  it("dev bypass does NOT skip HMAC verification in signed rooms", async () => {
    process.env.BATON_DEV_BYPASS_TOKEN = "test-token-xyz";
    const c = await fetch(base + "/?signed=1", { method: "POST" });
    const room = await j(c as any);
    // Try to post with dev bypass header but NO valid X-Signature
    const r = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment": "dev:test-token-xyz:nonce-x",
      },
      body: JSON.stringify({ from: "a", body: "hi" }),
    });
    expect(r.status).toBe(401); // HMAC check runs before quota/dev-bypass
    delete process.env.BATON_DEV_BYPASS_TOKEN;
  });
});

describe("quota soft-warn", () => {
  it("returns freeMessagesRemaining and warns near limit", async () => {
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    let lastBody: any = null;
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${base}/r/${room.slug}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "x", body: `m${i}` }),
      });
      lastBody = await r.json();
    }
    expect(lastBody.freeMessagesRemaining).toBe(0);
    expect(lastBody.quotaWarning).toMatch(/last free message/i);
  });
});

describe("private room flow", () => {
  it("requires bearer token", async () => {
    const c = await fetch(base + "/?private=1", { method: "POST" });
    const room = await j(c as any);
    expect(room.private).toBe(true);
    expect(typeof room.secret).toBe("string");

    const r1 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "a", body: "hi" }),
    });
    expect(r1.status).toBe(401);

    const r2 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${room.secret}`,
      },
      body: JSON.stringify({ from: "a", body: "hi" }),
    });
    expect(r2.status).toBe(201);
  });
});

describe("x402 quota", () => {
  it("returns 402 on message 11 with proper accepts body", async () => {
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${base}/r/${room.slug}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "x", body: `m${i}` }),
      });
      expect(r.status).toBe(201);
    }
    const r = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "x", body: "over" }),
    });
    expect(r.status).toBe(402);
    const body = await r.json();
    expect(body.x402Version).toBe(1);
    expect(body.error).toMatch(/payment_required/);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(body.accepts[0].network).toBeDefined();
    expect(body.accepts[0].asset).toBeDefined();
    expect(body.accepts[0].payTo).toBeDefined();
  });

  it("dev bypass token unblocks post-quota messages", async () => {
    process.env.BATON_DEV_BYPASS_TOKEN = "test-token-xyz";
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    for (let i = 0; i < 10; i++) {
      await fetch(`${base}/r/${room.slug}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "x", body: `m${i}` }),
      });
    }
    const r = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment": "dev:test-token-xyz:nonce-1",
      },
      body: JSON.stringify({ from: "x", body: "paid-msg" }),
    });
    expect(r.status).toBe(201);
    const r2 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment": "dev:test-token-xyz:nonce-1",
      },
      body: JSON.stringify({ from: "x", body: "replay" }),
    });
    expect(r2.status).toBe(402); // replay rejected
    delete process.env.BATON_DEV_BYPASS_TOKEN;
  });
});

describe("two-client conversation", () => {
  it("two simulated clients hold a 5-message exchange", async () => {
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    const url = `${base}/r/${room.slug}`;
    const send = (from: string, body: string) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from, body }),
      });
    const turns = [
      ["alice", "hello bob"],
      ["bob", "hey alice"],
      ["alice", "what's up"],
      ["bob", "debugging x402"],
      ["alice", "nice"],
    ] as const;
    for (const [f, b] of turns) {
      const r = await send(f, b);
      expect(r.status).toBe(201);
    }
    const list = await fetch(`${url}/messages.json`).then(j as any);
    expect(list.messages.length).toBe(5);
    expect(list.messages.map((m: any) => m.from)).toEqual(["alice","bob","alice","bob","alice"]);
  });
});

describe("cache headers", () => {
  it("sets no-store on message feeds and AGENTS.md", async () => {
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    const r1 = await fetch(`${base}/r/${room.slug}/messages.json`);
    expect(r1.headers.get("cache-control") || "").toContain("no-store");
    const r2 = await fetch(`${base}/r/${room.slug}/AGENTS.md`);
    expect(r2.headers.get("cache-control") || "").toContain("no-store");
    const r3 = await fetch(`${base}/AGENTS.md`);
    expect(r3.headers.get("cache-control") || "").toContain("no-store");
  });
});

describe("SSE", () => {
  it("streams a freshly posted message", async () => {
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    const url = `${base}/r/${room.slug}`;
    const u = new URL(`${url}/messages`);
    const http = await import("node:http");

    let saw = false;
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method: "GET", headers: { accept: "text/event-stream" },
      }, (sse) => {
        let buf = "";
        sse.setEncoding("utf8");
        sse.on("data", (chunk: string) => {
          buf += chunk;
          if (buf.includes("stream-me")) { saw = true; req.destroy(); resolve(); }
        });
        sse.on("end", () => resolve());
        sse.on("error", reject);

        // once headers received, post a message
        setTimeout(() => {
          fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ from: "s", body: "stream-me" }),
          }).catch(reject);
        }, 250);
      });
      req.on("error", reject);
      req.end();
      setTimeout(() => { req.destroy(); resolve(); }, 3000);
    });
    expect(saw).toBe(true);
  });
});
