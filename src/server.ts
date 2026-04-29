import express, { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import { makeStore, Store, Message } from "./store.js";
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
  app.use(express.json({ limit: "32kb" }));

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

  const RATE_WINDOW_MS = 10_000;
  const RATE_MAX = Number(process.env.BATON_RATE_MAX || 30);
  const rate = new Map<string, { n: number; t: number }>();
  app.use((req, _res, next) => {
    const ip = req.ip || "anon";
    const now = Date.now();
    const e = rate.get(ip);
    if (!e || now - e.t > RATE_WINDOW_MS) rate.set(ip, { n: 1, t: now });
    else e.n++;
    next();
  });
  function rateExceeded(ip: string) {
    const e = rate.get(ip);
    return !!e && Date.now() - e.t < RATE_WINDOW_MS && e.n > RATE_MAX;
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
    const secret = isPrivate ? crypto.randomBytes(24).toString("base64url") : undefined;
    const signingKey = isSigned ? crypto.randomBytes(32).toString("base64url") : undefined;

    let slug = "", attempts = 0;
    while (attempts++ < 16) {
      slug = randomSlug();
      try { await store.createRoom(slug, isPrivate, isSigned, secret, signingKey); break; }
      catch { slug = ""; }
    }
    if (!slug) return res.status(500).json({ error: "slug_exhausted" });

    const host = hostFor(req);
    const body: Record<string, unknown> = {
      slug,
      url: `${host}/r/${slug}`,
      agentsUrl: `${host}/r/${slug}/AGENTS.md`,
      messagesUrl: `${host}/r/${slug}/messages`,
      private: isPrivate,
      signed: isSigned,
      freeMessages: x402Config().freeMessages,
      authNote: isSigned
        ? "signed: posts must include X-Signature = HMAC-SHA256(signingKey, `${prev_id}|${from}|${body}`) and header X-Prev-Id = current message count. unsigned posts are rejected."
        : "from is unauthenticated; anyone with this URL can post under any name. use ?signed=1 for HMAC-verified posts.",
    };
    if (secret) body.secret = secret;
    if (signingKey) body.signingKey = signingKey;
    res.status(201).json(body);
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
  function envelopeMeta(room: { slug: string; private: boolean; signed: boolean }) {
    return {
      auth: room.signed ? "hmac" : (room.private ? "bearer-read-only" : "none"),
      fromVerified: room.signed,
      private: room.private,
      signed: room.signed,
      warning: room.signed
        ? "from field is verified by HMAC over (prev_id|from|body); message ordering is enforced"
        : "from field is client-supplied and NOT verified; anyone with this URL can post under any name",
    };
  }

  app.get("/r/:slug/messages.json", async (req, res) => {
    const ctx = await loadRoom(req, res); if (!ctx) return;
    const room = (await store.getRoom(ctx.slug))!;
    const since = Number(req.query.since || 0) | 0;
    const messages = await store.listMessages(ctx.slug, since);
    res.json({ slug: ctx.slug, _meta: envelopeMeta(room), messages });
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
    const since = Number(req.query.since || 0) | 0;
    const backlog = await store.listMessages(ctx.slug, since);
    for (const m of backlog) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    const unsub = await store.subscribe(ctx.slug, (m) => {
      res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
    });
    const ka = setInterval(() => res.write(`: keepalive\n\n`), 25_000);
    req.on("close", () => { clearInterval(ka); unsub(); });
  });

  // --- post message (with x402 quota) ---
  app.post("/r/:slug", async (req, res) => {
    const ctx = await loadRoom(req, res); if (!ctx) return;
    if (rateExceeded(req.ip || "anon"))
      return res.status(429).json({ error: "rate_limited" });

    const { from, body } = (req.body || {}) as { from?: string; body?: string };
    if (typeof from !== "string" || !from.trim() || from.length > 64)
      return res.status(400).json({ error: "bad_from" });
    if (typeof body !== "string" || !body.trim() || body.length > 4096)
      return res.status(400).json({ error: "bad_body" });
    const fromTrim = from.trim();
    const bodyTrim = body.trim();

    const room = (await store.getRoom(ctx.slug))!;
    const cfg = x402Config();
    const count = await store.messageCount(ctx.slug);

    // Signed-room HMAC verification. Client must send:
    //   X-Prev-Id:    current message count (= id of last message, 0 if none)
    //   X-Signature:  hex(HMAC_SHA256(signingKey, `${prev_id}|${from}|${body}`))
    // Mismatch on prev_id -> 409 (concurrent write); mismatch on sig -> 401.
    if (room.signed) {
      const prevHdr = req.header("x-prev-id");
      const sigHdr = req.header("x-signature");
      if (!prevHdr || !sigHdr) {
        return res.status(401).json({
          error: "signature_required",
          hint: "this room was created with ?signed=1; include X-Prev-Id and X-Signature headers",
        });
      }
      const prevId = Number(prevHdr) | 0;
      if (prevId !== count) {
        return res.status(409).json({ error: "stale_prev_id", currentPrevId: count });
      }
      const key = await store.getRoomSigningKey(ctx.slug);
      if (!key) return res.status(500).json({ error: "missing_signing_key" });
      const expected = crypto.createHmac("sha256", key)
        .update(`${prevId}|${fromTrim}|${bodyTrim}`)
        .digest("hex");
      const ok = sigHdr.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sigHdr, "hex"), Buffer.from(expected, "hex"));
      if (!ok) return res.status(401).json({ error: "bad_signature" });
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

    const msg: Message = await store.appendMessage(ctx.slug, {
      from: fromTrim, body: bodyTrim, ts: Date.now(),
    });
    await store.publish(ctx.slug, msg);
    const remaining = Math.max(0, cfg.freeMessages - (count + 1));
    const respBody: Record<string, unknown> = { ok: true, message: msg, freeMessagesRemaining: remaining };
    if (remaining <= 2) {
      respBody.quotaWarning = remaining === 0
        ? "this was the last free message; subsequent posts require x402 payment"
        : `${remaining} free message(s) remaining before x402 payment is required`;
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
