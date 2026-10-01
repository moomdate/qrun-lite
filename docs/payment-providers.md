# Payment providers

The Worker takes real money, so the part that touches a payment provider is small and isolated. The Durable Object
(`worker/src/terminal.ts`) and the router (`worker/src/router.ts`) know **only** the interface in
[`worker/src/providers/types.ts`](../worker/src/providers/types.ts). Everything provider-specific (PaymentIntent, `pi_`,
`Stripe-Signature`, API paths, status names) lives in one file per provider.

```
kiosk ⇄ ws ⇄ Terminal (Durable Object) ⇄ PaymentProvider ⇄ Stripe | Omise | 2C2P | bank API | mock
                  ▲                              │
router: POST /webhook/<provider> ── parseWebhook ┘   (POST /stripe/webhook still works)
```

The device protocol ([PROTOCOL.md](../PROTOCOL.md)) does not change with the provider. The payment id travels as `pi`
on the wire whatever it is called inside.

## Choosing a provider

Set the `PAYMENT_PROVIDER` var (`wrangler.jsonc`, `vars`). Empty or unset means `stripe`. An unknown name does **not**
fall back to Stripe: every `create` answers `server misconfigured` and no webhook is accepted. Only the active provider
has a webhook route: `POST /webhook/<name>` (for Stripe also the original `/stripe/webhook`).

## The interface

```ts
export type PaymentStatus = "pending" | "succeeded" | "failed" | "canceled";

export interface QrPayment { id: string; qrPayload: string; amount: number /* satang */ }

export interface ProviderFailure { ok: false; status: number; msg: string; code?: string; deviceMsg: string }
export type ProviderResult<T> = { ok: true; value: T } | ProviderFailure;

export interface PaymentEvent {
  outcome: "succeeded" | "failed" | "canceled";
  id: string; amount: number; currency: string; ref: string;
}
export type WebhookResult = { kind: "event"; event: PaymentEvent } | { kind: "ignored" } | { kind: "bad"; reason: string };

export interface PaymentProvider {
  readonly name: string;
  isLive(): boolean;
  configProblem(): string | null;
  createQr(a: { amount: number; ref: string; device: string; email: string }): Promise<ProviderResult<QrPayment>>;
  getStatus(id: string): Promise<ProviderResult<PaymentStatus>>;
  cancel(id: string): Promise<ProviderResult<void>>;
  parseWebhook(raw: string, headers: Headers): Promise<WebhookResult>;
}
```

What each method must do:

| Method | Contract |
|---|---|
| `isLive()` | `true` only with real money. It becomes `live` in the kiosk's `hello` (the kiosk shows **TEST** when false). |
| `configProblem()` | Text saying why the configuration is unusable, or `null`. **Fail closed**: the core calls it before every create and refuses (`server misconfigured`) without calling you. Never put a secret's value in it. Trim secrets with `secret()` from `util.ts`. |
| `createQr()` | Create a payment that shows a PromptPay QR; return its id and the EMV string. Use `${device}:${ref}` as the idempotency key if your API has one. If the API answers from an idempotency cache (an old payment for the same `ref`), return `ok:false` with `deviceMsg: "duplicate ref"`: **never return a QR that may be finished**. Amounts are satang; the core already checked the price. |
| `getStatus()` | `pending` while the QR is payable. `failed` = this attempt failed and a new QR is needed. Used when the kiosk reconnects and after a refused cancel. |
| `cancel()` | Make the QR unpayable. If the provider refuses (e.g. it was just paid), return `ok:false`: the core then calls `getStatus()` and reports what really happened (a payment that raced a cancel is reported as `succeeded`). |
| `parseWebhook()` | Authenticate the request (signature/HMAC/shared token, in constant time, with replay tolerance if the provider offers a timestamp) and normalise it. `bad` for anything not authentic (HTTP 400), `ignored` for authentic events that are not about a payment we can act on, or are for the wrong mode (HTTP 200 so the provider doesn't retry). Never throw. The router has already capped the body at 64 KiB. The core additionally checks `id`, `amount`, `currency == "thb"` and `ref` against its stored payment. |

Rules every provider must keep (the tests check them for Stripe):

- **No secrets in errors or logs.** `msg` goes to the log (which also redacts `sk_`/`whsec_` patterns); `deviceMsg` is the
  only text the kiosk gets and must never contain the provider's own message text. Use a fixed string, or a code that
  matches `[a-z0-9_]{1,60}` as Stripe's does (`payment provider error (<code>)`).
- **Fail closed** on a missing or malformed secret, with no network call.
- **No outbound request may carry your key to another host.** If you add a test base URL like `STRIPE_API_BASE`, honour it
  only for test keys and loopback addresses.
- **Webhook authenticity comes from the provider's own scheme**, never from the body alone.
- The persisted payment record (`id`, `ref`, `amount`, `qr`, `expires`, `status`) contains no provider fields.

## Add a provider: step by step

1. Create `worker/src/providers/<name>.ts` (skeleton below). Keep every provider-specific word in that file.
2. Add its environment to `worker/src/env.ts` (secrets as optional strings) and document them in `worker/wrangler.jsonc`
   comments and `worker/.dev.vars.example`.
3. Add **one line** to `REGISTRY` in `worker/src/providers/index.ts`: `omise: (env) => new OmiseProvider(env),`.
4. Test it in `worker/test/<name>.test.ts` against a fake `fetch` (see `test/fakes.ts`): a good create, the
   idempotency-cache case, a refused cancel, misconfigured secrets (no network call), webhook accept/reject/ignore,
   and that no error text reaches `deviceMsg`. Extend `test/providers.test.ts` for the registry if needed.
5. Run `npm run typecheck && npm test && npm run e2e` in `worker/`. For a real try-out, deploy with
   `PAYMENT_PROVIDER=<name>`, point the provider's webhook at `https://<worker>/webhook/<name>`, and pay a test QR.
6. Add a short section to your PR describing the provider's test/live modes and which currency/minimum it supports.

Skeleton:

```ts
// worker/src/providers/omise.ts
import type { Env } from "../env";
import { secret } from "../util";
import type { CreateArgs, PaymentProvider, PaymentStatus, ProviderResult, QrPayment, WebhookResult } from "./types";

export class OmiseProvider implements PaymentProvider {
  readonly name = "omise";
  private readonly key: string;
  private readonly whsec: string;

  constructor(env: Env) {
    // No I/O and no throwing here: the factory runs on every request.
    this.key = secret(env.OMISE_SECRET_KEY);
    this.whsec = secret(env.OMISE_WEBHOOK_SECRET);
  }

  isLive = () => this.key.startsWith("skey_live_"); // whatever marks real money for this provider

  configProblem = () => (/^skey_(test|live)_\w+$/.test(this.key) ? null : "OMISE_SECRET_KEY is not set or malformed");

  async createQr(a: CreateArgs): Promise<ProviderResult<QrPayment>> {
    // 1. call the API (amount in satang, currency thb, a.ref/a.device as metadata, idempotency key `${a.device}:${a.ref}`)
    // 2. network error  -> { ok: false, status: 0, msg: "...", deviceMsg: "payment provider unreachable" }
    //    API error      -> { ok: false, status, msg, code, deviceMsg: `payment provider error (${code})` }
    //    cache replay   -> { ok: false, ..., deviceMsg: "duplicate ref" }
    //    no QR in reply -> { ok: false, ..., deviceMsg: "payment provider error (no_qr)" }
    return { ok: true, value: { id: "chrg_...", qrPayload: "000201...", amount: a.amount } };
  }

  async getStatus(id: string): Promise<ProviderResult<PaymentStatus>> {
    return { ok: true, value: "pending" }; // map the provider's states to pending | succeeded | failed | canceled
  }

  async cancel(id: string): Promise<ProviderResult<void>> {
    return { ok: true, value: undefined }; // or ok:false if the provider refuses
  }

  async parseWebhook(raw: string, headers: Headers): Promise<WebhookResult> {
    // verify the signature over `raw` with this.whsec, constant-time; otherwise:
    //   return { kind: "bad", reason: "bad signature" };
    // then map the event:
    return { kind: "ignored" }; // or { kind: "event", event: { outcome: "succeeded", id, amount, currency: "thb", ref } }
  }
}
```

If your provider has no cancel API (some QR payments simply expire), `cancel()` may return success only if it can
guarantee the QR can no longer be paid; otherwise return `ok:false` so the core reconciles with `getStatus()`. If it
cannot do either safely, it is not suitable for this kiosk, because a QR that outlives the on-screen timer can be paid
after the machine says "expired".

## The mock provider (development and tests only)

`PAYMENT_PROVIDER=mock` runs the kiosk flow without any payment service. Because anyone with its secret can mark a
payment as paid, it refuses to run unless **all** of these hold:

- `ALLOW_MOCK_PAYMENTS` is exactly `yes-this-takes-no-real-money`,
- no live Stripe key (`sk_live_`/`rk_live_`) is configured in the same Worker,
- `MOCK_WEBHOOK_SECRET` is at least 16 characters.

It always reports `live: false`, so the kiosk shows **TEST**. Put these in `worker/.dev.vars` for `wrangler dev`
(never as `vars` in the deployed `wrangler.jsonc`), then mark a payment paid:

```bash
curl -X POST http://localhost:8787/webhook/mock \
  -H "Authorization: Bearer $MOCK_WEBHOOK_SECRET" \
  -d '{"outcome":"succeeded","id":"mock_<ref>","amount":1000,"ref":"<ref>"}'
```

The mock is stateless: its payment id is `mock_<ref>` and `getStatus` always says `pending`.

## Upgrading a deployed Worker

The stored payment used to be saved with the id under `pi`; it is now `id`. The Durable Object reads both, so a payment
that is pending during a redeploy completes normally. A new pending payment is written with `id` only, so roll back to an older Worker only while the kiosk is idle (no QR on screen).
