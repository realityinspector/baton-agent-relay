// Power-tier tests: one deployment serving both a locked-down public audience
// and key-holding power users. Tight free-tier values throughout, so every
// assertion that a power request got MORE is meaningful.
import { describe, it, expect, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";

const servers: any[] = [];
// x402Config() reads BATON_FREE_MESSAGES lazily on every request, not at
// createApp() time — so env has to stay in place until the server is torn
// down, unlike the knobs createApp captures synchronously.
let restoreEnv: Array<[string, string | undefined]> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections?.();
          s.close(() => r());
        }),
    ),
  );
  for (const [k, v] of restoreEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  restoreEnv = [];
});

const KEY = "test-power-key-abc";

// Free tier deliberately cramped; power tier roomy but still finite.
async function appWith(env: Record<string, string> = {}): Promise<string> {
  const merged: Record<string, string> = {
    BATON_POWER_KEYS: KEY,
    BATON_FREE_MESSAGES: "2",
    BATON_MAX_BODY_BYTES: "256",
    BATON_READ_RATE_MAX: "100000",
    BATON_RATE_MAX: "10000",
    BATON_CREATES_PER_HOUR_PER_IP: "100000",
    BATON_CREATES_PER_DAY_GLOBAL: "100000",
    BATON_SSE_MAX_PER_IP: "1000",
    BATON_SSE_MAX_GLOBAL: "10000",
    BATON_SSE_MAX_SEC: "",
    BATON_POWER_FREE_MESSAGES: "500",
    BATON_POWER_MAX_BODY_BYTES: "20000",
    BATON_POWER_READ_RATE_MAX: "100000",
    BATON_POWER_RATE_MAX: "10000",
    ...env,
  };
  for (const [k, v] of Object.entries(merged)) {
    restoreEnv.push([k, process.env[k]]);
    process.env[k] = v;
  }
  const app = createApp();
  return new Promise<string>((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

const power = { "x-baton-key": KEY };
const post = (base: string, slug: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/r/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ from: "a", body }),
  });

describe("tier stamping", () => {
  it("stamps rooms free by default and power when a valid key is presented", async () => {
    const base = await appWith();
    const free = await (await fetch(base + "/", { method: "POST" })).json();
    expect(free.tier).toBe("free");
    expect(free.freeMessages).toBe(2);

    const pow = await (await fetch(base + "/", { method: "POST", headers: power })).json();
    expect(pow.tier).toBe("power");
    expect(pow.freeMessages).toBe(500);
    expect(pow.maxBodyBytes).toBe(20000);
  });

  it("ignores an invalid or absent key", async () => {
    const base = await appWith();
    const bad = await (await fetch(base + "/", { method: "POST", headers: { "x-baton-key": "nope" } })).json();
    expect(bad.tier).toBe("free");
  });

  it("treats every room as free when no power keys are configured", async () => {
    const base = await appWith({ BATON_POWER_KEYS: "" });
    const r = await (await fetch(base + "/", { method: "POST", headers: power })).json();
    expect(r.tier).toBe("free");
    expect(r.freeMessages).toBe(2);
  });

  it("exposes the tier in the message envelope meta", async () => {
    const base = await appWith();
    const pow = await (await fetch(base + "/", { method: "POST", headers: power })).json();
    const meta = await (await fetch(`${base}/r/${pow.slug}/messages.json`)).json();
    expect(meta._meta.tier).toBe("power");
  });
});

describe("tier inheritance (the join-link guest case)", () => {
  it("lets a keyless guest post a power-sized body into a power room", async () => {
    const base = await appWith();
    const pow = await (await fetch(base + "/", { method: "POST", headers: power })).json();
    // No key on this request at all — entitlement comes from the room.
    const r = await post(base, pow.slug, "x".repeat(5000));
    expect(r.status).toBe(201);
  });

  it("still refuses a body past even the power cap", async () => {
    const base = await appWith();
    const pow = await (await fetch(base + "/", { method: "POST", headers: power })).json();
    const r = await post(base, pow.slug, "x".repeat(20001));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe("bad_body");
    expect(j.limit).toBe(20000);
  });

  it("holds free rooms to the free body cap even for a key holder", async () => {
    const base = await appWith();
    const free = await (await fetch(base + "/", { method: "POST" })).json();
    // A room is a shared channel: its cap means the same thing for everyone in
    // it, so presenting a key does not retroactively upgrade someone else's room.
    const r = await post(base, free.slug, "x".repeat(300), power);
    expect(r.status).toBe(400);
    expect((await r.json()).limit).toBe(256);
  });

  it("holds free rooms to the free quota even for a key holder", async () => {
    const base = await appWith();
    const free = await (await fetch(base + "/", { method: "POST" })).json();
    expect((await post(base, free.slug, "one", power)).status).toBe(201);
    expect((await post(base, free.slug, "two", power)).status).toBe(201);
    expect((await post(base, free.slug, "three", power)).status).toBe(402);
  });
});

describe("tier quota", () => {
  it("402s a free room at BATON_FREE_MESSAGES but lets a power room continue", async () => {
    const base = await appWith();
    const free = await (await fetch(base + "/", { method: "POST" })).json();
    expect((await post(base, free.slug, "one")).status).toBe(201);
    expect((await post(base, free.slug, "two")).status).toBe(201);
    expect((await post(base, free.slug, "three")).status).toBe(402);

    const pow = await (await fetch(base + "/", { method: "POST", headers: power })).json();
    for (let i = 0; i < 5; i++) expect((await post(base, pow.slug, `m${i}`)).status).toBe(201);
    const last = await (await post(base, pow.slug, "still going")).json();
    expect(last.freeMessagesRemaining).toBe(500 - 6);
  });
});

describe("tier creation caps", () => {
  it("exempts power keys from the global daily creation cap", async () => {
    const base = await appWith({ BATON_CREATES_PER_DAY_GLOBAL: "1" });
    expect((await fetch(base + "/", { method: "POST" })).status).toBe(201);
    // free tier is now exhausted globally
    expect((await fetch(base + "/", { method: "POST" })).status).toBe(429);
    // the operator can still create on their own relay
    expect((await fetch(base + "/", { method: "POST", headers: power })).status).toBe(201);
  });

  it("still bounds power creation by its own per-IP ceiling", async () => {
    const base = await appWith({ BATON_POWER_CREATES_PER_HOUR: "2" });
    expect((await fetch(base + "/", { method: "POST", headers: power })).status).toBe(201);
    expect((await fetch(base + "/", { method: "POST", headers: power })).status).toBe(201);
    expect((await fetch(base + "/", { method: "POST", headers: power })).status).toBe(429);
  });
});

describe("tier read metering", () => {
  it("lifts the read cap for key holders but not for anonymous traffic", async () => {
    const base = await appWith({ BATON_READ_RATE_MAX: "3", BATON_POWER_READ_RATE_MAX: "100" });
    for (let i = 0; i < 3; i++) expect((await fetch(base + "/")).status).toBe(200);
    expect((await fetch(base + "/")).status).toBe(429);
    // same IP, same window — the key is what lifts it
    expect((await fetch(base + "/", { headers: power })).status).toBe(200);
  });
});
