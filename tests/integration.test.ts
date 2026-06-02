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
    const sign = (prevHash: string, prevId: number, from: string, body: string) =>
      crypto.createHmac("sha256", room.signingKey)
        .update(`${prevHash}|${prevId}|${from}|${body}`).digest("hex");
    const r2 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "0",
        "x-signature": sign("", 0, "alice", "hello"),
      },
      body: JSON.stringify({ from: "alice", body: "hello" }),
    });
    expect(r2.status).toBe(201);
    const m1Hash = (await r2.json()).message.hash;

    // stale prev_id -> 409
    const r3 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "0",
        "x-signature": sign("", 0, "alice", "hello-2"),
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
        "x-signature": sign(m1Hash, 1, "alice", "different"), // sig over different body
      },
      body: JSON.stringify({ from: "alice", body: "hello-2" }),
    });
    expect(r4.status).toBe(401);

    // envelope reflects signed
    const list = await fetch(`${base}/r/${room.slug}/messages.json`).then(j as any);
    expect(list._meta.auth).toBe("hmac-shared");
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

  it("HMAC verifies the raw JSON-parsed body — no normalization mismatch (regression)", async () => {
    // Bug surfaced 2026-04-29: server trim()'d body before HMAC compute, so
    // a body with trailing newline (very common from Python multiline strings)
    // produced sign-vs-verify mismatch -> 401 even when the client signed
    // the canonical (prev_id|from|body) input correctly.
    const c = await fetch(base + "/?signed=1", { method: "POST" });
    const room = await j(c as any);
    const sign = (prevHash: string, prevId: number, from: string, body: string) =>
      crypto.createHmac("sha256", room.signingKey)
        .update(`${prevHash}|${prevId}|${from}|${body}`).digest("hex");

    // body with trailing newline
    const bodyTrailingNL = "hello world\n";
    const r1 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "0",
        "x-signature": sign("", 0, "alice", bodyTrailingNL),
      },
      body: JSON.stringify({ from: "alice", body: bodyTrailingNL }),
    });
    expect(r1.status).toBe(201);
    const m1Hash = (await r1.json()).message.hash;
    // body with leading whitespace
    const bodyLeadingWS = "  indented hello";
    const r2 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "1",
        "x-signature": sign(m1Hash, 1, "alice", bodyLeadingWS),
      },
      body: JSON.stringify({ from: "alice", body: bodyLeadingWS }),
    });
    expect(r2.status).toBe(201);
    // and the values are stored unmodified (so client can re-derive HMAC for chain verification)
    const list = await fetch(`${base}/r/${room.slug}/messages.json`).then(j as any);
    expect(list.messages[0].body).toBe(bodyTrailingNL);
    expect(list.messages[1].body).toBe(bodyLeadingWS);
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

describe("idempotency", () => {
  it("replays the recorded response on retry; doesn't double-post", async () => {
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    const k = `idem-${Date.now()}`;
    const post = () => fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-idempotency-key": k },
      body: JSON.stringify({ from: "alice", body: "once" }),
    });
    const r1 = await post();
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    const r2 = await post();
    expect(r2.status).toBe(201);
    expect(r2.headers.get("x-baton-idempotent-replay")).toBe("true");
    const j2 = await r2.json();
    expect(j2.message.id).toBe(j1.message.id); // same id, no double-post
    const list = await fetch(`${base}/r/${room.slug}/messages.json`).then(j as any);
    expect(list.messages.length).toBe(1);
  });
});

describe("reply_to", () => {
  it("accepts valid reply_to; rejects future-id", async () => {
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    await fetch(`${base}/r/${room.slug}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "a", body: "first" }),
    });
    const r = await fetch(`${base}/r/${room.slug}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "b", body: "reply", reply_to: 1 }),
    });
    expect(r.status).toBe(201);
    expect((await r.json()).message.reply_to).toBe(1);
    const r2 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "b", body: "future", reply_to: 99 }),
    });
    expect(r2.status).toBe(400);
    expect((await r2.json()).error).toBe("reply_to_future_message");
  });
});

describe("hash chain", () => {
  it("each signed-room message links to the prior via prev_hash; chain is verifiable", async () => {
    const c = await fetch(base + "/?signed=1", { method: "POST" });
    const room = await j(c as any);
    const sign = (prevHash: string, prevId: number, from: string, body: string) =>
      crypto.createHmac("sha256", room.signingKey)
        .update(`${prevHash}|${prevId}|${from}|${body}`).digest("hex");
    const post = (prevHash: string, prevId: number, from: string, body: string) => fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": String(prevId),
        "x-signature": sign(prevHash, prevId, from, body),
      },
      body: JSON.stringify({ from, body }),
    });
    const r1 = await post("", 0, "a", "one");
    const m1 = (await r1.json()).message;
    const r2 = await post(m1.hash, 1, "a", "two");
    const m2 = (await r2.json()).message;
    expect(m1.prev_hash).toBe("");
    expect(m1.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(m2.prev_hash).toBe(m1.hash);
    // verify chain client-side
    const recomputed1 = crypto.createHash("sha256").update(`|1|a|one`).digest("hex");
    const recomputed2 = crypto.createHash("sha256").update(`${m1.hash}|2|a|two`).digest("hex");
    expect(m1.hash).toBe(recomputed1);
    expect(m2.hash).toBe(recomputed2);
  });
});

describe("attest mode (ed25519 + TOFU)", () => {
  it("first pubkey for `from` locks; mismatched pubkey rejected; ed25519 sig verified", async () => {
    const c = await fetch(base + "/?attest=1", { method: "POST" });
    const room = await j(c as any);
    expect(room.attest).toBe(true);
    expect(room.signed).toBe(false);
    expect(room.signingKey).toBeUndefined();

    // generate two ed25519 keypairs
    const { publicKey: pkA, privateKey: skA } = crypto.generateKeyPairSync("ed25519");
    const { publicKey: pkB, privateKey: skB } = crypto.generateKeyPairSync("ed25519");
    const rawPk = (k: crypto.KeyObject) => k.export({ format: "der", type: "spki" }).slice(-32).toString("hex");
    const pkAHex = rawPk(pkA);
    const pkBHex = rawPk(pkB);

    const post = (prevId: number, prevHash: string, from: string, body: string, sk: crypto.KeyObject, pkHex: string) => {
      const canonical = `${prevHash}|${prevId}|${from}|${body}`;
      const sig = crypto.sign(null, Buffer.from(canonical), sk).toString("hex");
      return fetch(`${base}/r/${room.slug}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-prev-id": String(prevId),
          "x-pubkey": pkHex,
          "x-signature": sig,
        },
        body: JSON.stringify({ from, body }),
      });
    };

    const r1 = await post(0, "", "alice", "hi", skA, pkAHex);
    expect(r1.status).toBe(201);
    const m1 = (await r1.json()).message;
    expect(m1.pubkey).toBe(pkAHex);
    expect(m1.hash).toMatch(/^[0-9a-f]{64}$/);

    // try to post as alice using bob's key -> 401 pubkey_mismatch
    const r2 = await post(1, m1.hash, "alice", "spoof", skB, pkBHex);
    expect(r2.status).toBe(401);
    expect((await r2.json()).error).toBe("pubkey_mismatch");

    // bob can post under his own name with his key
    const r3 = await post(1, m1.hash, "bob", "hi-back", skB, pkBHex);
    expect(r3.status).toBe(201);
  });
});

describe("attest pre-registered pubkeys", () => {
  it("?parties=name:hex pre-locks pubkeys; closes the TOFU squat race", async () => {
    const { publicKey: pkA } = crypto.generateKeyPairSync("ed25519");
    const { publicKey: pkSquatter, privateKey: skSquatter } = crypto.generateKeyPairSync("ed25519");
    const rawPk = (k: crypto.KeyObject) => k.export({ format: "der", type: "spki" }).slice(-32).toString("hex");
    const pkAHex = rawPk(pkA);
    const pkSquatHex = rawPk(pkSquatter);

    const c = await fetch(base + `/?attest=1&parties=alice:${pkAHex}`, { method: "POST" });
    const room = await j(c as any);
    expect(room.attest).toBe(true);

    // Squatter races to claim "alice" with a different pubkey.
    const canonical = `||0|alice|hi`; // prev_hash="", prev_id=0
    const sig = crypto.sign(null, Buffer.from(canonical), skSquatter).toString("hex");
    const r = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "0",
        "x-pubkey": pkSquatHex,
        "x-signature": sig,
      },
      body: JSON.stringify({ from: "alice", body: "hi" }),
    });
    expect(r.status).toBe(401);
    expect((await r.json()).error).toBe("pubkey_mismatch");
  });
});

describe("encrypted rooms (?encrypted=1)", () => {
  it("rejects plaintext bodies; accepts enc:v1: ciphertext; envelope reflects it", async () => {
    const c = await fetch(base + "/?encrypted=1", { method: "POST" });
    const room = await j(c as any);
    expect(room.encrypted).toBe(true);
    expect(typeof room.encryptionNote).toBe("string");
    // the relay generates no key — encryption is entirely client-side
    expect(room.encryptionKey).toBeUndefined();

    // a plaintext body is refused — the relay fails closed
    const r1 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "alice", body: "this is plaintext" }),
    });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe("plaintext_in_encrypted_room");

    // an enc:v1: shaped body is accepted (server validates shape, not contents)
    const ct = "enc:v1:" + Buffer.from("nonce+ciphertext+tag bytes here").toString("base64url");
    const r2 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "alice", body: ct }),
    });
    expect(r2.status).toBe(201);
    expect((await r2.json()).message.body).toBe(ct);

    const list = await fetch(`${base}/r/${room.slug}/messages.json`).then(j as any);
    expect(list._meta.encrypted).toBe(true);
    expect(list._meta.confidentiality).toMatch(/end-to-end/i);
  });

  it("combines with ?signed=1 — HMAC is computed over the ciphertext body", async () => {
    const c = await fetch(base + "/?signed=1&encrypted=1", { method: "POST" });
    const room = await j(c as any);
    expect(room.signed).toBe(true);
    expect(room.encrypted).toBe(true);

    const ct = "enc:v1:" + Buffer.from("opaque ciphertext").toString("base64url");
    const sig = crypto.createHmac("sha256", room.signingKey)
      .update(`|0|alice|${ct}`).digest("hex");
    const r = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-prev-id": "0", "x-signature": sig },
      body: JSON.stringify({ from: "alice", body: ct }),
    });
    expect(r.status).toBe(201);

    const list = await fetch(`${base}/r/${room.slug}/messages.json`).then(j as any);
    expect(list._meta.encrypted).toBe(true);
    expect(list._meta.fromVerified).toBe(true);
  });
});

describe("messages.json envelope", () => {
  it("includes currentPrevId and currentPrevHash for stateless signers", async () => {
    const c = await fetch(base + "/?signed=1", { method: "POST" });
    const room = await j(c as any);
    let env = await fetch(`${base}/r/${room.slug}/messages.json`).then(j as any);
    expect(env._meta.currentPrevId).toBe(0);
    expect(env._meta.currentPrevHash).toBe("");
    const sig = crypto.createHmac("sha256", room.signingKey)
      .update(`|0|alice|hi`).digest("hex");
    await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-prev-id": "0", "x-signature": sig },
      body: JSON.stringify({ from: "alice", body: "hi" }),
    });
    env = await fetch(`${base}/r/${room.slug}/messages.json`).then(j as any);
    expect(env._meta.currentPrevId).toBe(1);
    expect(env._meta.currentPrevHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("derived keys (macaroon-style)", () => {
  it("issues a derived key with caveats; enforces fromPrefix and maxUses", async () => {
    const c = await fetch(base + "/?signed=1", { method: "POST" });
    const room = await j(c as any);
    const dr = await fetch(`${base}/r/${room.slug}/derive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signingKey: room.signingKey, maxUses: 2, fromPrefix: "worker-" }),
    });
    expect(dr.status).toBe(201);
    const { derivedKey } = await dr.json();
    expect(derivedKey).toMatch(/^d_/);

    const sign = (key: string, prevHash: string, prevId: number, from: string, body: string) =>
      crypto.createHmac("sha256", key)
        .update(`${prevHash}|${prevId}|${from}|${body}`).digest("hex");

    // post as worker-1 (allowed by prefix)
    const r1 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "0",
        "x-signing-key-id": derivedKey,
        "x-signature": sign(derivedKey, "", 0, "worker-1", "hi"),
      },
      body: JSON.stringify({ from: "worker-1", body: "hi" }),
    });
    expect(r1.status).toBe(201);
    const m1Hash = (await r1.json()).message.hash;

    // post as alice (violates prefix) -> 403; uses currently-correct prev_id+hash
    const r2 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "1",
        "x-signing-key-id": derivedKey,
        "x-signature": sign(derivedKey, m1Hash, 1, "alice", "hi"),
      },
      body: JSON.stringify({ from: "alice", body: "hi" }),
    });
    expect(r2.status).toBe(403);
    expect((await r2.json()).error).toBe("from_prefix_violation");

    // second use ok, third should fail maxUses
    const r3 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "1",
        "x-signing-key-id": derivedKey,
        "x-signature": sign(derivedKey, m1Hash, 1, "worker-2", "hi"),
      },
      body: JSON.stringify({ from: "worker-2", body: "hi" }),
    });
    expect(r3.status).toBe(201);
    const m2Hash = (await r3.json()).message.hash;
    const r4 = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-prev-id": "2",
        "x-signing-key-id": derivedKey,
        "x-signature": sign(derivedKey, m2Hash, 2, "worker-3", "hi"),
      },
      body: JSON.stringify({ from: "worker-3", body: "hi" }),
    });
    expect(r4.status).toBe(401);
    expect((await r4.json()).error).toBe("derived_key_max_uses_exceeded");
  });
});

describe("long-poll", () => {
  it("returns immediately when messages exist; blocks then resolves on new message", async () => {
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    // first call: empty; should block ~200ms then resolve when a write lands
    const t0 = Date.now();
    const longPoll = fetch(`${base}/r/${room.slug}/messages.json?since=0&wait=2`).then(j as any);
    setTimeout(() => {
      fetch(`${base}/r/${room.slug}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "x", body: "wake-up" }),
      });
    }, 150);
    const result = await longPoll;
    const elapsed = Date.now() - t0;
    expect(result.messages.length).toBe(1);
    expect(elapsed).toBeLessThan(2000); // resolved before timeout
    expect(elapsed).toBeGreaterThan(100); // actually waited
  });

  it("times out cleanly when no new message arrives", async () => {
    const room = await fetch(base + "/", { method: "POST" }).then(j as any);
    const t0 = Date.now();
    const result = await fetch(`${base}/r/${room.slug}/messages.json?since=0&wait=1`).then(j as any);
    const elapsed = Date.now() - t0;
    expect(result.messages.length).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(1000);
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

describe("per-user tokens (private rooms)", () => {
  async function makePrivateRoom() {
    const c = await fetch(base + "/?private=1", { method: "POST" });
    return (await j(c as any)) as any;
  }
  const bearer = (t: string) => ({ "authorization": `Bearer ${t}` });

  it("advertises tokensUrl on private room creation", async () => {
    const room = await makePrivateRoom();
    expect(room.tokensUrl).toBe(`${base}/r/${room.slug}/tokens`);
    expect(typeof room.tokensNote).toBe("string");
  });

  it("master secret mints a per-user token that can read and post", async () => {
    const room = await makePrivateRoom();
    const mint = await fetch(`${base}/r/${room.slug}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(room.secret) },
      body: JSON.stringify({ label: "alice" }),
    });
    expect(mint.status).toBe(201);
    const { token, label } = await j(mint as any);
    expect(label).toBe("alice");
    expect(token).toMatch(/^u_/);

    // post with the user token
    const post = await fetch(`${base}/r/${room.slug}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ from: "alice", body: "hi from alice" }),
    });
    expect(post.status).toBe(201);

    // read with the user token
    const read = await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer(token) });
    expect(read.status).toBe(200);
    const { messages } = await j(read as any);
    expect(messages.at(-1).body).toBe("hi from alice");
  });

  it("minting requires the master secret, not a user token", async () => {
    const room = await makePrivateRoom();
    // no auth
    const noAuth = await fetch(`${base}/r/${room.slug}/tokens`, { method: "POST" });
    expect(noAuth.status).toBe(401);
    // a valid user token cannot mint more tokens
    const mint = await fetch(`${base}/r/${room.slug}/tokens`, {
      method: "POST", headers: { "content-type": "application/json", ...bearer(room.secret) },
      body: JSON.stringify({ label: "bob" }),
    });
    const { token } = await j(mint as any);
    const escalate = await fetch(`${base}/r/${room.slug}/tokens`, { method: "POST", headers: bearer(token) });
    expect(escalate.status).toBe(401);
  });

  it("a random/unknown token is rejected", async () => {
    const room = await makePrivateRoom();
    const read = await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer("u_totally-made-up") });
    expect(read.status).toBe(401);
  });

  it("revoking one token locks out that user but not others", async () => {
    const room = await makePrivateRoom();
    const mintOne = async (label: string) => {
      const r = await fetch(`${base}/r/${room.slug}/tokens`, {
        method: "POST", headers: { "content-type": "application/json", ...bearer(room.secret) },
        body: JSON.stringify({ label }),
      });
      return (await j(r as any)).token as string;
    };
    const alice = await mintOne("alice");
    const carol = await mintOne("carol");

    // both can read
    expect((await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer(alice) })).status).toBe(200);
    expect((await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer(carol) })).status).toBe(200);

    // revoke alice (master secret required)
    const del = await fetch(`${base}/r/${room.slug}/tokens/${alice}`, { method: "DELETE", headers: bearer(room.secret) });
    expect(del.status).toBe(200);

    // alice is out, carol and master still work
    expect((await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer(alice) })).status).toBe(401);
    expect((await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer(carol) })).status).toBe(200);
    expect((await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer(room.secret) })).status).toBe(200);

    // revoking again is a 404
    const del2 = await fetch(`${base}/r/${room.slug}/tokens/${alice}`, { method: "DELETE", headers: bearer(room.secret) });
    expect(del2.status).toBe(404);
  });

  it("lists tokens (masked) for the owner", async () => {
    const room = await makePrivateRoom();
    for (const label of ["alice", "bob"]) {
      await fetch(`${base}/r/${room.slug}/tokens`, {
        method: "POST", headers: { "content-type": "application/json", ...bearer(room.secret) },
        body: JSON.stringify({ label }),
      });
    }
    const list = await fetch(`${base}/r/${room.slug}/tokens`, { headers: bearer(room.secret) });
    expect(list.status).toBe(200);
    const body = await j(list as any);
    expect(body.count).toBe(2);
    expect(body.tokens.map((t: any) => t.label).sort()).toEqual(["alice", "bob"]);
    // tokens are masked, not full secrets
    expect(body.tokens[0].token).toMatch(/…$/);
  });

  it("rejects per-user tokens on non-private rooms", async () => {
    const c = await fetch(base + "/", { method: "POST" });
    const room = await j(c as any);
    const mint = await fetch(`${base}/r/${room.slug}/tokens`, { method: "POST" });
    expect(mint.status).toBe(400);
  });

  it("mint returns a joinUrl whose manual carries the key + HTTP instructions", async () => {
    const room = await j(await fetch(base + "/?private=1", { method: "POST" }) as any);
    const mint = await j(await fetch(`${base}/r/${room.slug}/tokens`, {
      method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${room.secret}` },
      body: JSON.stringify({ label: "alice" }),
    }) as any);
    expect(mint.joinUrl).toBe(`${base}/j/${room.slug}/${mint.token}`);

    // GET the join link → self-contained markdown manual with the embedded key
    const page = await fetch(mint.joinUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/markdown/);
    const md = await page.text();
    expect(md).toContain(mint.token);                       // key embedded
    expect(md).toContain(`${base}/r/${room.slug}`);         // channel url
    expect(md).toContain("Authorization: Bearer");          // how to auth
    expect(md.toLowerCase()).toContain("untrusted");        // trust warning

    // a bad/revoked token returns 404 (doesn't confirm the room)
    const bad = await fetch(`${base}/j/${room.slug}/u_not-a-real-token`);
    expect(bad.status).toBe(404);

    // after revoke, the join link dies
    await fetch(`${base}/r/${room.slug}/tokens/${mint.token}`, { method: "DELETE", headers: { "authorization": `Bearer ${room.secret}` } });
    expect((await fetch(mint.joinUrl)).status).toBe(404);
  });

  it("encrypted room: join manual is E2E-aware and never contains the key", async () => {
    const room = await j(await fetch(base + "/?private=1&encrypted=1", { method: "POST" }) as any);
    expect(room.encrypted).toBe(true);
    const mint = await j(await fetch(`${base}/r/${room.slug}/tokens`, {
      method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${room.secret}` },
      body: JSON.stringify({ label: "peer" }),
    }) as any);
    const md = await (await fetch(`${base}/j/${room.slug}/${mint.token}`)).text();
    expect(md).toContain("end-to-end encrypted");
    expect(md).toContain("after `#`");            // tells the agent the key is in the fragment
    expect(md).toContain("AESGCM");               // carries the cipher snippet
    expect(md).toContain("enc:v1:");              // wire format
    // the server never had the key (it's in the fragment), so the manual only
    // ever instructs the agent to paste it — never embeds a real one.
    expect(md).toContain("PASTE_THE_k_VALUE");
  });
});

describe("owner-blind claim onboarding (private rooms)", () => {
  const bearer = (t: string) => ({ "authorization": `Bearer ${t}` });
  const sha256hex = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

  async function makePrivateRoom() {
    return (await j(await fetch(base + "/?private=1", { method: "POST" }) as any)) as any;
  }
  async function mintClaim(room: any, label = "guest") {
    const r = await fetch(`${base}/r/${room.slug}/claims`, {
      method: "POST", headers: { "content-type": "application/json", ...bearer(room.secret) },
      body: JSON.stringify({ label }),
    });
    return { status: r.status, body: await j(r as any) };
  }

  it("advertises claimsUrl on private room creation", async () => {
    const room = await makePrivateRoom();
    expect(room.claimsUrl).toBe(`${base}/r/${room.slug}/claims`);
  });

  it("guest claims a token the owner never sees; it grants access", async () => {
    const room = await makePrivateRoom();
    const { status, body } = await mintClaim(room, "alice");
    expect(status).toBe(201);
    expect(body.claimCode).toMatch(/^c_/);

    // guest generates a token locally; only its hash is sent to the relay
    const token = "u_" + crypto.randomBytes(24).toString("base64url");
    const redeem = await fetch(`${base}/r/${room.slug}/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimCode: body.claimCode, tokenHash: sha256hex(token) }),
    });
    expect(redeem.status).toBe(201);
    const rbody = await j(redeem as any);
    expect(rbody.handle).toMatch(/^h_/);

    // the guest's raw token now reads + posts
    const post = await fetch(`${base}/r/${room.slug}`, {
      method: "POST", headers: { "content-type": "application/json", ...bearer(token) },
      body: JSON.stringify({ from: "alice", body: "claimed in" }),
    });
    expect(post.status).toBe(201);
    const read = await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer(token) });
    expect(read.status).toBe(200);
  });

  it("minting a claim code requires the master secret", async () => {
    const room = await makePrivateRoom();
    const noAuth = await fetch(`${base}/r/${room.slug}/claims`, { method: "POST" });
    expect(noAuth.status).toBe(401);
  });

  it("a claim code is single-use", async () => {
    const room = await makePrivateRoom();
    const { body } = await mintClaim(room);
    const once = await fetch(`${base}/r/${room.slug}/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimCode: body.claimCode, tokenHash: sha256hex("u_a") }),
    });
    expect(once.status).toBe(201);
    const twice = await fetch(`${base}/r/${room.slug}/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimCode: body.claimCode, tokenHash: sha256hex("u_b") }),
    });
    expect(twice.status).toBe(404);
  });

  it("rejects a malformed tokenHash", async () => {
    const room = await makePrivateRoom();
    const { body } = await mintClaim(room);
    const bad = await fetch(`${base}/r/${room.slug}/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimCode: body.claimCode, tokenHash: "not-a-hash" }),
    });
    expect(bad.status).toBe(400);
  });

  it("owner can revoke a claimed token by its handle (never having seen the token)", async () => {
    const room = await makePrivateRoom();
    const { body } = await mintClaim(room, "alice");
    const token = "u_" + crypto.randomBytes(24).toString("base64url");
    const redeem = await j(await fetch(`${base}/r/${room.slug}/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimCode: body.claimCode, tokenHash: sha256hex(token) }),
    }) as any);

    // works before revoke
    expect((await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer(token) })).status).toBe(200);
    // owner revokes by handle (the owner never saw `token`)
    const del = await fetch(`${base}/r/${room.slug}/tokens/${redeem.handle}`, { method: "DELETE", headers: bearer(room.secret) });
    expect(del.status).toBe(200);
    // blocked after revoke
    expect((await fetch(`${base}/r/${room.slug}/messages.json`, { headers: bearer(token) })).status).toBe(401);
  });

  it("lists claimed tokens with a handle for revocation", async () => {
    const room = await makePrivateRoom();
    const { body } = await mintClaim(room, "alice");
    await fetch(`${base}/r/${room.slug}/claim`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ claimCode: body.claimCode, tokenHash: sha256hex("u_x") }),
    });
    const list = await j(await fetch(`${base}/r/${room.slug}/tokens`, { headers: bearer(room.secret) }) as any);
    expect(list.tokens[0].handle).toMatch(/^h_/);
    expect(list.tokens[0].label).toBe("alice");
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
