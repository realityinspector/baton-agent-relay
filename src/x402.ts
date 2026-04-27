// Minimal x402 payment-required helpers. We don't generate payments here;
// we tell the client what to pay, then verify their X-PAYMENT via the facilitator.

export const X402_VERSION = 1;

export type PaymentRequirement = {
  scheme: "exact";
  network: string;
  maxAmountRequired: string; // atomic units (USDC = 6 decimals)
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
};

export type PaymentRequiredBody = {
  x402Version: number;
  error: string;
  accepts: PaymentRequirement[];
};

export function config() {
  return {
    facilitatorUrl: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
    network: process.env.X402_NETWORK || "base-sepolia",
    payTo: process.env.X402_RECEIVING_ADDRESS || "0x0000000000000000000000000000000000000000",
    asset: process.env.X402_ASSET || "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC base-sepolia
    // 0.001 USDC per message after free quota
    pricePerMessage: process.env.X402_PRICE_ATOMIC || "1000",
    freeMessages: Number(process.env.BATON_FREE_MESSAGES || 10),
  };
}

export function buildRequirement(resource: string, description: string): PaymentRequirement {
  const c = config();
  return {
    scheme: "exact",
    network: c.network,
    maxAmountRequired: c.pricePerMessage,
    resource,
    description,
    mimeType: "application/json",
    payTo: c.payTo,
    maxTimeoutSeconds: 60,
    asset: c.asset,
    extra: { name: "USDC", version: "2" },
  };
}

export function paymentRequiredBody(resource: string, description: string): PaymentRequiredBody {
  return {
    x402Version: X402_VERSION,
    error: "payment_required",
    accepts: [buildRequirement(resource, description)],
  };
}

// Verify+settle a presented X-PAYMENT against the facilitator.
// Returns { ok, paymentId } where paymentId is unique-per-payment so we can
// prevent replay (we record it in store.markPaid).
export async function verifyAndSettle(
  xPayment: string,
  requirement: PaymentRequirement
): Promise<{ ok: boolean; paymentId?: string; reason?: string }> {
  const c = config();

  // Dev bypass for testing without an on-chain payment. Enabled only when
  // BATON_DEV_BYPASS_TOKEN is set (alpha/testnet only — never use mainnet).
  // Client sends header: `X-PAYMENT: dev:<token>:<unique-nonce>`.
  const devToken = process.env.BATON_DEV_BYPASS_TOKEN;
  if (devToken && xPayment.startsWith("dev:")) {
    const parts = xPayment.split(":");
    if (parts.length >= 3 && parts[1] === devToken) {
      const nonce = parts.slice(2).join(":") || `auto-${Date.now()}-${Math.random()}`;
      return { ok: true, paymentId: `dev-${nonce}` };
    }
    return { ok: false, reason: "invalid_dev_token" };
  }

  // Pre-check: payload must be base64 JSON with at least scheme/network
  let payload: any;
  try { payload = JSON.parse(Buffer.from(xPayment, "base64").toString("utf8")); }
  catch { return { ok: false, reason: "invalid_payload" }; }

  try {
    const verifyRes = await fetch(`${c.facilitatorUrl}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload: payload,
        paymentRequirements: requirement,
      }),
    });
    if (!verifyRes.ok) return { ok: false, reason: `verify_${verifyRes.status}` };
    const verify = await verifyRes.json() as any;
    if (!verify.isValid) return { ok: false, reason: verify.invalidReason || "invalid" };

    const settleRes = await fetch(`${c.facilitatorUrl}/settle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        x402Version: X402_VERSION,
        paymentPayload: payload,
        paymentRequirements: requirement,
      }),
    });
    if (!settleRes.ok) return { ok: false, reason: `settle_${settleRes.status}` };
    const settle = await settleRes.json() as any;
    if (!settle.success) return { ok: false, reason: settle.errorReason || "settle_failed" };

    const paymentId = settle.transaction || settle.txHash || payload?.payload?.signature || xPayment.slice(0, 32);
    return { ok: true, paymentId };
  } catch (e: any) {
    return { ok: false, reason: `facilitator_error:${e?.message || "unknown"}` };
  }
}
