import { useEffect, useState } from "preact/hooks";

/**
 * The thank-you page block. It reads the order with the checkout token
 * Shopify gives the extension: order ids are sequential, so the API answers
 * only a caller holding the order's checkout token.
 *
 * It shows what the API returns:
 *  - while the webhook is on its way: "preparing your payment" (404 pending);
 *  - OPEN: the EUR total, the exact USDC figure, the address, a QR of the
 *    EIP-681 URI, the chain, and how long the request stays open;
 *  - PAID: the payment was seen; the order is being marked paid;
 *  - EXPIRED / CANCELLED: the request closed, with the pay link still shown
 *    so the buyer can reach the merchant's page.
 * It computes no amounts and shows "paid" only after the API does, since the
 * API marks the order paid in Shopify.
 */
const POLL_MS = 4000;
const PENDING_GIVE_UP_MS = 90_000;

function numericId(gid) {
  const m = /(\d+)$/.exec(String(gid ?? ""));
  return m ? m[1] : undefined;
}

export function ZoldPay({ orderId, checkoutToken, shop, apiBase }) {
  const [state, setState] = useState({ phase: "loading" });
  const id = numericId(orderId);
  const base = String(apiBase ?? "").replace(/\/$/, "");

  useEffect(() => {
    if (!id || !checkoutToken || !shop || !base) {
      setState({ phase: "unconfigured" });
      return;
    }
    let stop = false;
    const startedAt = Date.now();
    const tick = async () => {
      try {
        const res = await fetch(`${base}/api/shopify/orders/${encodeURIComponent(shop)}/${id}?t=${encodeURIComponent(checkoutToken)}`, { headers: { accept: "application/json" } });
        if (res.status === 404) {
          const body = await res.json().catch(() => ({}));
          if (body.pending && Date.now() - startedAt < PENDING_GIVE_UP_MS) {
            setState({ phase: "pending" });
            return true;
          }
          setState({ phase: "none" });
          return false;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const r = await res.json();
        setState({ phase: "ready", r });
        return r.state === "OPEN";
      } catch (err) {
        setState((s) => (s.phase === "ready" ? s : { phase: "error", message: String(err?.message ?? err) }));
        return true;
      }
    };
    const loop = async () => {
      while (!stop) {
        const again = await tick();
        if (!again) break;
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    };
    loop();
    return () => {
      stop = true;
    };
  }, [id, checkoutToken, shop, base]);

  if (state.phase === "unconfigured") return null;
  if (state.phase === "pending" || state.phase === "loading") {
    return (
      <s-stack gap="base">
        <s-heading>Pay with Zold</s-heading>
        <s-text>Preparing your payment…</s-text>
        <s-skeleton-paragraph />
      </s-stack>
    );
  }
  if (state.phase === "none") {
    return (
      <s-banner tone="info" heading="Pay with Zold">
        This order's payment page is not ready yet. The link in your order confirmation email opens it once it is.
      </s-banner>
    );
  }
  if (state.phase === "error") {
    return (
      <s-banner tone="warning" heading="Pay with Zold">
        Could not load the payment right now ({state.message}). Use the link in your order confirmation email.
      </s-banner>
    );
  }

  const r = state.r;
  const c = r.methods?.crypto;
  const eur = typeof r.amountEur === "number" ? `€${r.amountEur.toFixed(2)}` : "";
  const name = r.orderName ? `Order ${r.orderName}` : "Your order";
  // After a partial payment the crypto quote is for what is still owed.
  const due = typeof r.outstandingEur === "number" ? `€${r.outstandingEur.toFixed(2)}` : eur;

  if (r.state === "PAID") {
    return (
      <s-banner tone="success" heading={`${name} — payment received`}>
        Your payment of {eur} was seen on chain and the order is being marked paid. Keep this page for your records.
      </s-banner>
    );
  }
  if (r.state !== "OPEN") {
    return (
      <s-banner tone="critical" heading={`${name} — payment window closed`}>
        This payment request is {String(r.state).toLowerCase()}. If you have already sent funds, contact the store with your transaction. <s-link href={r.pageUrl} target="_blank">Open the payment page</s-link>
      </s-banner>
    );
  }
  if (!c) {
    return (
      <s-banner tone="warning" heading={`${name} — pay with Zold`}>
        Crypto payment cannot be quoted right now. <s-link href={r.pageUrl} target="_blank">Open the payment page</s-link> to try again.
      </s-banner>
    );
  }

  const usdc = typeof c.amountUsdc === "number" ? c.amountUsdc.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : undefined;
  const validUntil = c.validUntil ? new Date(c.validUntil) : undefined;
  const expires = r.expiresAt ? new Date(r.expiresAt) : undefined;

  return (
    <s-box border="base" borderRadius="base" padding="base">
      <s-stack gap="base">
      <s-heading>{name} — pay {due} with crypto</s-heading>
      <s-text>
        Send <s-text type="strong">{usdc ? `${usdc} USDC` : "USDC"}</s-text> on {c.token?.chainName ?? `chain ${c.chainId}`} to the address below. The order is marked paid the moment the transfer is seen.
        {c.allowanceBps ? ` The USDC figure includes a ${(c.allowanceBps / 100).toFixed(2)}% rate allowance.` : ""}
      </s-text>
      {c.uri ? (
        <s-stack alignItems="center">
          <s-qr-code content={c.uri} />
        </s-stack>
      ) : null}
      <s-stack gap="small-200">
        <s-text color="subdued">Address</s-text>
        <s-text type="strong">{c.address}</s-text>
      </s-stack>
      {c.uri ? (
        <s-link href={c.uri} target="_blank">Open in wallet</s-link>
      ) : null}
      <s-divider />
      <s-text color="subdued">
        {validUntil ? `This USDC figure is valid until ${validUntil.toLocaleTimeString()}. ` : ""}
        {expires ? `The payment window closes ${expires.toLocaleString()}. ` : ""}
        Sending a different token or chain will not be recognised.
      </s-text>
      <s-link href={r.pageUrl} target="_blank">Open the payment page in Zold</s-link>
      {r.test ? <s-banner tone="warning">Test order: any payment made here is a real payment.</s-banner> : null}
      </s-stack>
    </s-box>
  );
}
