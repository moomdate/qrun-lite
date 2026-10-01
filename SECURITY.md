# Security

QRun Lite moves real money, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem.

- Preferred: GitHub → this repository → **Security** → **Report a vulnerability** (a private GitHub Security
  Advisory, visible only to the maintainer).

Include what you found, how to reproduce it, and the impact you expect. You'll get an answer within a week. Fixes
land on `main` and the advisory is published once a fix exists. Only the latest `main` is supported.

## What protects what

```
ESP32 kiosk ──wss + DEVICE_TOKEN──▶ Worker ──▶ Durable Object ──STRIPE_SECRET_KEY──▶ Stripe
                                      ▲                                                │
                                      └────────── webhook signed with whsec_ ◀─────────┘
```

| Asset | Where it lives | Protection |
|---|---|---|
| `STRIPE_SECRET_KEY` | Cloudflare Worker secret only | Never on the device, never logged (log lines redact `sk_`/`rk_`/`pk_`/`whsec_` values). A restricted key with only **PaymentIntents: Write** is recommended. A missing or malformed key fails closed: the Worker refuses to call Stripe. |
| `STRIPE_WEBHOOK_SECRET` | Worker secret only | HMAC-SHA256 over the raw body, constant-time compare, ±300 s timestamp tolerance, 64 KiB body limit. |
| `DEVICE_TOKEN` | Worker secret + the kiosk's flash (`secrets.h`, git-ignored) | Constant-time compare, `Authorization` header only (never the URL), minimum 16 characters or the Worker fails closed. |
| WiFi password | the kiosk's flash | – |
| The price | `PRICE_SATANG` var on the Worker | Any other amount is refused before Stripe is called. |
| The relay | kiosk GPIO | Runs only on a `succeeded` result for a payment the Worker created; an `esp_timer` switches it off after `RUN_SECONDS` even if the main loop hangs. |

Webhook events are acted on only if they are `payment_intent.succeeded` / `.payment_failed` / `.canceled`, in the
same mode as the key (test/live), not Connect events, and their PaymentIntent id, amount, currency and `ref` match
the one pending payment. Replays and events for older payments change nothing. Devices never see Stripe's error
texts. The firmware checks the Worker's TLS certificate against pinned root CAs (`firmware/include/root_ca.h`).

## Threat model

| Attacker | Can | Cannot |
|---|---|---|
| Anyone on the internet | reach `/health`, get 401 from `/ws`, get 400 from `/stripe/webhook` | create payments, see payments, fake a "paid" result |
| Someone on the kiosk's WiFi | block or delay traffic (the kiosk shows offline; money stays safe) | read or change traffic (TLS with pinned roots), unless `WS_USE_TLS 0` is used, which is for development only |
| **Someone who steals the board** | read the WiFi password and `DEVICE_TOKEN` from flash; with the token: connect as the kiosk (which disconnects the real one), create QRs at the fixed price, cancel the real kiosk's pending QR, see its QR data | charge any other amount, read the Stripe key or webhook secret, mark a payment as paid, make the real kiosk's relay run |
| Someone with `DEVICE_TOKEN` **and** `STRIPE_WEBHOOK_SECRET` | forge a signed "paid" event for a QR they created, i.e. get a run without paying | anything in your Stripe account |
| Someone with the Stripe key | everything that key allows in your Stripe account (limit it with a restricted `rk_` key) | – |

### After a theft or leak

1. `openssl rand -hex 24` → `cd worker && npx wrangler secret put DEVICE_TOKEN`, re-flash your kiosk with the new
   value. When the re-flashed kiosk connects, the Worker closes every other connection; the old token gets 401.
2. Change the WiFi password the board knew.
3. If a Stripe key or webhook secret may have leaked: roll it in the Stripe Dashboard and `secret put` the new value.

## Residual risks (known, not fixed in Lite)

- **No rate limits.** A holder of the device token can create PaymentIntents as fast as Stripe allows (each one at
  the fixed price, unpaid ones expire after `PAYMENT_TTL_SEC`), which may annoy Stripe's risk checks. Add a
  Cloudflare WAF rate-limiting rule on `/ws` if you worry about that. (Per-kiosk rate limits are in QRun Pro.)
- **One device token, stored in plain flash.** ESP32 flash encryption and secure boot would make extraction much
  harder, but they are one-way eFuse operations and are not set up by this project.
- **Delivery is best effort.** A result pushed into a half-open socket is lost; the payment itself is safe at
  Stripe, but a kiosk that never hears "succeeded" doesn't run. A reboot or brownout during a run ends that run early
  (no resume). Refund from the Stripe Dashboard if needed.
- **Pinned root CAs.** If Cloudflare moves `*.workers.dev` (or your custom domain) to a CA outside
  `root_ca.h`, the kiosk can't connect until the bundle is updated and the board re-flashed.
- **Serial log.** The USB serial log shows payment ids and QR data (not secrets). Anyone with physical USB access
  can read it.
- **Dependencies.** The Worker has no runtime dependencies; build tools are locked by `package-lock.json` (CI uses
  `npm ci` and runs `npm audit`). Firmware libraries and the platform are pinned in `platformio.ini` (licenses in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
