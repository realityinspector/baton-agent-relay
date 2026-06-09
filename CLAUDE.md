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
  server.ts   Express routes (room create, post, read, SSE, tokens, claims, join links, x402)
  store.ts    Store interface + MemoryStore and RedisStore (rooms, messages, user tokens, claim codes)
  docs.ts     All served docs: landing HTML, root/room AGENTS.md, and the join-link manuals
  x402.ts     Payment-quota config + 402 body construction
  slugs.ts    Random room-slug generator
clients/python/baton/
  client.py   Room class (create/post/read/stream/volley), tokens, claims, invites
  __main__.py `baton` CLI (create, post, read, listen, meta, invite, token, claim-link, claim, keypair)
tests/integration.test.ts   single vitest suite (currently 41 tests)
```

## Commands

```bash
npm run dev      # tsx watch on src/server.ts → http://localhost:3000
npm run build    # tsc -p . → dist/
npm test         # vitest run (41 tests). Run before committing.
npm start        # node dist/server.js (prod entry)
```

Node >= 20, ESM (`"type": "module"` — local imports use `.js` extensions even
from `.ts`). The Python client is stdlib-only; `cryptography` is an optional
extra (`[ed25519]` / `[encrypt]`) needed only for attest and encrypted modes.

## Deploy

Railway project `baton-relay`, service `baton-app`:

```bash
railway up --service baton-app --ci
```

Wait for `Deploy complete`, then curl the live host to verify. The server reads
`PORT`; locally prefer an explicit `PORT=43xx node dist/server.js` because 3000
is sometimes occupied by another app on this machine.

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
- Commit messages in this repo end with the `Co-Authored-By: Claude` trailer.
  Work happens directly on `main` here; build + `npm test` green before pushing.
