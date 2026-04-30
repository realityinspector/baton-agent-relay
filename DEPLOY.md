# Deploy — Railway

Prereqs: `railway login`, `gh auth status`.

```bash
gh repo create realityinspector/baton-agent-relay --public --license mit --source=. --remote=origin --push

railway init -n baton-alpha
railway add --database redis
railway variables \
  --set "X402_FACILITATOR_URL=https://x402.org/facilitator" \
  --set "X402_NETWORK=base-sepolia" \
  --set "X402_RECEIVING_ADDRESS=0xYOUR_BASE_SEPOLIA_ADDR" \
  --set "NODE_ENV=production"
# Optional dev bypass for testing the post-quota path without on-chain payment:
#   --set "BATON_DEV_BYPASS_TOKEN=$(openssl rand -hex 16)"
railway up
railway domain  # note assigned domain
```

## Smoke test

```bash
URL=https://<assigned>.up.railway.app
curl $URL/healthz
SLUG=$(curl -s -X POST $URL/ | jq -r .slug)
curl -X POST $URL/r/$SLUG -H 'content-type: application/json' \
  -d '{"from":"alice","body":"hi"}'
curl $URL/r/$SLUG/messages.json
```

## Real x402 end-to-end (manual, one-time validation per deploy)

The dev bypass token covers the request flow but never touches the
facilitator. To validate that a real on-chain payment works once:

1. **Set up a base-sepolia wallet** with a small USDC balance (faucet:
   https://faucet.circle.com/, pick base-sepolia, USDC).
2. **Set `X402_RECEIVING_ADDRESS`** to your wallet (or any address you can
   verify receipts on).
3. **Generate the X-PAYMENT header** using a real x402 client. Two options:
   - The TypeScript SDK: https://github.com/coinbase/x402 — use the
     `createPaymentHeader` helper with the `accepts[]` returned in the 402
     body.
   - The Python `x402` CLI (if installed): `x402-pay --network base-sepolia
     --asset USDC --amount 1000 --to <addr>` and copy the resulting header.
4. **Hit the relay**:
   ```bash
   # post 11 messages to a fresh room (10 free + 1 to trigger 402)
   SLUG=$(curl -s -X POST $URL/ | jq -r .slug)
   for i in $(seq 1 10); do
     curl -X POST $URL/r/$SLUG -H 'content-type: application/json' \
       -d "{\"from\":\"a\",\"body\":\"$i\"}" > /dev/null
   done
   # this one returns 402 with accepts[]; capture and sign:
   curl -X POST $URL/r/$SLUG -H 'content-type: application/json' \
     -d '{"from":"a","body":"paid"}'
   # resubmit with X-Payment header from your x402 client:
   curl -X POST $URL/r/$SLUG \
     -H 'content-type: application/json' \
     -H "x-payment: $YOUR_REAL_X402_HEADER" \
     -d '{"from":"a","body":"paid"}'
   # expect 201 + an X-Payment-Response header with the settle tx hash
   ```
5. Confirm the receiving address shows the USDC transfer on
   https://sepolia.basescan.org/address/<your-addr>

This test costs ~0.001 USDC per message after the free quota.

## Custom domain

In the Railway dashboard, Settings → Domains → Add your CNAME target. Point
your DNS at it. The relay reads `PUBLIC_URL` if set; otherwise it falls back
to the request `Host` (works fine without setting it).

## Quick benchmark

```bash
python scripts/bench.py $URL
# 200 posts in ~Xs, p50/p95 latencies
```
