// MCP endpoint tests: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
// Same harness as integration.test.ts — real HTTP against a live listener.
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

// One JSON-RPC round-trip. Returns { status, body } — body is null on 202
// (notification acks have an empty body).
let nextId = 1;
async function rpc(method: string, params?: unknown, id: number | string = nextId++) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

// Call a tool, return the MCP tool result ({ content, isError? }).
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const { status, body } = await rpc("tools/call", { name, arguments: args });
  expect(status).toBe(200);
  expect(body.error).toBeUndefined();
  return body.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
}

// Parse a successful tool result's text back into JSON.
async function callToolJson(name: string, args: Record<string, unknown> = {}) {
  const result = await callTool(name, args);
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

describe("MCP handshake & lifecycle", () => {
  it("initialize returns serverInfo, capabilities, instructions; echoes a supported protocolVersion", async () => {
    const { status, body } = await rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(status).toBe(200);
    expect(body.jsonrpc).toBe("2.0");
    const r = body.result;
    expect(r.protocolVersion).toBe("2025-03-26"); // echoed, not upgraded
    expect(r.capabilities.tools).toEqual({ listChanged: false });
    expect(r.serverInfo).toEqual({ name: "baton", version: "0.2.0" });
    expect(r.instructions.toLowerCase()).toContain("untrusted");
    expect(r.instructions).toContain("402");
  });

  it("initialize falls back to the latest protocolVersion for unknown requests", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("notifications (no id) are acknowledged with 202 and an empty body", async () => {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("ping returns an empty result", async () => {
    const { status, body } = await rpc("ping");
    expect(status).toBe(200);
    expect(body.result).toEqual({});
  });
});

describe("MCP protocol errors", () => {
  it("unknown method with id → -32601 over HTTP 200", async () => {
    const { status, body } = await rpc("resources/list");
    expect(status).toBe(200);
    expect(body.error.code).toBe(-32601);
  });

  // A parseable POST must NEVER get an HTTP 4xx — clients treat 4xx on POST
  // as a legacy HTTP+SSE server and start GET-probing. Protocol errors ride
  // in a JSON-RPC error object over HTTP 200.
  it("batch arrays are rejected with -32600 over HTTP 200", async () => {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toMatch(/batching not supported/);
    expect(body.id).toBe(null);
  });

  it("malformed request (wrong jsonrpc version) → -32600 over HTTP 200", async () => {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).error.code).toBe(-32600);
  });

  it("accepts an absent or valid MCP-Protocol-Version header", async () => {
    for (const header of [undefined, "2025-03-26"]) {
      const r = await fetch(base + "/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(header ? { "mcp-protocol-version": header } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(r.status).toBe(200);
      expect((await r.json()).result).toEqual({});
    }
  });

  it("rejects a garbage MCP-Protocol-Version header with 400, per spec", async () => {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "not-a-version" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe(-32600);
  });

  it("unparseable JSON → -32700 Parse error over HTTP 200", async () => {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.error.code).toBe(-32700);
    expect(body.id).toBe(null);
  });

  it("a client-POSTed JSON-RPC *response* is accepted with 202 and no body", async () => {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, result: {} }),
    });
    expect(r.status).toBe(202);
    expect(await r.text()).toBe("");
  });

  it("browser Origins are validated: foreign → 403, own host → allowed, absent → allowed", async () => {
    const evil = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(evil.status).toBe(403);
    const own = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(own.status).toBe(200);
  });

  it("GET and DELETE /mcp → 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await fetch(base + "/mcp", { method });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
  });
});

describe("tools/list", () => {
  it("lists exactly the 7 baton tools, each with an object inputSchema", async () => {
    const { body } = await rpc("tools/list");
    const tools = body.result.tools;
    expect(tools.map((t: any) => t.name).sort()).toEqual([
      "baton_create_room",
      "baton_mint_token",
      "baton_open_join_link",
      "baton_post_message",
      "baton_read_messages",
      "baton_room_info",
      "baton_wait_for_message",
    ]);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect(t.inputSchema.type).toBe("object");
      expect(t.inputSchema.properties).toBeDefined();
      expect(Array.isArray(t.inputSchema.required)).toBe(true);
    }
  });
});

describe("public room flow via tools", () => {
  it("create → post → read → room_info", async () => {
    const room = await callToolJson("baton_create_room");
    expect(room.slug).toMatch(/^[a-z]+-[a-z]+-\d{2}$/);
    expect(room.private).toBe(false);
    // URL rewriting: the loopback base and the public base are the same host
    // here, so assert the exact public form.
    expect(room.url).toBe(`${base}/r/${room.slug}`);

    const posted = await callToolJson("baton_post_message", {
      room: room.slug, from: "alice", body: "hello from mcp",
    });
    expect(posted.ok).toBe(true);
    expect(posted.message.id).toBe(1);
    expect(typeof posted.freeMessagesRemaining).toBe("number");

    // room accepts a full room URL too
    const read = await callToolJson("baton_read_messages", { room: room.url });
    expect(read.messages.length).toBe(1);
    expect(read.messages[0].body).toBe("hello from mcp");
    expect(read.messages[0].from).toBe("alice");
    // _meta passes through untouched — trust model self-description survives
    expect(read._meta.auth).toBe("none");
    expect(read._meta.fromVerified).toBe(false);
    expect(read._meta.warning).toMatch(/not verified/i);

    const info = await callToolJson("baton_room_info", { room: room.slug });
    expect(info.slug).toBe(room.slug);
    expect(info.messageCount).toBe(1);
    expect(info._meta.auth).toBe("none");
    expect(info.messages).toBeUndefined(); // info returns no bodies
  });

  it("read_messages honors since", async () => {
    const room = await callToolJson("baton_create_room");
    await callToolJson("baton_post_message", { room: room.slug, from: "a", body: "one" });
    await callToolJson("baton_post_message", { room: room.slug, from: "a", body: "two" });
    const read = await callToolJson("baton_read_messages", { room: room.slug, since: 1 });
    expect(read.messages.length).toBe(1);
    expect(read.messages[0].body).toBe("two");
  });

  it("reply_to passes through and is validated", async () => {
    const room = await callToolJson("baton_create_room");
    await callToolJson("baton_post_message", { room: room.slug, from: "a", body: "first" });
    const reply = await callToolJson("baton_post_message", {
      room: room.slug, from: "b", body: "reply", reply_to: 1,
    });
    expect(reply.message.reply_to).toBe(1);
    // future reply_to is a tool error carrying the server's hint, not a crash
    const bad = await callTool("baton_post_message", {
      room: room.slug, from: "b", body: "future", reply_to: 99,
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("reply_to_future_message");
  });

  it("missing required args and wrong-typed args → JSON-RPC -32602 (HTTP 200)", async () => {
    // missing required `room`
    const noRoom = await rpc("tools/call", { name: "baton_post_message", arguments: { from: "a", body: "x" } });
    expect(noRoom.status).toBe(200);
    expect(noRoom.body.error.code).toBe(-32602);
    expect(noRoom.body.error.message).toMatch(/room/);
    // wrong type: room as number
    const wrongType = await rpc("tools/call", { name: "baton_read_messages", arguments: { room: 42 } });
    expect(wrongType.status).toBe(200);
    expect(wrongType.body.error.code).toBe(-32602);
    // wrong type on an optional arg: since as string
    const wrongOpt = await rpc("tools/call", { name: "baton_read_messages", arguments: { room: "blue-fox-42", since: "0" } });
    expect(wrongOpt.body.error.code).toBe(-32602);
  });

  it("well-formed-but-wrong values are tool errors (isError), not JSON-RPC errors", async () => {
    // right type, unparseable room reference
    const badRef = await callTool("baton_read_messages", { room: "NOT A SLUG!!" });
    expect(badRef.isError).toBe(true);
    // valid slug shape, room doesn't exist → the 404 surfaces as isError
    const missing = await callTool("baton_read_messages", { room: "never-was-99" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("404");
  });

  it("unknown tool name → JSON-RPC -32602 (HTTP 200)", async () => {
    const { status, body } = await rpc("tools/call", { name: "baton_delete_room", arguments: {} });
    expect(status).toBe(200);
    expect(body.error.code).toBe(-32602);
  });
});

describe("wait_for_message (long-poll via tool)", () => {
  it("blocks, then resolves when a message lands via plain HTTP", async () => {
    const room = await callToolJson("baton_create_room");
    const t0 = Date.now();
    const wait = callToolJson("baton_wait_for_message", {
      room: room.slug, since: 0, timeout_sec: 5,
    });
    setTimeout(() => {
      fetch(`${base}/r/${room.slug}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "http-agent", body: "wake up, mcp" }),
      });
    }, 300);
    const result = await wait;
    const elapsed = Date.now() - t0;
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].body).toBe("wake up, mcp");
    expect(elapsed).toBeGreaterThan(250);  // actually waited
    expect(elapsed).toBeLessThan(5000);    // resolved before timeout
  });

  it("times out with an empty list when nothing arrives", async () => {
    const room = await callToolJson("baton_create_room");
    const t0 = Date.now();
    const result = await callToolJson("baton_wait_for_message", {
      room: room.slug, since: 0, timeout_sec: 1,
    });
    expect(result.messages.length).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
  });
});

describe("private room flow via tools", () => {
  it("token gating, mint_token, and join links round-trip", async () => {
    const room = await callToolJson("baton_create_room", { private: true });
    expect(room.private).toBe(true);
    expect(typeof room.secret).toBe("string");
    expect(room.tokensUrl).toBe(`${base}/r/${room.slug}/tokens`); // rewritten URL

    // post without a token → tool error surfacing the 401
    const denied = await callTool("baton_post_message", {
      room: room.slug, from: "a", body: "knock knock",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("401");

    // mint a per-user token with the master secret
    const mint = await callToolJson("baton_mint_token", {
      room: room.slug, secret: room.secret, label: "guest",
    });
    expect(mint.token).toMatch(/^u_/);
    expect(mint.label).toBe("guest");
    expect(mint.joinUrl).toBe(`${base}/j/${room.slug}/${mint.token}`); // rewritten URL

    // token unlocks posting
    const posted = await callToolJson("baton_post_message", {
      room: room.slug, from: "guest", body: "hello", token: mint.token,
    });
    expect(posted.ok).toBe(true);

    // open the join link → same slug + token, ready for the other tools
    const opened = await callToolJson("baton_open_join_link", { url: mint.joinUrl });
    expect(opened.slug).toBe(room.slug);
    expect(opened.token).toBe(mint.token);
    expect(opened.roomUrl).toBe(`${base}/r/${room.slug}`);

    // a join-URL `room` reference carries its own token — no explicit token arg
    const read = await callToolJson("baton_read_messages", { room: mint.joinUrl });
    expect(read.messages.length).toBe(1);
    expect(read.messages[0].body).toBe("hello");

    // …but an explicit token argument wins over the embedded one
    const badExplicit = await callTool("baton_read_messages", {
      room: mint.joinUrl, token: "u_totally-bogus",
    });
    expect(badExplicit.isError).toBe(true);

    // garbage token in a join link → isError
    const bogus = await callTool("baton_open_join_link", {
      url: `${base}/j/${room.slug}/u_not-a-real-token`,
    });
    expect(bogus.isError).toBe(true);
    expect(bogus.content[0].text).toMatch(/invalid or revoked join link/);

    // wrong secret can't mint
    const badMint = await callTool("baton_mint_token", {
      room: room.slug, secret: "nope", label: "x",
    });
    expect(badMint.isError).toBe(true);
    expect(badMint.content[0].text).toContain("401");
  });
});

describe("hardening (adversarial-review regressions)", () => {
  it("a /j/ join link smuggled into a room URL's query cannot hijack the reference", async () => {
    const room = await callToolJson("baton_create_room");
    await callToolJson("baton_post_message", { room: room.slug, from: "a", body: "legit" });
    const evilRef = `${base}/r/${room.slug}?ref=/j/red-cat-11/u_evil`;
    const read = await callToolJson("baton_read_messages", { room: evilRef });
    expect(read.slug).toBe(room.slug);
    expect(read.messages[0].body).toBe("legit");
  });

  it("message bodies containing the loopback base survive URL rewriting verbatim", async () => {
    process.env.PUBLIC_URL = "https://public.example";
    try {
      const room = await callToolJson("baton_create_room");
      // server-generated URLs are public…
      expect(room.url).toBe(`https://public.example/r/${room.slug}`);
      // …but relayed message content is never rewritten
      const tricky = `see ${base}/r/other-room-11 for context`;
      await callToolJson("baton_post_message", { room: room.slug, from: "a", body: tricky });
      const read = await callToolJson("baton_read_messages", { room: room.slug });
      expect(read.messages[0].body).toBe(tricky);
    } finally {
      delete process.env.PUBLIC_URL;
    }
  });
});
