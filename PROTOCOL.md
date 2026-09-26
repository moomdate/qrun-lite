# QRun Lite protocol (kiosk ⇄ Worker)

A subset of the QRun Pro protocol, with the same message names and fields. A Lite kiosk can talk to a Pro Worker.

```
ESP32 kiosk ──wss + device token──▶ Worker ──▶ Durable Object "Terminal" ──sk_ key──▶ Stripe
                                      ▲                                                  │
                                      └──────────── signed webhook (whsec_) ◀────────────┘
```

## Connection

`GET wss://<worker-host>/ws?device=<name>` with the header `Authorization: Bearer <DEVICE_TOKEN>`.

- The token is compared in constant time with the `DEVICE_TOKEN` secret. A wrong or missing token gets HTTP 401 and no
  upgrade. A token in the query string is ignored. If the secret is unset or shorter than 16 characters, every
  connection gets HTTP 500 `server misconfigured` (fail closed).
- `device` is only a label (`[A-Za-z0-9._-]{1,64}`, otherwise `kiosk`). Lite has exactly one kiosk.
- A new connection closes the older one with close code `4000`.
- All frames are JSON text. `t` is the message type. Amounts are in **satang** (integer, 2000 = ฿20).
- The kiosk sends `{"t":"ping"}` every 20 s and the Worker answers `{"t":"pong"}`.

## Kiosk → Worker

| t | fields | meaning |
|---|---|---|
| `hello` | `fw` | Sent right after connecting. The Worker answers `hello`, then re-sends the pending payment (`payment`) or a result the kiosk missed while offline (`status`). |
| `create` | `amount`, `ref` | Create a PromptPay payment. `amount` must equal the Worker's `PRICE_SATANG`. `ref` is 1–40 printable ASCII characters, new for every tap (the firmware sends 12 hex characters). |
| `cancel` | `pi` | Cancel the payment on screen. |
| `ping` | – | Keepalive. |

## Worker → Kiosk

| t | fields | meaning |
|---|---|---|
| `hello` | `device`, `live` | Connected. `live` is `false` with a Stripe test key. |
| `payment` | `pi`, `ref`, `amount`, `qr`, `expires` | Show this QR. `qr` is the EMV string from Stripe; `expires` is unix seconds. |
| `status` | `pi`, `status`, `amount`, `ref` | Final result: `succeeded`, `canceled`, `failed` or `expired`. |
| `error` | `ref` (optional), `msg` | Something went wrong (see below). |
| `pong` | – | Keepalive answer. |

## Rules

- **The price is fixed on the server.** Any `amount` other than `PRICE_SATANG` gets `error "amount not allowed"`
  without a Stripe call. A missing or invalid `PRICE_SATANG` gets `error "server misconfigured"`, and so does a
  missing, empty or malformed `STRIPE_SECRET_KEY` (anything but `sk_`/`rk_` + `test_`/`live_` + letters and digits):
  the Worker then never calls Stripe and logs the reason. Surrounding whitespace in secrets is ignored.
- One payment at a time. A new `create` cancels the pending one first (the kiosk gets its `status: canceled`).
- A `create` whose `ref` Stripe has already seen gets `error "duplicate ref"`. Sending the same `create` twice while its
  QR is pending returns the same `payment`.
- The QR lives `PAYMENT_TTL_SEC` seconds (default 120). Then a Durable Object alarm cancels it at Stripe and sends
  `status: expired`.
- If a cancel reaches Stripe after the customer paid, Stripe refuses it and the kiosk gets `status: succeeded`.
- Results come from the signed Stripe webhook (`payment_intent.succeeded`, `.payment_failed`, `.canceled`). The event's
  PaymentIntent id, amount, currency and `ref` must match the stored payment, or it is ignored.
- A result is pushed once and then forgotten. If the kiosk was offline, the result is kept and sent after its next
  `hello`. On `hello`, a still-pending payment is re-checked at Stripe, so a payment made while the kiosk (or the
  webhook) was offline is not lost.
- Limits: frames over 4096 bytes (UTF-8) and non-JSON frames are ignored. Webhook bodies over 64 KiB get HTTP 413.
- The kiosk cancels any `payment` it can't show (after a reboot, after its create timed out, while the relay runs).
- Error texts never contain Stripe's messages: `invalid ref (1..40 chars)`, `amount not allowed`, `server misconfigured`,
  `duplicate ref`, `payment provider error (<stripe code>)`, `payment provider unreachable`,
  `unexpected PaymentIntent state: <status>`, `cancel failed, try again`, `no such payment`. The kiosk shows one
  generic message for all of them.
- The PaymentIntent is created with `currency=thb`, `payment_method_types[]=promptpay`, `confirm=true`, the
  `RECEIPT_EMAIL` var as billing email, `metadata[device_id]` and `metadata[ref]`, and the Stripe Idempotency-Key
  `<device>:<ref>`.

Not in Lite (QRun Pro only): price lists (`ALLOWED_AMOUNTS`), several devices (`DEVICE_TOKENS`), rate limits and
flood close code `1008`, status polling, replay of delivered results, and create re-send after a reconnect.
