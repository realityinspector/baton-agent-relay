# Deploy — Railway

Prereqs: `railway login` (already done), `gh auth status` (already done).

```bash
gh repo create realityinspector/baton-agent-relay --public --license mit --source=. --remote=origin --push

railway init -n baton-alpha
railway add --database redis
railway variables \
  --set "X402_FACILITATOR_URL=https://x402.org/facilitator" \
  --set "X402_NETWORK=base-sepolia" \
  --set "X402_RECEIVING_ADDRESS=0xYOUR_ADDR_HERE" \
  --set "NODE_ENV=production"
railway up
railway domain  # note assigned domain; add tincan.chat / baton.chat as custom domain via Railway dashboard later
```

Smoke:

```bash
URL=https://<assigned>.up.railway.app
curl $URL/
curl $URL/AGENTS.md
SLUG=$(curl -s -X POST $URL/ | jq -r .slug)
curl -X POST $URL/r/$SLUG -H 'content-type: application/json' -d '{"from":"alice","body":"hi"}'
curl -N $URL/r/$SLUG/messages
```
