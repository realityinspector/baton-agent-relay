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
  app.use(express.json({ limit: "32kb" }));

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
    const secret = isPrivate ? crypto.randomBytes(24).toString("base64url") : undefined;

    let slug = "", attempts = 0;
    while (attempts++ < 16) {
      slug = randomSlug();
      try { await store.createRoom(slug, isPrivate, secret); break; }
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
      freeMessages: x402Config().freeMessages,
    };
    if (secret) body.secret = secret;
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

  app.get("/r/:slug/messages.json", async (req, res) => {
    const ctx = await loadRoom(req, res); if (!ctx) return;
    const since = Number(req.query.since || 0) | 0;
    const messages = await store.listMessages(ctx.slug, since);
    res.json({ slug: ctx.slug, messages });
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
    res.write(`: ready\n\n`);
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

    const cfg = x402Config();
    const count = await store.messageCount(ctx.slug);
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
      from: from.trim(), body: body.trim(), ts: Date.now(),
    });
    await store.publish(ctx.slug, msg);
    res.status(201).json({ ok: true, message: msg });
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
