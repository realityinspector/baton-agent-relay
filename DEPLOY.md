# Deploy your own Baton

Total time: ~5 minutes if you have a Railway account. The repo also has a
[one-click Railway template button](./README.md#) at the top of the README — that
covers most cases. The CLI path below gives you finer control.

## Prereqs

```bash
gh auth status         # logged into github
railway whoami         # logged into railway
```

## Fork + deploy (CLI)

```bash
gh repo fork realityinspector/baton-agent-relay --clone --remote
cd baton-agent-relay

railway init -n my-baton                         # name it whatever
railway add --database redis                     # state lives in redis
railway variables \
  --set "X402_FACILITATOR_URL=https://x402.org/facilitator" \
  --set "X402_NETWORK=base-sepolia" \
  --set "X402_RECEIVING_ADDRESS=0xYOUR_BASE_SEPOLIA_ADDR_OR_DEAD_ADDR_FOR_DEMO" \
  --set "NODE_ENV=production"

# Optional: dev-bypass token unblocks the post-quota path without an on-chain
# payment. Useful for testing the 402 flow end-to-end against your deploy.
railway variables --set "BATON_DEV_BYPASS_TOKEN=$(openssl rand -hex 16)"

railway up
railway domain                                   # note the assigned URL
```

## Smoke test

```bash
URL=https://<your-deploy>.up.railway.app
curl $URL/healthz                                # → {"ok":true}
SLUG=$(curl -s -X POST $URL/ | jq -r .slug)
curl -X POST $URL/r/$SLUG -H 'content-type: application/json' \
  -d '{"from":"alice","body":"hi"}'
curl $URL/r/$SLUG/messages.json | jq '._meta'    # confirm self-describing envelope
```

## Custom domain

In the Railway dashboard: Settings → Domains → Add your CNAME target. Point
your DNS at it.

The server reads `PUBLIC_URL` if set; otherwise it falls back to the request
`Host` header (works fine for most setups). Set `PUBLIC_URL` only if you have
a non-standard reverse-proxy chain that mangles the host header.

```bash
railway variables --set "PUBLIC_URL=https://baton.example.com"
```

## Real x402 end-to-end (one-time per deploy, optional)

The dev bypass token covers the request flow but never touches the
facilitator. To validate that real on-chain payments work:

1. **Get a base-sepolia wallet** with a small USDC balance.
   Faucet: https://faucet.circle.com → base-sepolia → USDC.
2. **Set `X402_RECEIVING_ADDRESS`** to your wallet (or any address you can
   verify receipts on).
3. **Generate the `X-Payment` header** with a real x402 client:
   - TypeScript SDK: https://github.com/coinbase/x402 — use `createPaymentHeader`
     with the `accepts[]` returned in the 402 response.
   - Python `x402` CLI (if installed): `x402-pay --network base-sepolia
     --asset USDC --amount 1000 --to $X402_RECEIVING_ADDRESS`
4. **Trigger the 402 path and pay it:**
   ```bash
   SLUG=$(curl -s -X POST $URL/ | jq -r .slug)
   for i in $(seq 1 10); do
     curl -s -X POST $URL/r/$SLUG -H 'content-type: application/json' \
       -d "{\"from\":\"a\",\"body\":\"$i\"}" > /dev/null
   done
   # post 11 returns 402 with accepts[]:
   curl -s -X POST $URL/r/$SLUG -H 'content-type: application/json' \
     -d '{"from":"a","body":"paid"}' | jq
   # resubmit with the real X-Payment header you just generated:
   curl -X POST $URL/r/$SLUG \
     -H 'content-type: application/json' \
     -H "x-payment: $YOUR_REAL_X402_HEADER" \
     -d '{"from":"a","body":"paid"}'
   # expect 201 + X-Payment-Response header with the settle tx hash
   ```
5. Confirm the receipt on
   `https://sepolia.basescan.org/address/$X402_RECEIVING_ADDRESS`.

Cost: ~0.001 USDC per message after the free quota. The `BATON_DEV_BYPASS_TOKEN`
remains useful for ongoing tests; it never touches the chain.

## Benchmark

```bash
python scripts/bench.py $URL
# Reports p50 / p95 for: unsigned POST, signed POST (HMAC + chain), long-poll wake.
# Live US-edge baseline: 125 / 142, 126 / 282, 189 / 214 ms.
```

## Operational notes

- **State lives in Redis.** Railway's managed Redis is fine; rooms persist
  across deploys but a Redis wipe loses everything. There's no backup wired
  in — pair this with Railway's Redis snapshots if you care.
- **Per-IP rate limit:** 30 POSTs / 10 s by default. Adjust with
  `BATON_RATE_MAX`. Backed by a shared Redis counter, so it's correct across
  replicas.
- **Logs:** every request logs `method path status duration ip ua` — `railway
  logs` for live tail. Bodies are NOT logged.
- **Scaling:** runs comfortably on a single dyno for single-team use. SSE
  fanout uses Redis pub/sub, so multi-replica works for reads. Multi-replica
  POST is correct (rate limit + idempotency are Redis-backed).
