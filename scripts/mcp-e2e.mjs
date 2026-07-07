#!/usr/bin/env node
// Baton MCP end-to-end rig.
//
// Boots the built server (dist/server.js) on a free port and drives a real
// two-agent conversation over the native MCP endpoint (POST /mcp, JSON-RPC 2.0
// per SPEC Feature 1): initialize → tools/list → create private room → mint
// token → open join link → concurrent wait/post volley → reply_to → transcript
// → room_info, then sanity-checks the served dashboard + root AGENTS.md.
//
// Plain Node >= 20, zero dependencies. Expects `npm run build` to have run.
// Prints PASS/FAIL per step, always kills the child server, exits 0/1, and a
// 60s watchdog guarantees CI can never hang.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_JS = path.join(ROOT, "dist", "server.js");
const HARD_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function fmt(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s !== undefined && s.length > 400 ? s.slice(0, 400) + "…" : String(s);
}

function assert(cond, msg, expected, actual) {
  if (cond) return;
  const detail =
    expected !== undefined || actual !== undefined
      ? `\n    expected: ${fmt(expected)}\n    actual:   ${fmt(actual)}`
      : "";
  throw new Error(msg + detail);
}

function assertEq(actual, expected, msg) {
  assert(actual === expected, msg, expected, actual);
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP helpers

let nextId = 1;

/** JSON-RPC request (with id) to POST {base}/mcp. Returns .result or throws. */
async function rpc(base, method, params) {
  const id = nextId++;
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  assertEq(res.status, 200, `rpc ${method}: HTTP status`);
  const body = await res.json();
  assertEq(body.jsonrpc, "2.0", `rpc ${method}: jsonrpc version`);
  assertEq(body.id, id, `rpc ${method}: response id`);
  if (body.error) {
    throw new Error(`rpc ${method}: JSON-RPC error ${body.error.code}: ${fmt(body.error.message)}`);
  }
  return body.result;
}

/** JSON-RPC notification (no id) — server must answer HTTP 202, empty body. */
async function notify(base, method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
  assertEq(res.status, 202, `notify ${method}: HTTP status`);
  const text = await res.text();
  assertEq(text, "", `notify ${method}: body should be empty`);
}

/** tools/call that must succeed; returns the tool text parsed as JSON. */
async function tool(base, name, args) {
  const result = await rpc(base, "tools/call", { name, arguments: args });
  const text = result?.content?.[0]?.text;
  assert(typeof text === "string", `tool ${name}: missing content[0].text`, "text content", result);
  if (result.isError) throw new Error(`tool ${name}: isError=true: ${fmt(text)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text; // some tools may return plain text; callers assert shape
  }
}

// ---------------------------------------------------------------------------
// step runner

let passed = 0;
let failed = 0;

async function step(name, fn) {
  try {
    const value = await fn();
    passed++;
    console.log(`PASS  ${name}`);
    return value;
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${String(err.message || err).split("\n").join("\n      ")}`);
    throw err; // steps are sequential and dependent — abort the run
  }
}

// ---------------------------------------------------------------------------
// main

let child = null;
let serverLog = "";

function killChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  // escalate if it lingers; unref so this timer never keeps the process alive
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 2000).unref();
}

const watchdog = setTimeout(() => {
  console.error(`FAIL  hard timeout: rig exceeded ${HARD_TIMEOUT_MS / 1000}s`);
  killChild();
  process.exit(1);
}, HARD_TIMEOUT_MS);

async function main() {
  // fail fast with a clear message before spawning anything
  if (!existsSync(SERVER_JS)) {
    throw new Error(`${SERVER_JS} not found — run \`npm run build\` first`);
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, [SERVER_JS], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), BATON_RATE_MAX: "10000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));
  const spawnFailure = new Promise((_, reject) =>
    child.once("error", (e) => reject(new Error(`failed to spawn server: ${e.message}`)))
  );

  await step(`server healthy at ${base}/healthz`, async () => {
    const deadline = Date.now() + 10_000;
    let lastErr = "no response yet";
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`server exited early (code ${child.exitCode}). output:\n${serverLog}`);
      }
      try {
        const res = await Promise.race([fetch(`${base}/healthz`), spawnFailure]);
        if (res.ok) return;
        lastErr = `HTTP ${res.status}`;
      } catch (e) {
        lastErr = e.message;
      }
      await sleep(250);
    }
    throw new Error(`server never became healthy within 10s (${lastErr}). output:\n${serverLog}`);
  });

  await step("initialize handshake", async () => {
    const r = await rpc(base, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "baton-mcp-e2e", version: "0.2.0" },
    });
    assertEq(r?.serverInfo?.name, "baton", "serverInfo.name");
    assertEq(r?.protocolVersion, "2025-06-18", "protocolVersion echo");
    assert(typeof r?.instructions === "string" && r.instructions.length > 0, "instructions present", "non-empty string", r?.instructions);
  });

  await step("notifications/initialized → 202", () => notify(base, "notifications/initialized", {}));

  await step("tools/list → exactly the 7 tools", async () => {
    const r = await rpc(base, "tools/list", {});
    const names = (r?.tools ?? []).map((t) => t.name).sort();
    const expected = [
      "baton_create_room",
      "baton_mint_token",
      "baton_open_join_link",
      "baton_post_message",
      "baton_read_messages",
      "baton_room_info",
      "baton_wait_for_message",
    ];
    assertEq(names.join(","), expected.join(","), "tool names");
    for (const t of r.tools) {
      assertEq(t?.inputSchema?.type, "object", `tool ${t.name}: inputSchema.type`);
    }
  });

  const room = await step("baton_create_room {private:true}", async () => {
    const r = await tool(base, "baton_create_room", { private: true });
    assert(typeof r.slug === "string" && r.slug.length > 0, "slug present", "slug", r);
    assert(typeof r.secret === "string" && r.secret.length > 0, "secret present", "secret", r);
    assert(typeof r.url === "string" && r.url.endsWith(`/r/${r.slug}`), "url points at room", `…/r/${r.slug}`, r.url);
    return r;
  });

  const minted = await step("baton_mint_token → joinUrl", async () => {
    const r = await tool(base, "baton_mint_token", { room: room.slug, secret: room.secret, label: "agent-b" });
    assert(typeof r.token === "string" && r.token.length > 0, "token present", "token", r);
    assert(typeof r.joinUrl === "string" && r.joinUrl.includes(`/j/${room.slug}/`), "joinUrl shape", `…/j/${room.slug}/<token>`, r.joinUrl);
    return r;
  });

  await step("baton_open_join_link resolves slug + token", async () => {
    const r = await tool(base, "baton_open_join_link", { url: minted.joinUrl });
    assertEq(r.slug, room.slug, "join link slug");
    assertEq(r.token, minted.token, "join link token");
  });

  const firstId = await step("volley: B waits, A posts, wait resolves with A's message", async () => {
    // agent B long-polls before the message exists…
    const waitP = tool(base, "baton_wait_for_message", {
      room: room.slug,
      since: 0,
      timeout_sec: 20,
      token: minted.token,
    });
    await sleep(300);
    // …then agent A posts (master secret as bearer)
    const post = await tool(base, "baton_post_message", {
      room: room.slug,
      from: "agent-a",
      body: "ping from agent-a",
      token: room.secret,
    });
    const id = post?.message?.id;
    assert(Number.isInteger(id), "post returned message.id", "integer id", post);
    const waited = await waitP;
    const msgs = waited?.messages ?? [];
    assert(msgs.length >= 1, "wait_for_message returned the new message", ">= 1 message", msgs.length);
    assertEq(msgs[0].from, "agent-a", "waited message sender");
    assertEq(msgs[0].body, "ping from agent-a", "waited message body");
    return id;
  });

  await step("agent B replies with reply_to", async () => {
    const r = await tool(base, "baton_post_message", {
      room: room.slug,
      from: "agent-b",
      body: "pong from agent-b",
      reply_to: firstId,
      token: minted.token,
    });
    assertEq(r?.message?.reply_to, firstId, "reply_to echoed on the stored message");
  });

  await step("baton_read_messages → 2-message transcript with correct reply_to", async () => {
    const r = await tool(base, "baton_read_messages", { room: room.slug, since: 0, token: minted.token });
    const msgs = r?.messages ?? [];
    assertEq(msgs.length, 2, "transcript length");
    assertEq(msgs[0].from, "agent-a", "message 1 sender");
    assertEq(msgs[1].from, "agent-b", "message 2 sender");
    assertEq(msgs[1].reply_to, firstId, "message 2 reply_to");
    assert(r._meta && typeof r._meta === "object", "_meta envelope present", "_meta object", r._meta);
  });

  await step("baton_room_info messageCount === 2", async () => {
    const r = await tool(base, "baton_room_info", { room: room.slug, token: minted.token });
    assertEq(r.slug, room.slug, "room_info slug");
    assertEq(r.messageCount, 2, "messageCount");
    assert(!("messages" in r), "room_info must not return bodies", "no messages field", Object.keys(r));
  });

  await step("dashboard HTML served without auth, warns about prompt injection", async () => {
    const res = await fetch(`${base}/r/${room.slug}`);
    assertEq(res.status, 200, "dashboard HTTP status");
    const html = await res.text();
    assert(/prompt.injection/i.test(html), "prompt-injection warning present", "text matching /prompt.injection/i", html.slice(0, 200));
  });

  await step("root AGENTS.md documents MCP", async () => {
    const res = await fetch(`${base}/AGENTS.md`);
    assertEq(res.status, 200, "AGENTS.md HTTP status");
    const md = await res.text();
    assert(md.includes("## MCP"), "AGENTS.md has an ## MCP section", "## MCP", md.slice(0, 200));
  });
}

try {
  await main();
} catch (err) {
  // a failing step already printed its own FAIL line; anything else (e.g. the
  // missing-dist fail-fast) must still be reported and counted
  if (failed === 0) {
    failed++;
    console.error(`FAIL  ${String(err.message || err)}`);
  }
} finally {
  killChild();
  clearTimeout(watchdog);
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
