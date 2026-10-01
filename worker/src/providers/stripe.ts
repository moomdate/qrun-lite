// Stripe provider: a tiny REST client for PromptPay PaymentIntents (plain fetch, no SDK) + webhook verification.
// All Stripe vocabulary (PaymentIntent, pi_, requires_action, Stripe-Signature) lives in this file only.
import type { Env } from "../env";
import { hmacSha256Hex, secret, timingSafeEqual } from "../util";
import type { CreateArgs, PaymentEvent, PaymentProvider, PaymentStatus, ProviderResult, QrPayment, WebhookResult } from "./types";

export interface StripeCfg {
  key: string;
  /** STRIPE_API_BASE, for the local mock in tests. Honoured only for test keys AND a loopback http(s) URL, so no key
   *  ever leaves for another host, whatever the var says. */
  base?: string;
}

interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string; // requires_action | processing | succeeded | canceled | requires_payment_method | ...
  livemode?: boolean;
  metadata?: Record<string, string>;
  next_action?: { promptpay_display_qr_code?: { data?: string } } | null;
}

type StripeResult = { ok: true; pi: PaymentIntent; replayed: boolean } | { ok: false; status: number; msg: string; code?: string };

export const isLiveKey = (key: string) => key.startsWith("sk_live_") || key.startsWith("rk_live_");
const isTestKey = (key: string) => key.startsWith("sk_test_") || key.startsWith("rk_test_");

/** error code for "we refused to call Stripe with this configuration". */
const MISCONFIGURED = "server_misconfigured";

/** Why STRIPE_SECRET_KEY can't be used (never includes the value), or null if it looks like a secret/restricted key. */
export function keyProblem(key: string): string | null {
  if (!key) return "STRIPE_SECRET_KEY secret is not set";
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) {
    return "STRIPE_SECRET_KEY is not a Stripe secret key (expected sk_test_/sk_live_/rk_test_/rk_live_ followed by letters and digits)";
  }
  return null;
}

const isLoopback = (base: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/*$/.test(base);

function apiBase(cfg: StripeCfg): string {
  const base = isTestKey(cfg.key) && cfg.base && isLoopback(cfg.base) ? cfg.base : "https://api.stripe.com";
  return base.replace(/\/+$/, "") + "/v1";
}

async function call(cfg: StripeCfg, method: "GET" | "POST", path: string, form?: URLSearchParams, idemKey?: string): Promise<StripeResult> {
  const problem = keyProblem(cfg.key);
  if (problem) return { ok: false, status: -1, msg: `${problem}; Stripe not called`, code: MISCONFIGURED }; // fail closed
  const headers: Record<string, string> = { Authorization: `Bearer ${cfg.key}` };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idemKey) headers["Idempotency-Key"] = idemKey;
  let res: Response;
  try {
    res = await fetch(apiBase(cfg) + path, { method, headers, body: method === "POST" ? (form?.toString() ?? "") : undefined });
  } catch (e) {
    return { ok: false, status: 0, msg: `network error: ${(e as Error).message}` };
  }
  let json: { error?: { message?: string; code?: string } } & Partial<PaymentIntent>;
  try {
    json = await res.json();
  } catch {
    return { ok: false, status: res.status, msg: `bad response (HTTP ${res.status})` };
  }
  if (!res.ok) return { ok: false, status: res.status, msg: json.error?.message ?? `HTTP ${res.status}`, code: json.error?.code };
  return { ok: true, pi: json as PaymentIntent, replayed: res.headers.get("Idempotent-Replayed") === "true" };
}

/** What the device may see of a Stripe failure: the error code at most, never Stripe's message text. */
function deviceError(r: { status: number; code?: string }): string {
  if (r.code === MISCONFIGURED) return "server misconfigured";
  if (r.status === 0) return "payment provider unreachable";
  if (r.code && /^[a-z0-9_]{1,60}$/.test(r.code)) return `payment provider error (${r.code})`;
  return `payment provider error (HTTP ${r.status})`;
}

const fail = (r: { status: number; msg: string; code?: string }): ProviderResult<never> => ({ ...r, ok: false, deviceMsg: deviceError(r) });

/** Stripe PaymentIntent status -> neutral status. */
function statusOf(s: string): PaymentStatus {
  switch (s) {
    case "succeeded":
      return "succeeded";
    case "canceled":
      return "canceled";
    case "requires_payment_method": // a failed PromptPay attempt
      return "failed";
    default:
      return "pending"; // requires_action (QR shown) / processing
  }
}

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  private readonly cfg: StripeCfg;
  private readonly whsec: string;

  constructor(env: Env) {
    this.cfg = { key: secret(env.STRIPE_SECRET_KEY), base: env.STRIPE_API_BASE };
    this.whsec = secret(env.STRIPE_WEBHOOK_SECRET);
  }

  isLive = () => isLiveKey(this.cfg.key);
  configProblem = () => keyProblem(this.cfg.key);

  async createQr(a: CreateArgs): Promise<ProviderResult<QrPayment>> {
    const f = new URLSearchParams({
      amount: String(a.amount),
      currency: "thb",
      "payment_method_types[]": "promptpay",
      "payment_method_data[type]": "promptpay",
      "payment_method_data[billing_details][email]": a.email, // PromptPay requires an email
      confirm: "true",
      "metadata[device_id]": a.device,
      "metadata[ref]": a.ref,
      description: `QRun Lite ${a.ref}`,
    });
    const r = await call(this.cfg, "POST", "/payment_intents", f, `${a.device}:${a.ref}`);
    if (!r.ok) return fail(r);
    if (r.replayed) {
      // Stripe answered from its idempotency cache: that QR may be long finished. Never show it.
      return { ok: false, status: 200, msg: "answered from the idempotency cache", code: "replayed", deviceMsg: "duplicate ref" };
    }
    const qr = r.pi.next_action?.promptpay_display_qr_code?.data;
    if (r.pi.status !== "requires_action" || !qr) {
      return { ok: false, status: 200, msg: `no QR in ${r.pi.id} (status ${r.pi.status})`, code: "unexpected_state", deviceMsg: `unexpected PaymentIntent state: ${r.pi.status}` };
    }
    return { ok: true, value: { id: r.pi.id, qrPayload: qr, amount: r.pi.amount } };
  }

  async getStatus(id: string): Promise<ProviderResult<PaymentStatus>> {
    const r = await call(this.cfg, "GET", `/payment_intents/${encodeURIComponent(id)}`);
    return r.ok ? { ok: true, value: statusOf(r.pi.status) } : fail(r);
  }

  async cancel(id: string): Promise<ProviderResult<void>> {
    const r = await call(this.cfg, "POST", `/payment_intents/${encodeURIComponent(id)}/cancel`);
    return r.ok ? { ok: true, value: undefined } : fail(r);
  }

  async parseWebhook(raw: string, headers: Headers): Promise<WebhookResult> {
    if (!(await verifySignature(raw, headers.get("Stripe-Signature"), this.whsec))) {
      return { kind: "bad", reason: this.whsec ? "bad signature" : "STRIPE_WEBHOOK_SECRET is not set" };
    }
    const event = parseEvent(raw, this.isLive());
    return event ? { kind: "event", event } : { kind: "ignored" };
  }
}

// ---------------------------------------------------------------- webhooks

export const WEBHOOK_TOLERANCE_SEC = 300;

/** Verify `Stripe-Signature: t=...,v1=...[,v1=...]` = HMAC-SHA256(secret, `${t}.${rawBody}`), ±300 s. */
export async function verifySignature(rawBody: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header || !secret || header.length > 1024) return false;
  let t: number | undefined;
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && v) sigs.push(v);
  }
  if (t === undefined || sigs.length === 0 || sigs.length > 8) return false;
  if (Math.abs(nowSec - t) > WEBHOOK_TOLERANCE_SEC) return false;
  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  let match = false;
  for (const s of sigs) match = timingSafeEqual(expected, s) || match; // no short-circuit
  return match;
}

const OUTCOMES: Record<string, PaymentEvent["outcome"]> = {
  "payment_intent.succeeded": "succeeded",
  "payment_intent.payment_failed": "failed",
  "payment_intent.canceled": "canceled",
};

/** Parse an already-verified event body. Returns null for events that aren't ours (wrong mode, other types, ...). */
export function parseEvent(raw: string, live: boolean): PaymentEvent | null {
  let e: { type?: string; livemode?: unknown; account?: unknown; data?: { object?: Partial<PaymentIntent> & { object?: string } } };
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  const outcome = Object.hasOwn(OUTCOMES, e.type ?? "") ? OUTCOMES[e.type!] : undefined;
  const o = e.data?.object;
  if (!outcome || e.livemode !== live || e.account != null || !o || o.object !== "payment_intent" || typeof o.id !== "string") return null;
  if (outcome === "succeeded" && o.status !== "succeeded") return null;
  return {
    outcome,
    id: o.id,
    amount: typeof o.amount === "number" ? o.amount : -1,
    currency: typeof o.currency === "string" ? o.currency : "",
    ref: typeof o.metadata?.ref === "string" ? o.metadata.ref : "",
  };
}
