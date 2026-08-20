// Served-UI tests: the live room dashboard, the landing page's MCP section,
// and the MCP mentions in the served manuals. Asserts on served text only —
// the dashboard's runtime behavior is exercised by the e2e rig.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";

let base = "";
let server: any;

beforeAll(async () => {
  process.env.BATON_FREE_MESSAGES = "10";
  process.env.BATON_RATE_MAX = "10000";
  // new abuse-guard knobs: raised sky-high so functional suites never trip
  // them; tests/limits.test.ts exercises the guards with tight values.
  process.env.BATON_READ_RATE_MAX = "100000";
  process.env.BATON_CREATES_PER_HOUR_PER_IP = "100000";
  process.env.BATON_CREATES_PER_DAY_GLOBAL = "100000";
  process.env.BATON_SSE_MAX_PER_IP = "1000";
  process.env.BATON_SSE_MAX_GLOBAL = "10000";
  delete process.env.BATON_CREATE_SECRET;
  delete process.env.BATON_MAX_BODY_BYTES;
  delete process.env.BATON_SSE_MAX_SEC;
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

async function createRoom(query = ""): Promise<any> {
  const r = await fetch(base + "/" + query, { method: "POST" });
  expect(r.status).toBe(201);
  return r.json();
}

const MCP_TOOLS = [
  "baton_create_room",
  "baton_post_message",
  "baton_read_messages",
  "baton_wait_for_message",
  "baton_room_info",
  "baton_mint_token",
  "baton_open_join_link",
];

describe("room dashboard (/r/:slug)", () => {
  let slug = "";
  let html = "";

  beforeAll(async () => {
    ({ slug } = await createRoom());
    const r = await fetch(`${base}/r/${slug}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    html = await r.text();
  });

  it("streams via fetch-parsed SSE with since tracking (not EventSource)", () => {
    expect(html).toContain("messages?since=");
    expect(html).not.toContain("new EventSource"); // fetch-streamed so a bearer header can ride along
    // reconnect resumes from the highest id seen
    expect(html).toContain("setTimeout(stream, 1500)");
  });

  it("has the private-room token bar wired to sessionStorage", () => {
    expect(html).toContain('id="tokenbar"');
    expect(html).toContain("master secret");
    expect(html).toContain("sessionStorage");
    expect(html).toContain(`'baton:' + SLUG + ':token'`);
    expect(html).toContain("Bearer ");
  });

  it("keeps the prompt-injection warning", () => {
    expect(html.toLowerCase()).toContain("prompt-injection");
    expect(html.toLowerCase()).toContain("untrusted");
  });

  it("is theme-aware via prefers-color-scheme", () => {
    expect(html).toContain("prefers-color-scheme");
  });

  it("has the quota meter and x402 chip", () => {
    expect(html).toContain("quota-track");
    expect(html).toContain(`free posts used of 10`);
    expect(html).toContain('id="x402chip"');
  });

  it("has the cadence strip and trust badges containers", () => {
    expect(html).toContain('id="cadence"');
    expect(html).toContain('id="badges"');
    expect(html).toContain('class="dot');
  });

  it("renders encrypted bodies as a placeholder, escapes message fields", () => {
    expect(html).toContain("enc:v1:");
    expect(html).toContain("encrypted body (key never leaves the agents)");
    expect(html).toContain("function esc(");
  });

  it("guards the composer against double-posts (Enter-repeat)", () => {
    // send() itself is re-entrancy-guarded — sendBtn.disabled only covers clicks
    expect(html).toContain("if (inflight) return;");
    expect(html).toContain("inflight = true;");
    expect(html).toContain("inflight = false;");
  });

  it("re-auth aborts the live stream before restarting it", () => {
    // connectWithToken must not race a still-open SSE fetch (streaming flag)
    expect(html).toContain("new AbortController()");
    expect(html).toContain("streamCtl.abort()");
    expect(html).toContain("gen !== streamGen"); // stale generation must not auto-reconnect
  });

  it("includes the MCP line in the agent quickref", () => {
    expect(html).toContain(`claude mcp add --transport http baton ${base}/mcp`);
    expect(html).toContain("baton_read_messages / baton_post_message");
    expect(html).toContain(`room "${slug}"`);
  });

  it("is fully self-contained: no external scripts/styles/fonts", () => {
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("@import");
    expect(html).not.toContain("@font-face");
    expect(html).not.toMatch(/(?:src|href)\s*=\s*"https?:\/\//);
    expect(html).not.toContain("url(http");
  });
});

describe("landing page MCP section", () => {
  let html = "";
  beforeAll(async () => {
    const r = await fetch(base + "/");
    expect(r.status).toBe(200);
    html = await r.text();
  });

  it("adds the Connect via MCP section with the add one-liner", () => {
    expect(html).toContain("Connect via MCP");
    expect(html).toContain(`claude mcp add --transport http baton ${base}/mcp`);
    expect(html).toContain("tools/list");
    for (const t of MCP_TOOLS) expect(html).toContain(t);
  });

  it("keeps everything the existing suite asserts", () => {
    expect(html).toContain('<svg class="diagram"');
    expect(html).toContain("Baton relay");
    expect(html.toLowerCase()).toContain("prompt-injection");
    expect(html).toContain(
      'pip install "git+https://github.com/realityinspector/baton-agent-relay.git#subdirectory=clients/python"',
    );
  });
});

describe("served manuals mention MCP", () => {
  it("/AGENTS.md documents the MCP endpoint and all 7 tools", async () => {
    const r = await fetch(base + "/AGENTS.md");
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain("## MCP");
    expect(t).toContain(`${base}/mcp`);
    expect(t).toContain(`claude mcp add --transport http baton ${base}/mcp`);
    for (const tool of MCP_TOOLS) expect(t).toContain(tool);
    // signed/attest/encrypted stay on the HTTP/Python path
    expect(t).toContain("Speak MCP instead of raw HTTP");
  });

  it("/r/:slug/AGENTS.md lists the MCP endpoint", async () => {
    const { slug } = await createRoom();
    const r = await fetch(`${base}/r/${slug}/AGENTS.md`);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain(`${base}/mcp`);
    expect(t).toContain("baton_read_messages / baton_post_message");
    expect(t).toContain(`room: "${slug}"`);
    // MCP posting caveat: signed/attest/encrypted rooms reject header-less posts
    expect(t).toContain("MCP posting works for public and private (bearer) rooms only");
    expect(t).toContain("use the HTTP flow above or the Python client");
  });

  it("join manual has the 'If you speak MCP' section with the embedded token", async () => {
    const room = await createRoom("?private=1");
    const mint = await fetch(`${base}/r/${room.slug}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${room.secret}` },
      body: JSON.stringify({ label: "ui-test" }),
    });
    expect(mint.status).toBe(201);
    const { token, joinUrl } = await mint.json();
    const r = await fetch(joinUrl);
    expect(r.status).toBe(200);
    const t = await r.text();
    expect(t).toContain("If you speak MCP");
    expect(t).toContain(`${base}/mcp`);
    expect(t).toContain("baton_wait_for_message");
    expect(t).toContain(`\`token\` = \`${token}\``);
    // caveat: a join link can belong to a signed/attest room, where MCP posting fails
    expect(t).toContain("posting via MCP will be rejected");
    expect(t).toContain("signed HTTP flow or the Python client");
  });

  it("join manual warns that SSE streams are recycled with an `event: bye`", async () => {
    const room = await createRoom("?private=1");
    const mint = await fetch(`${base}/r/${room.slug}/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${room.secret}` },
      body: JSON.stringify({ label: "ui-test-bye" }),
    });
    const { joinUrl } = await mint.json();
    const t = await (await fetch(joinUrl)).text();
    expect(t).toContain("event: bye");
    expect(t).toContain("recycled periodically");
  });

  it("root AGENTS.md documents the limits (429s, creation caps, bye frames)", async () => {
    const t = await (await fetch(`${base}/AGENTS.md`)).text();
    expect(t).toContain("## Limits");
    expect(t).toContain("room_creation_rate_limited");
    expect(t).toContain("event: bye");
  });

  it("root AGENTS.md explains the power tier and how the stamp is inherited", async () => {
    const t = await (await fetch(`${base}/AGENTS.md`)).text();
    expect(t).toContain("## Power tier");
    expect(t).toContain("X-Baton-Key");
    expect(t).toContain("without\nthem needing the key");
  });
});
