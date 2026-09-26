// Tiny mock of the Stripe PaymentIntents API for the e2e test. Never talks to real Stripe.
//
//   POST /v1/payment_intents             create (Idempotency-Key replays the original response, like Stripe)
//   GET  /v1/payment_intents/:id
//   POST /v1/payment_intents/:id/cancel  400 if succeeded/canceled; then fires payment_intent.canceled
//
// Test driver (in-process): settle(pi, "succeeded" | "failed", { webhook, badSig }), fireWebhook(pi, type, badSig).
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const KEY = "sk_test_fake";

export function startMockStripe({ webhookSecret = "whsec_test" } = {}) {
  const cfg = { webhookUrl: "" };
  const intents = new Map();
  const idem = new Map();
  const calls = { create: 0, get: 0, cancel: 0 };
  const pending = new Set();

  const sign = (body, secret = webhookSecret) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  };
  /** POST a signed event for the PI's current state to the Worker; resolves with the HTTP status. */
  const fireWebhook = (pi, type, badSig = false) => {
    const body = JSON.stringify({ id: `evt_${randomBytes(6).toString("hex")}`, object: "event", livemode: false, type, data: { object: structuredClone(pi) } });
    const p = fetch(cfg.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "Stripe-Signature": sign(body, badSig ? "whsec_wrong" : webhookSecret) },
      body,
    })
      .then((r) => r.status)
      .catch(() => 0)
      .finally(() => pending.delete(p));
    pending.add(p);
    return p;
  };

  const send = (res, status, obj, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(obj));
  };
  const err = (res, status, message, code) => send(res, status, { error: { message, code } });

  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const path = new URL(req.url, "http://x").pathname;
    if (req.headers.authorization !== `Bearer ${KEY}`) return err(res, 401, "Invalid API Key provided");

    if (req.method === "POST" && path === "/v1/payment_intents") {
      const ik = req.headers["idempotency-key"];
      if (ik && idem.has(ik)) return send(res, 200, idem.get(ik), { "Idempotent-Replayed": "true" });
      calls.create++;
      const f = new URLSearchParams(body);
      if (f.get("currency") !== "thb" || f.get("payment_method_types[]") !== "promptpay") return err(res, 400, "expected thb/promptpay", "parameter_invalid");
      if (!f.get("payment_method_data[billing_details][email]")) return err(res, 400, "PromptPay requires an email", "parameter_missing");
      const id = `pi_mock_${randomBytes(6).toString("hex")}`;
      const pi = {
        id,
        object: "payment_intent",
        livemode: false,
        amount: Number(f.get("amount")),
        currency: "thb",
        status: "requires_action",
        metadata: { device_id: f.get("metadata[device_id]"), ref: f.get("metadata[ref]") },
        next_action: { type: "promptpay_display_qr_code", promptpay_display_qr_code: { data: `https://pm-redirects.stripe.com/authorize/acct_mock/pa_nonce_${id}` } },
      };
      intents.set(id, pi);
      if (ik) idem.set(ik, structuredClone(pi));
      return send(res, 200, pi);
    }

    const m = /^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/.exec(path);
    const pi = m && intents.get(decodeURIComponent(m[1]));
    if (!pi) return err(res, 404, "No such payment_intent", "resource_missing");
    if (req.method === "GET" && !m[2]) {
      calls.get++;
      return send(res, 200, pi);
    }
    if (req.method === "POST" && m[2]) {
      calls.cancel++;
      if (pi.status === "succeeded" || pi.status === "canceled") {
        return err(res, 400, `You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`, "payment_intent_unexpected_state");
      }
      pi.status = "canceled";
      pi.next_action = null;
      send(res, 200, pi);
      setTimeout(() => fireWebhook(pi, "payment_intent.canceled"), 30);
      return;
    }
    return err(res, 404, "Unrecognized request URL");
  });

  return new Promise((ok) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      ok({
        url,
        cfg,
        intents,
        calls,
        fireWebhook,
        /** Customer pays (or the payment fails) at the bank; by default Stripe then sends the webhook. */
        async settle(id, outcome, { webhook = true, badSig = false } = {}) {
          const pi = intents.get(id);
          pi.status = outcome === "succeeded" ? "succeeded" : "requires_payment_method";
          pi.next_action = null;
          return webhook ? fireWebhook(pi, outcome === "succeeded" ? "payment_intent.succeeded" : "payment_intent.payment_failed", badSig) : null;
        },
        idle: () => Promise.all([...pending]),
        close: () => new Promise((c) => server.close(() => c())),
      });
    });
  });
}
