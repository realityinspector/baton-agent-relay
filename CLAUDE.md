# CLAUDE.md

Guidance for Claude Code (and other agents) working in this repo.

## What Baton is

An HTTP message relay so two (or more) AI agents can talk — different processes,
networks, vendors, trust assumptions. Express/TypeScript server + Redis (ioredis)
or in-memory store, plus a stdlib-only Python client/CLI. No accounts. The whole
thing is meant to be readable in one sitting.

**Live host:** `https://baton-app-production-5eee.up.railway.app`
(the `5eee` host is the live one; an earlier `…-90c3` host was decommissioned —
if you ever see it referenced, it's dead.)

## Layout

```
src/
  server.ts   Express routes (room create, post, read, SSE, tokens, claims, join links, x402, /mcp)
  mcp.ts      Native MCP endpoint (Streamable HTTP JSON-RPC, stateless, 7 tools, loopback dispatch)
  store.ts    Store interface + MemoryStore and RedisStore (rooms, messages, user tokens, claim codes)
  docs.ts     All served docs: landing HTML, live room dashboard, root/room AGENTS.md, join-link manuals
  x402.ts     Payment-quota config + 402 body construction
  slugs.ts    Random room-slug generator
clients/python/baton/
  client.py   Room class (create/post/read/stream/volley), tokens, claims, invites
  __main__.py `baton` CLI (create, post, read, listen, meta, invite, token, claim-link, claim, keypair)
tests/
  integration.test.ts   core HTTP suite
  mcp.test.ts           MCP endpoint suite
  ui.test.ts            served-HTML suite (dashboard, landing, manuals)
  limits.test.ts        abuse/egress guards (read metering, creation caps, SSE caps, robots)
scripts/mcp-e2e.mjs   e2e rig: spawns dist/server.js, drives a real 2-agent MCP conversation
docs/*.svg  Hand-authored explainer diagrams (overview, join-flow,
            trust-modes) embedded in README.md, each with a `-dark.svg`
            variant. See the diagram convention below.
```

## Commands

```bash
npm run dev      # tsx watch on src/server.ts → http://localhost:3000
npm run build    # tsc -p . → dist/
npm test         # vitest run (all suites). Run before committing.
npm run test:e2e # scripts/mcp-e2e.mjs against dist/ — run `npm run build` first
npm start        # node dist/server.js (prod entry)
```

Node >= 20, ESM (`"type": "module"` — local imports use `.js` extensions even
from `.ts`). The Python client is stdlib-only; `cryptography` is an optional
extra (`[ed25519]` / `[encrypt]`) needed only for attest and encrypted modes.

## Deploy

Railway. This repo is public, so the maintainer's project/service names and
every deployed variable value are deliberately kept OUT of the tree — read
them from `railway status` / `railway variables` against your own linked
service, not from a doc:

```bash
railway up --service <your-service> --ci
```

Wait for `Deploy complete`, then curl your host to verify. Note that a
variable change alone does **not** reach the running instance — `railway
redeploy` kept serving the old env in practice; do a real `railway up` after
setting variables, and verify the new value actually took effect rather than
assuming it did. The server reads `PORT`; locally prefer an explicit
`PORT=43xx node dist/server.js` because 3000 is sometimes occupied by another
app on this machine.

## Trust modes (orthogonal — combine except attest+signed)

- **public** — anyone with the URL reads and posts under any name.
- **`?private=1`** — bearer secret. Supports **per-user tokens** (`u_…`, minted
  by the master secret, each individually revocable via token or non-secret
  `h_…` handle) and **owner-blind claim codes** (`c_…`, guest registers only
  `sha256(token)` so the owner never sees it).
- **`?signed=1`** — HMAC-SHA256 over `prev_hash|prev_id|from|body`, hash-chained.
- **`?attest=1`** — per-party ed25519 + TOFU pubkey lock; third-party verifiable.
- **`?encrypted=1`** — E2E AES-256-GCM. Wire format `enc:v1:base64url(nonce[12]+GCM(pt, aad=from))`.
  Relay stores only ciphertext and rejects plaintext bodies. For join links the
  key rides in the URL `#k=` fragment, which clients don't transmit, so the
  relay never sees it.

## Join links (the headline UX)

`GET /j/:slug/:token` returns a self-contained markdown manual (built in
`docs.ts` → `joinManual` / `joinManualEncrypted`) with the key embedded and
plain-`curl` read/post instructions. **Reads default to SSE** (`curl -sN
.../messages?since=0`); long-poll is the documented fallback. The manual states
the free-post quota up front. Send one URL, the other agent talks — zero install.
Revoking the token makes the link 404.

## Conventions / gotchas

- There is **no delete-room API.** "Drop/scrap a room" = revoke all its
  credentials (tokens + burn claim codes), leaving an inert shell.
- Baton is **not on PyPI.** `pip install baton` grabs an unrelated genomics
  package; the correct install is the `git+…#subdirectory=clients/python` URL.
- The Python client's `_request` must set `Content-Type: application/json` on any
  body or `express.json()` silently drops it (this bit us once — labels vanished).
- `Room.post` uses the kwarg `from_` (trailing underscore), not `from`/`frm`.
- When you change anything in `docs.ts`, the manuals are served live — rebuild
  and redeploy so the hosted manual matches, and add/adjust a test asserting the
  served text.
- Keep `README.md`, `QUICKSTART.md`, `AGENTS.md`, and `clients/python/README.md`
  in sync when you add a feature; the served root manual lives in `docs.ts`
  (`rootAgentsMd`), separate from the repo-root `AGENTS.md`.
- **Two tiers, one host** — `BATON_POWER_KEYS` (comma-separated) turns a
  deployment into a public relay *and* a power-user relay. Key travels in the
  `X-Baton-Key` header (never a query string — the request logger writes full
  URLs). Rooms are **stamped** `tier: "free" | "power"` at creation and the
  stamp is authoritative for in-room limits (body cap, quota, SSE lifetime),
  so join-link guests inherit power without the key and a key never upgrades
  someone else's room. The key itself governs creation caps and read metering.
  Power overrides are `BATON_POWER_*` (see DEPLOY.md); `tests/tiers.test.ts`
  owns the coverage. Note `x402Config()` reads `BATON_FREE_MESSAGES` lazily
  per-request, so a test harness must hold env for the server's lifetime, not
  just across `createApp()`.
- **Abuse guards are env knobs** — `BATON_READ_RATE_MAX`,
  `BATON_CREATES_PER_HOUR_PER_IP`, `BATON_CREATES_PER_DAY_GLOBAL`,
  `BATON_CREATE_SECRET` (operator-only creation), `BATON_MAX_BODY_BYTES`,
  `BATON_SSE_MAX_PER_IP` / `BATON_SSE_MAX_GLOBAL` / `BATON_SSE_MAX_SEC`.
  The three functional suites raise them sky-high in `beforeAll`
  (`tests/limits.test.ts` owns tight-value coverage); any NEW suite must copy
  that env-raise block or it will trip 429s. The live host runs locked-down
  values set as Railway service variables — mirror doc changes in DEPLOY.md.
- **MCP tools use loopback dispatch** — each tool makes a real HTTP call to the
  same server (`http://127.0.0.1:<port>`) and rewrites the base URL to the
  public host in responses. So route changes (auth, quota, validation)
  propagate to MCP automatically; there is no duplicated room logic to update.
  But keep the 7-tool list in the docs (README, AGENTS.md ×2, QUICKSTART,
  landing page) in sync whenever tools change.
- **Diagrams:** `docs/*.svg` are hand-authored (plain shapes/text, no external
  fonts/scripts so GitHub renders them inline). Each light SVG has a `-dark.svg`
  twin generated by a role-based color map; README embeds both via `<picture>` +
  `prefers-color-scheme`. The overview SVG is *also* inlined into `landingHtml`
  in `docs.ts` (responsive `.diagram` class) — if you edit `docs/overview.svg`,
  update that inline copy too. Validate with `cairosvg <f> -o <png>` before commit.
- Commit messages in this repo end with the `Co-Authored-By: Claude` trailer.
  Work happens directly on `main` here; build + `npm test` green before pushing.
