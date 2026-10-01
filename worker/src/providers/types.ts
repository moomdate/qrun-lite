// The payment-provider interface. The Durable Object (terminal.ts) and the router know only this file: no provider
// vocabulary (PaymentIntent, pi_, Stripe-Signature, ...) may appear outside src/providers/<name>.ts.
// Guide: docs/payment-providers.md

/** Provider-neutral status of one payment. */
export type PaymentStatus = "pending" | "succeeded" | "failed" | "canceled";

/** A QR the customer can pay. `id` is the provider's payment id (sent to the kiosk as `pi` on the wire). */
export interface QrPayment {
  id: string;
  /** The EMV/PromptPay string the kiosk renders as a QR code. */
  qrPayload: string;
  /** Amount in satang as the provider recorded it. */
  amount: number;
}

/** Failure of a provider call. `msg` is for logs only; `deviceMsg` is the ONLY text the kiosk may see. */
export interface ProviderFailure {
  ok: false;
  /** HTTP status of the provider, 0 = network error, -1 = refused locally (misconfigured). */
  status: number;
  msg: string;
  code?: string;
  deviceMsg: string;
}
export type ProviderResult<T> = { ok: true; value: T } | ProviderFailure;

export interface CreateArgs {
  /** Satang. Already checked against PRICE_SATANG by the core. */
  amount: number;
  /** Per-tap reference from the kiosk (validated: 1..40 printable ASCII). */
  ref: string;
  device: string;
  /** RECEIPT_EMAIL var ("" if unset). */
  email: string;
}

/** A verified, normalised notification. The core still checks id/amount/currency/ref against its stored payment. */
export interface PaymentEvent {
  outcome: "succeeded" | "failed" | "canceled";
  id: string;
  amount: number; // satang, -1 if unknown
  currency: string; // lower-case ISO 4217, "" if unknown
  ref: string; // the create() ref, "" if unknown
}

/** `bad` = not authentic (router answers 400); `ignored` = authentic but not for us (200, no retry). */
export type WebhookResult = { kind: "event"; event: PaymentEvent } | { kind: "ignored" } | { kind: "bad"; reason: string };

export interface PaymentProvider {
  /** Registry key, also the webhook route: POST /webhook/<name>. */
  readonly name: string;
  /** Real money? Sent to the kiosk as `live` (it shows TEST when false). Must be false for anything not production. */
  isLive(): boolean;
  /** Why the configuration can't be used (never includes a secret's value), or null. Checked before EVERY call: fail closed. */
  configProblem(): string | null;
  /** Create a QR payment. Must fail (never return a stale QR) if the provider answered from an idempotency cache:
   *  return ok:false with deviceMsg "duplicate ref". Idempotency key: `${device}:${ref}`. */
  createQr(a: CreateArgs): Promise<ProviderResult<QrPayment>>;
  /** Current status. "pending" = QR still payable. */
  getStatus(id: string): Promise<ProviderResult<PaymentStatus>>;
  /** Cancel so the QR can no longer be paid. ok:false if the provider refused (e.g. just paid): the core re-checks getStatus. */
  cancel(id: string): Promise<ProviderResult<void>>;
  /** Authenticate and normalise an incoming webhook. `raw` is the unparsed body (<= 64 KiB). Never throws. */
  parseWebhook(raw: string, headers: Headers): Promise<WebhookResult>;
}

/** A factory builds a provider from the Worker env. It must not throw and must not do I/O. */
export type ProviderFactory = (env: import("../env").Env) => PaymentProvider;
