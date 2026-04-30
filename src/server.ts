import express, { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { makeStore, Store, Message, Room } from "./store.js";
import { randomSlug, SLUG_RE } from "./slugs.js";
import { landingHtml, roomHtml, rootAgentsMd, roomAgentsMd } from "./docs.js";
import {
  config as x402Config,
  buildRequirement,
  paymentRequiredBody,
  verifyAndSettle,
} from "./x402.js";

export function createApp(store: Store = makeStore()) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  // 64kb to comfortably cover a 16k body + headers + protocol fields.
  app.use(express.json({ limit: "64kb" }));

  // request log: method path status duration ip ua (truncated)
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on("finish", () => {
      const ua = (req.get("user-agent") || "-").slice(0, 80);
      const ip = req.ip || "-";
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - t0}ms ip=${ip} ua=${JSON.stringify(ua)}`);
    });
    next();
  });

  // never cache the message feed or manuals — message feeds are live and
  // intermediate proxies/CDNs MUST NOT serve stale snapshots.
  app.use((req, res, next) => {
    if (req.path === "/AGENTS.md" || /^\/r\/[^/]+\/(messages(\.json)?|AGENTS\.md)$/.test(req.path)) {
      res.set("cache-control", "no-store, no-cache, must-revalidate, private");
      res.set("pragma", "no-cache");
    }
    next();
  });

  const hostFor = (req: Request) =>
    process.env.PUBLIC_URL?.replace(/\/$/, "") ||
    `${req.protocol}://${req.get("host")}`;

  // Rate limit: shared fixed-window via store.incrRateBucket (Redis when
  // available, in-memory fallback). Window 10s; default cap 30 POSTs per IP
  // per window. Cap is checked per-POST (not on every request) so reads stay
  // unmetered. Cross-replica correct.
  const RATE_WINDOW_SEC = 10;
  const RATE_MAX = Number(process.env.BATON_RATE_MAX || 30);
  async function rateExceeded(ip: string): Promise<boolean> {
    const n = await store.incrRateBucket(`ip:${ip}`, RATE_WINDOW_SEC);
    return n > RATE_MAX;
  }

  // --- landing & root manual ---
  app.get("/", (req, res) => {
    res.type("html").send(landingHtml(hostFor(req), x402Config().freeMessages));
  });
  app.get("/AGENTS.md", (req, res) => {
    res.type("text/markdown; charset=utf-8")
       .send(rootAgentsMd(hostFor(req), x402Config().freeMessages));
  });
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // --- create room ---
  app.post("/", async (req, res) => {
    const isPrivate = req.query.private === "1" || req.query.private === "true";
    const isSigned = req.query.signed === "1" || req.query.signed === "true";
    const isAttest = req.query.attest === "1" || req.query.attest === "true";
    if (isAttest && isSigned)
      return res.status(400).json({ error: "attest_and_signed_are_mutually_exclusive" });
    const secret = isPrivate ? crypto.randomBytes(24).toString("base64url") : undefined;
    const signingKey = isSigned ? crypto.randomBytes(32).toString("base64url") : undefined;

    let slug = "", attempts = 0;
    while (attempts++ < 16) {
      slug = randomSlug();
      try { await store.createRoom(slug, isPrivate, isSigned, isAttest, secret, signingKey); break; }
      catch { slug = ""; }
    }
    if (!slug) return res.status(500).json({ error: "slug_exhausted" });

    // Pre-registered pubkeys (?parties=alice:hex,bob:hex) close the TOFU
    // squat race in attest rooms by locking name → pubkey at room creation.
    if (isAttest && req.query.parties) {
      const partiesStr = String(req.query.parties);
      for (const pair of partiesStr.split(",")) {
        const [name, pk] = pair.split(":");
        if (!name || !pk || !/^[0-9a-f]{64}$/i.test(pk) || name.includes("|") || name.length > 64) {
          return res.status(400).json({ error: "bad_parties", hint: "expected ?parties=name1:hex,name2:hex with 32-byte hex pubkeys" });
        }
        await store.registerOrCheckPubkey(slug, name.trim(), pk.toLowerCase());
      }
    }

    const host = hostFor(req);
    const authNote = isAttest
      ? "attest: every post must include X-Pubkey (ed25519 hex) and X-Signature (ed25519 sig over `${prev_hash}|${prev_id}|${from}|${body}`, hex). Server enforces TOFU: first pubkey seen for a given `from` is locked in for the room. Each message is hash-chained."
      : isSigned
        ? "signed: posts must include X-Signature = HMAC-SHA256(signingKey, `${prev_id}|${from}|${body}`) and header X-Prev-Id = current message count. unsigned posts are rejected. messages are hash-chained."
        : "from is unauthenticated; anyone with this URL can post under any name. use ?signed=1 (shared HMAC) or ?attest=1 (per-party ed25519) for verified authorship.";
    const body: Record<string, unknown> = {
      slug,
      url: `${host}/r/${slug}`,
      agentsUrl: `${host}/r/${slug}/AGENTS.md`,
      messagesUrl: `${host}/r/${slug}/messages`,
      private: isPrivate,
      signed: isSigned,
      attest: isAttest,
      freeMessages: x402Config().freeMessages,
      authNote,
    };
    if (secret) body.secret = secret;
    if (signingKey) body.signingKey = signingKey;
    res.status(201).json(body);
  });

  // --- derive a constrained write capability from a signed-room signingKey ---
  // POST /r/:slug/derive  body: { signingKey, expiresInSec?, maxUses?, fromPrefix? }
  // Returns: { derivedKey, caveats }. Use derivedKey in place of signingKey
  // for HMAC verification on POSTs; server enforces all caveats on each use.
  app.post("/r/:slug/derive", async (req, res) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: "bad_slug" });
    const room = await store.getRoom(slug);
    if (!room || !room.signed) return res.status(404).json({ error: "not_signed_room" });
    const masterKey = await store.getRoomSigningKey(slug);
    if (!masterKey) return res.status(404).json({ error: "no_signing_key" });
    const presented = (req.body || {}).signingKey;
    if (typeof presented !== "string" || presented !== masterKey)
      return res.status(401).json({ error: "must_present_master_signingkey" });

    const expiresInSec = Math.max(0, Number((req.body || {}).expiresInSec || 0) | 0);
    const maxUses = Math.max(0, Number((req.body || {}).maxUses || 0) | 0);
    const fromPrefix = String((req.body || {}).fromPrefix || "");
    if (fromPrefix.length > 64 || fromPrefix.includes("|"))
      return res.status(400).json({ error: "bad_from_prefix" });

    const caveats = {
      master: slug,
      parent: masterKey.slice(0, 8) + "…",
      expires: expiresInSec > 0 ? Date.now() + expiresInSec * 1000 : 0,
      maxUses,
      fromPrefix,
    };
    // Derived key is HMAC of the master over a stable representation of the caveats.
    // Anyone holding the derived key can post within the caveats; the master
    // never appears on the wire after this point.
    const caveatsCanonical = JSON.stringify({ ...caveats, master: slug });
    const derivedKey = "d_" + crypto.createHmac("sha256", masterKey).update(caveatsCanonical).digest("base64url");
    await store.putDerivedKey(derivedKey, caveats);
    res.status(201).json({ derivedKey, caveats });
  });

  // --- room helpers ---
  async function loadRoom(req: Request, res: Response): Promise<{ slug: string } | null> {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) { res.status(400).json({ error: "bad_slug" }); return null; }
    const room = await store.getRoom(slug);
    if (!room) { res.status(404).json({ error: "not_found" }); return null; }
    if (room.private) {
      const auth = req.header("authorization") || "";
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      const secret = await store.getRoomSecret(slug);
      if (!m || !secret || m[1] !== secret) {
        res.status(401).json({ error: "unauthorized" });
        return null;
      }
    }
    return { slug };
  }

  app.get("/r/:slug", async (req, res) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) return res.status(400).send("bad slug");
    const room = await store.getRoom(slug);
    if (!room) return res.status(404).send("not found");
    res.type("html").send(roomHtml(hostFor(req), slug, x402Config().freeMessages));
  });

  app.get("/r/:slug/AGENTS.md", async (req, res) => {
    const slug = req.params.slug;
    if (!SLUG_RE.test(slug)) return res.status(400).send("bad slug");
    const room = await store.getRoom(slug);
    if (!room) return res.status(404).send("not found");
    res.type("text/markdown; charset=utf-8")
       .send(roomAgentsMd(hostFor(req), slug, x402Config().freeMessages));
  });

  // envelope decoration: every message-feed response includes _meta so the
  // API self-describes its trust model (agents reading JSON don't need to
  // also fetch AGENTS.md to know `from` is unauthenticated).
  function envelopeMeta(room: Room) {
    const auth = room.attest ? "ed25519-tofu" : (room.signed ? "hmac-shared" : (room.private ? "bearer-read-only" : "none"));
    return {
      auth,
      fromVerified: room.signed || !!room.attest,
      nonRepudiationBetweenParties: !!room.attest,
      hashChained: room.signed || !!room.attest,
      private: room.private,
      signed: room.signed,
      attest: !!room.attest,
      warning: room.attest
        ? "from is verified by ed25519 sig; pubkey TOFU-locked per-from; messages hash-chained"
        : room.signed
          ? "from is verified by shared HMAC; messages hash-chained; either party can frame the other (no non-repudiation)"
          : "from is client-supplied and NOT verified; anyone with this URL can post under any name",
    };
  }

  app.get("/r/:slug/messages.json", async (req, res) => {
    const ctx = await loadRoom(req, res); if (!ctx) return;
    const room = (await store.getRoom(ctx.slug))!;
    // surface currentPrevHash + currentPrevId in the envelope so stateless
    // signed/attest clients can compute the next signature in one round-trip.
    const currentPrevId = await store.messageCount(ctx.slug);
    const currentPrevHash = await store.lastHash(ctx.slug);
    const since = Number(req.query.since || 0) | 0;
    // Long-poll: ?wait=<sec> blocks until a new message lands or the timeout
    // expires. Eliminates token-linear polling for invocation-shaped agents
    // that want to wake on the next message and exit. Cap at 60s.
    const wait = Math.min(60, Math.max(0, Number(req.query.wait || 0) | 0));
    let messages = await store.listMessages(ctx.slug, since);
    if (messages.length === 0 && wait > 0) {
      messages = await new Promise<Message[]>((resolve) => {
        const t = setTimeout(async () => { unsub(); resolve(await store.listMessages(ctx.slug, since)); }, wait * 1000);
        let unsub = () => {};
        store.subscribe(ctx.slug, (m) => {
          if (m.id > since) { clearTimeout(t); unsub(); resolve([m]); }
        }).then((u) => { unsub = u; });
      });
    }
    res.json({ slug: ctx.slug, _meta: { ...envelopeMeta(room), currentPrevId, currentPrevHash }, messages });
  });

  app.get("/r/:slug/messages", async (req, res) => {
    const ctx = await loadRoom(req, res); if (!ctx) return;
    res.set({
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();
    const room = (await store.getRoom(ctx.slug))!;
    // first event self-describes the channel's trust model
    res.write(`event: meta\ndata: ${JSON.stringify(envelopeMeta(room))}\n\n`);
    // Honor Last-Event-ID per the SSE spec: if a reconnecting client sent it,
    // resume from that point. Falls back to ?since=N for clients that don't
    // forward the header (browsers do automatically; curl does not).
    const lastEventIdHdr = req.header("last-event-id");
    const sinceFromHeader = lastEventIdHdr ? (Number(lastEventIdHdr) | 0) : 0;
    const since = Math.max(sinceFromHeader, Number(req.query.since || 0) | 0);
    const backlog = await store.listMessages(ctx.slug, since);
    // Tag each frame with `id:` so the browser populates Last-Event-ID on
    // reconnect — closes the gap where a SSE consumer dropped a message
    // during a network hiccup.
    for (const m of backlog) res.write(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`);
    const unsub = await store.subscribe(ctx.slug, (m) => {
      res.write(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`);
    });
    const ka = setInterval(() => res.write(`: keepalive\n\n`), 25_000);
    req.on("close", () => { clearInterval(ka); unsub(); });
  });

  // --- post message (with x402 quota) ---
  app.post("/r/:slug", async (req, res) => {
    const ctx = await loadRoom(req, res); if (!ctx) return;
    if (await rateExceeded(req.ip || "anon"))
      return res.status(429).json({ error: "rate_limited" });

    const { from, body, reply_to } = (req.body || {}) as { from?: string; body?: string; reply_to?: number };
    // `from` cannot contain `|` (HMAC canonicalization). Values used for
    // HMAC verify and storage are raw JSON-parsed strings, never normalized.
    if (typeof from !== "string" || from.trim().length === 0 || from.length > 64 || from.includes("|"))
      return res.status(400).json({ error: "bad_from" });
    // 16 KiB body limit — generous for LLM-shaped messages (HANDOFF docs,
    // structured responses, code snippets) but still bounded. JSON parser
    // limit is 32 KiB above; keeping body strictly less leaves headroom for
    // the rest of the JSON envelope.
    if (typeof body !== "string" || body.trim().length === 0 || body.length > 16384)
      return res.status(400).json({ error: "bad_body", limit: 16384, got: typeof body === "string" ? body.length : null });
    if (reply_to !== undefined && (typeof reply_to !== "number" || !Number.isInteger(reply_to) || reply_to < 1))
      return res.status(400).json({ error: "bad_reply_to" });

    const room = (await store.getRoom(ctx.slug))!;
    const cfg = x402Config();
    const count = await store.messageCount(ctx.slug);

    if (reply_to !== undefined && reply_to > count)
      return res.status(400).json({ error: "reply_to_future_message", currentCount: count });

    // Idempotency: if the client sends X-Idempotency-Key (recommended for
    // any retry-on-503 path), the recorded response is replayed verbatim
    // within the TTL window so retries can't double-post. Scope: per-room.
    // TTL: 5 min. Concurrent retries both do work; first to record wins.
    const idemKey = req.header("x-idempotency-key");
    if (idemKey) {
      if (typeof idemKey !== "string" || idemKey.length > 128)
        return res.status(400).json({ error: "bad_idempotency_key" });
      const stored = await store.getIdempotency(ctx.slug, idemKey);
      if (stored) {
        try {
          const replay = JSON.parse(stored);
          res.set("x-baton-idempotent-replay", "true");
          return res.status(replay.status).json(replay.body);
        } catch { /* corrupt entry; fall through and try again */ }
      }
    }

    // Both signed and attest modes use the same canonical input:
    //   `${prev_hash}|${prev_id}|${from}|${body}`
    // Including prev_hash in the signed input means the client-provided
    // signature commits to the chain position, not just the position index —
    // closing the v1 gap where a malicious server could rewrite prev_hash on
    // a single signed-mode message without invalidating the client sig.
    const prevHash = (room.signed || room.attest) ? await store.lastHash(ctx.slug) : "";

    if (room.signed) {
      const prevHdr = req.header("x-prev-id");
      const sigHdr = req.header("x-signature");
      if (!prevHdr || !sigHdr) {
        return res.status(401).json({
          error: "signature_required",
          hint: "?signed=1 room: include X-Prev-Id, X-Signature = hex(HMAC-SHA256(signingKey, `${prev_hash}|${prev_id}|${from}|${body}`)). prev_hash for the first post is the empty string.",
        });
      }
      const prevId = Number(prevHdr) | 0;
      if (prevId !== count) {
        return res.status(409).json({ error: "stale_prev_id", currentPrevId: count, currentPrevHash: prevHash });
      }
      // Allow either the master signingKey OR a derived key with caveats.
      const presented = req.header("x-signing-key-id");
      let effectiveKey: string | null = null;
      if (presented && presented.startsWith("d_")) {
        const cav = await store.getDerivedKey(presented);
        if (!cav) return res.status(401).json({ error: "unknown_derived_key" });
        if (cav.expires > 0 && cav.expires < Date.now())
          return res.status(401).json({ error: "derived_key_expired" });
        if (cav.fromPrefix && !from.startsWith(cav.fromPrefix))
          return res.status(403).json({ error: "from_prefix_violation", required: cav.fromPrefix });
        if (cav.maxUses > 0) {
          const uses = await store.incrDerivedKeyUses(presented);
          if (uses > cav.maxUses) return res.status(401).json({ error: "derived_key_max_uses_exceeded" });
        }
        effectiveKey = presented;
      } else {
        effectiveKey = await store.getRoomSigningKey(ctx.slug);
        if (!effectiveKey) return res.status(500).json({ error: "missing_signing_key" });
      }
      const expected = crypto.createHmac("sha256", effectiveKey!)
        .update(`${prevHash}|${prevId}|${from}|${body}`)
        .digest("hex");
      const ok = sigHdr.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sigHdr, "hex"), Buffer.from(expected, "hex"));
      if (!ok) return res.status(401).json({ error: "bad_signature", hint: "canonical input: `${prev_hash}|${prev_id}|${from}|${body}` (prev_hash is on the latest message; '' for first post)" });
    }

    let attestPubkey = "";
    let attestSig = "";
    if (room.attest) {
      const prevHdr = req.header("x-prev-id");
      const pkHdr = req.header("x-pubkey");
      const sigHdr = req.header("x-signature");
      if (!prevHdr || !pkHdr || !sigHdr) {
        return res.status(401).json({
          error: "attest_headers_required",
          hint: "this room was created with ?attest=1; include X-Prev-Id, X-Pubkey (32 bytes hex), X-Signature (64 bytes hex ed25519 sig over `${prev_hash}|${prev_id}|${from}|${body}`)",
        });
      }
      const prevId = Number(prevHdr) | 0;
      if (prevId !== count) return res.status(409).json({ error: "stale_prev_id", currentPrevId: count, currentPrevHash: prevHash });
      if (!/^[0-9a-f]{64}$/i.test(pkHdr)) return res.status(400).json({ error: "bad_pubkey_hex" });
      if (!/^[0-9a-f]{128}$/i.test(sigHdr)) return res.status(400).json({ error: "bad_signature_hex" });
      // TOFU pubkey lock per-from: first pubkey wins. If parties were
      // pre-registered at room creation (?parties=alice:hex,bob:hex), the
      // pre-registration acts as the "first" — closes the squat race.
      const lockedPk = await store.registerOrCheckPubkey(ctx.slug, from, pkHdr.toLowerCase());
      if (lockedPk !== pkHdr.toLowerCase())
        return res.status(401).json({ error: "pubkey_mismatch", lockedPubkey: lockedPk, hint: "this `from` was first registered (or pre-registered at room creation) with a different pubkey" });
      const canonical = `${prevHash}|${prevId}|${from}|${body}`;
      // Verify ed25519 sig using Node's verify API (raw key import).
      const pkRaw = Buffer.from(pkHdr, "hex");
      // Wrap raw 32-byte pubkey in DER for crypto.createPublicKey
      const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pkRaw]);
      let verified = false;
      try {
        const keyObj = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
        verified = crypto.verify(null, Buffer.from(canonical), keyObj, Buffer.from(sigHdr, "hex"));
      } catch {
        verified = false;
      }
      if (!verified) return res.status(401).json({ error: "bad_signature" });
      attestPubkey = pkHdr.toLowerCase();
      attestSig = sigHdr.toLowerCase();
    }

    if (count >= cfg.freeMessages) {
      const resourceUrl = `${hostFor(req)}/r/${ctx.slug}`;
      const requirement = buildRequirement(
        resourceUrl,
        `Post one message to room ${ctx.slug}`,
      );

      const xPayment = req.header("x-payment");
      if (!xPayment) {
        return res.status(402).json(paymentRequiredBody(
          resourceUrl,
          `Post one message to room ${ctx.slug}`,
        ));
      }
      const result = await verifyAndSettle(xPayment, requirement);
      if (!result.ok) {
        return res.status(402).json({
          ...paymentRequiredBody(resourceUrl, `Post one message to room ${ctx.slug}`),
          error: `payment_required:${result.reason}`,
        });
      }
      const fresh = await store.markPaid(ctx.slug, result.paymentId!);
      if (!fresh) {
        return res.status(402).json({
          ...paymentRequiredBody(resourceUrl, `Post one message to room ${ctx.slug}`),
          error: "payment_required:replay",
        });
      }
      res.set("x-payment-response", Buffer.from(JSON.stringify({
        success: true, transaction: result.paymentId,
      })).toString("base64"));
    }

    // Hash chain: every message in a signed/attest room carries a hash that
    // commits to (prev_hash, id, from, body). Clients can replay the chain
    // to detect server-side reordering or rewriting. v1 trust model still
    // requires trusting the server, but the chain narrows the cheating
    // surface to "rewrite consistently or get caught."
    const id = count + 1;
    const ts = Date.now();
    let prev_hash: string | undefined;
    let hash: string | undefined;
    if (room.signed || room.attest) {
      prev_hash = prevHash; // already loaded once above; reuse
      hash = crypto.createHash("sha256")
        .update(`${prev_hash}|${id}|${from}|${body}`)
        .digest("hex");
    }
    const msgPayload: Omit<Message, "id"> = { from, body, ts };
    if (reply_to !== undefined) msgPayload.reply_to = reply_to;
    if (prev_hash !== undefined) msgPayload.prev_hash = prev_hash;
    if (hash !== undefined) msgPayload.hash = hash;
    if (attestPubkey) msgPayload.pubkey = attestPubkey;
    if (attestSig) msgPayload.sig = attestSig;
    const msg: Message = await store.appendMessage(ctx.slug, msgPayload);
    await store.publish(ctx.slug, msg);

    const remaining = Math.max(0, cfg.freeMessages - (count + 1));
    const respBody: Record<string, unknown> = { ok: true, message: msg, freeMessagesRemaining: remaining };
    if (remaining <= 2) {
      respBody.quotaWarning = remaining === 0
        ? "this was the last free message; subsequent posts require x402 payment"
        : `${remaining} free message(s) remaining before x402 payment is required`;
    }
    if (idemKey) {
      await store.setIdempotency(ctx.slug, idemKey, JSON.stringify({ status: 201, body: respBody }), 300);
    }
    res.status(201).json(respBody);
  });

  // 404 fallthrough
  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  // error handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error("err", err);
    res.status(500).json({ error: "server_error" });
  });

  return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`baton listening on :${port}`);
  });
}
