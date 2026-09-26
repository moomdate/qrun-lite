// Stripe: a tiny REST client for PromptPay PaymentIntents (plain fetch, no SDK) + webhook verification.
import { hmacSha256Hex, timingSafeEqual } from "./util";

export interface StripeCfg {
  key: string;
  /** STRIPE_API_BASE, for the local mock in tests. Honoured for test keys only, so a live key never goes elsewhere. */
  base?: string;
}

export interface PaymentIntent {
  id: string;
  amount: number;
  currency: string;
  status: string; // requires_action | processing | succeeded | canceled | requires_payment_method | ...
  livemode?: boolean;
  metadata?: Record<string, string>;
  next_action?: { promptpay_display_qr_code?: { data?: string } } | null;
}

export type StripeResult = { ok: true; pi: PaymentIntent; replayed: boolean } | { ok: false; status: number; msg: string; code?: string };

export const isLiveKey = (key: string) => key.startsWith("sk_live_") || key.startsWith("rk_live_");
const isTestKey = (key: string) => key.startsWith("sk_test_") || key.startsWith("rk_test_");

/** deviceError() code for "we refused to call Stripe with this configuration". */
export const MISCONFIGURED = "server_misconfigured";

/** Why STRIPE_SECRET_KEY can't be used (never includes the value), or null if it looks like a secret/restricted key. */
export function keyProblem(key: string): string | null {
  if (!key) return "STRIPE_SECRET_KEY secret is not set";
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) {
    return "STRIPE_SECRET_KEY is not a Stripe secret key (expected sk_test_/sk_live_/rk_test_/rk_live_ followed by letters and digits)";
  }
  return null;
}

function apiBase(cfg: StripeCfg): string {
  return (isTestKey(cfg.key) && cfg.base ? cfg.base : "https://api.stripe.com").replace(/\/+$/, "") + "/v1";
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

export function createPromptPay(cfg: StripeCfg, a: { amount: number; device: string; ref: string; email: string }): Promise<StripeResult> {
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
  return call(cfg, "POST", "/payment_intents", f, `${a.device}:${a.ref}`);
}

export const getIntent = (cfg: StripeCfg, id: string) => call(cfg, "GET", `/payment_intents/${encodeURIComponent(id)}`);
export const cancelIntent = (cfg: StripeCfg, id: string) => call(cfg, "POST", `/payment_intents/${encodeURIComponent(id)}/cancel`);

/** What the device may see of a Stripe failure: the error code at most, never Stripe's message text. */
export function deviceError(r: { status: number; code?: string }): string {
  if (r.code === MISCONFIGURED) return "server misconfigured";
  if (r.status === 0) return "payment provider unreachable";
  if (r.code && /^[a-z0-9_]{1,60}$/.test(r.code)) return `payment provider error (${r.code})`;
  return `payment provider error (HTTP ${r.status})`;
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

/** A verified event the Durable Object may act on (it still checks pi/amount/ref against its stored payment). */
export interface PaymentEvent {
  outcome: "succeeded" | "failed" | "canceled";
  pi: string;
  amount: number;
  currency: string;
  ref: string;
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
    pi: o.id,
    amount: typeof o.amount === "number" ? o.amount : -1,
    currency: typeof o.currency === "string" ? o.currency : "",
    ref: typeof o.metadata?.ref === "string" ? o.metadata.ref : "",
  };
}
