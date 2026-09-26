# Deploying QRun Lite (step by step)

> **New to Cloudflare or Stripe? Start with [start-here.en.md](start-here.en.md)** (every step explains what it does and what you should see).

**English** · [ภาษาไทย](deploy.md)

This guide puts the QRun Lite Worker on Cloudflare and flashes the board to connect to it. The kiosk then runs
24/7 without your computer. The **Workers Free** plan is enough.

```
Kiosk (ESP32) ──wss + DEVICE_TOKEN──▶ Cloudflare Worker + Durable Object ──sk_ key──▶ Stripe
                                             ▲                                          │
                                             └────────── signed webhook (whsec_) ◀──────┘
```

![How QRun Lite works](architecture.svg)

It takes about 15 minutes. Run every command from the project root unless the step says to `cd` somewhere.

---

## 0. What you need

| Need | Check with |
|---|---|
| Node.js 22.12+ | `node -v` |
| PlatformIO (VS Code extension or `pip install platformio`) | `pio --version` |
| A Cloudflare account (free) | https://dash.cloudflare.com |
| A Stripe account registered in Thailand | Dashboard → Settings → Business details |
| An ESP32-2432S028R board + a USB **data** cable | [hardware.md](hardware.md) |
| A 2.4 GHz WiFi network for the kiosk | the ESP32 has no 5 GHz |

---

## 1. Stripe

1. Stripe Dashboard → **Settings → Payment methods** → turn **PromptPay** on.
2. Start in **test mode**. Copy the test secret key (`sk_test_…`) from **Developers → API keys**.

> A restricted key (`rk_…`) with only **PaymentIntents: Write** works too, and limits the damage if it leaks.

---

## 2. Price and email (must match in two places)

**`worker/wrangler.jsonc`**, under `vars`:

| Var | Meaning |
|---|---|
| `PRICE_SATANG` | The one price the kiosk may charge, in satang (`2000` = ฿20, minimum `1000`) |
| `PAYMENT_TTL_SEC` | How long a QR can be paid (default `120`). After that the Worker cancels it at Stripe. |
| `RECEIPT_EMAIL` | Your shop's email. Stripe requires one on every PromptPay payment. |

> Keeping your fork public? You don't have to commit your email: leave `receipts@example.com` in the file and deploy
> with `npx wrangler deploy --var RECEIPT_EMAIL:you@yourshop.com`. Pass it on **every** deploy; a plain
> `wrangler deploy` sets the var back to the file's value.

**`firmware/include/config.h`**:

| Setting | Meaning |
|---|---|
| `PRICE_SATANG` | **Must be the same number as in `wrangler.jsonc`**, or every tap ends in an error |
| `RUN_SECONDS` | How long the relay runs after a payment (1–3600 s) |
| `RELAY_PIN`, `RELAY_ACTIVE_HIGH` | Relay pin (default GPIO 22) and polarity, see [hardware.md](hardware.md) |

> The Worker accepts only `PRICE_SATANG`, so a stolen device token can't charge any other amount.

---

## 3. Log in to Cloudflare and deploy the Worker

```bash
cd worker
npm install
npx wrangler login      # opens a browser, click Allow
npx wrangler whoami     # shows your account name
npx wrangler deploy
```

If the account has never used Workers, open Dashboard → **Workers & Pages** once to create your
`<you>.workers.dev` subdomain.

The deploy prints your URL. Keep it:
```
https://qrun-lite.<you>.workers.dev
```

Check it:
```bash
curl https://qrun-lite.<you>.workers.dev/health      # → ok
```

---

## 4. Secrets

Lite has three secrets and **one device token** (`DEVICE_TOKEN`), because it has one kiosk.

```bash
cd worker
openssl rand -hex 24                            # your device token: keep it for step 6
npx wrangler secret put DEVICE_TOKEN            # paste the token
npx wrangler secret put STRIPE_SECRET_KEY       # paste sk_test_… (or rk_…)
```

| Secret | Comes from |
|---|---|
| `DEVICE_TOKEN` | `openssl rand -hex 24`. The same value goes into `firmware/include/secrets.h`. |
| `STRIPE_SECRET_KEY` | Stripe Dashboard → **Developers → API keys** |
| `STRIPE_WEBHOOK_SECRET` | Created in step 5 (not needed yet) |

- **Run every `wrangler` command inside `worker/`**, where `wrangler.jsonc` is. Elsewhere it fails with
  `Required Worker name missing`.
- **Cloudflare secrets are write-only.** `npx wrangler secret list` shows names only. If you lose a value, set a new one.
- A secret takes effect immediately; no redeploy needed.
- Never paste secrets into a chat or commit them.
- `secret put` prompts only in an interactive terminal. From a script, an IDE task or an AI agent's shell it reads
  standard input, and with nothing piped in it stores an **empty** secret while still printing `Success!`. In such a
  shell, pipe the value from the clipboard so it is never typed or echoed:
  ```bash
  pbpaste | npx wrangler secret put STRIPE_SECRET_KEY      # macOS (Linux: xclip -o -selection clipboard | …)
  openssl rand -hex 24 | tr -d '\n' | pbcopy && pbpaste | npx wrangler secret put DEVICE_TOKEN   # the token is now in the clipboard: paste it into secrets.h too
  ```
  If a key still ends up empty or wrong, the Worker refuses to call Stripe and `wrangler tail` says
  `STRIPE_SECRET_KEY secret is not set` or `STRIPE_SECRET_KEY is not a Stripe secret key`.

---

## 5. Stripe webhook

Stripe needs to know where to report a payment.

### In the Dashboard
1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**
   (the endpoint's mode must match the key's: test with test, live with live).
2. **Endpoint URL:** `https://qrun-lite.<you>.workers.dev/stripe/webhook`
3. **Events:**
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `payment_intent.canceled`
4. Click Add, then **Reveal** the signing secret (`whsec_…`).
5. Give it to the Worker:
   ```bash
   cd worker && npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

### With the Stripe CLI (instead of the Dashboard)
```bash
stripe webhook_endpoints create \
  -d url=https://qrun-lite.<you>.workers.dev/stripe/webhook \
  -d "enabled_events[]=payment_intent.succeeded" \
  -d "enabled_events[]=payment_intent.payment_failed" \
  -d "enabled_events[]=payment_intent.canceled"
```
The output has `"secret": "whsec_…"`; set it with `wrangler secret put STRIPE_WEBHOOK_SECRET`. Add `--live` for
the live-mode endpoint.

> This endpoint's `whsec_` is **not** the one `stripe listen` prints for local development. Don't mix them up.
> Lite **does not poll** Stripe: if webhooks don't arrive, the kiosk only learns the result when the QR expires or
> when it reconnects.

---

## 6. Configure and flash the firmware

```bash
cd firmware
cp include/secrets.h.example include/secrets.h
```

Edit `include/secrets.h` (it is git-ignored; never commit it):

| Setting | Value |
|---|---|
| `WIFI_SSID`, `WIFI_PASS` | your 2.4 GHz WiFi |
| `WS_HOST` | `qrun-lite.<you>.workers.dev` (no `https://`, no path) |
| `WS_PORT`, `WS_USE_TLS` | `443` and `1` |
| `DEVICE_ID` | any name, e.g. `kiosk-01` (shown in the logs) |
| `DEVICE_TOKEN` | the same value as the `DEVICE_TOKEN` secret from step 4 |

Flash:
```bash
ls /dev/cu.usbserial-*                            # macOS (Linux: /dev/ttyUSB*)
pio run -t upload --upload-port /dev/cu.usbserial-XXXX
```

The board holds no Stripe key, only the WiFi password and the device token. It checks Cloudflare's TLS certificate
against pinned root CAs.

---

## 7. Verify

**Board serial**
```bash
pio device monitor
```
You should see something like:
```
[BOOT] reset reason POWERON (1)
[QRun Lite] lite-1.0.0, price 2000 satang, run 60 s -> wss://qrun-lite.<you>.workers.dev:443
[WIFI] connected, IP 192.168.1.x
[WS] connected
[WS] > {"t":"hello","fw":"lite-1.0.0"}
[WS] < {"t":"hello","device":"kiosk-01","live":false}
```
`live:false` means a test key. The screen shows **ออนไลน์** (online) with a green dot and a yellow **TEST** label.

**Live Worker log** (keep it open while you test a payment)
```bash
cd worker && npx wrangler tail --format pretty
```
Tap the price and pay. You should see:
```
created pi_… ref=… amount=2000
POST https://qrun-lite.<you>.workers.dev/stripe/webhook - Ok
pi_… succeeded (delivered)
```

**Test payment:** the test QR opens a Stripe test page. **Authorize** → the kiosk beeps, shows the run countdown
and switches the relay on. **Fail** → the kiosk shows "ชำระเงินไม่สำเร็จ" (payment failed).

**In Stripe:** Dashboard → Developers → Webhooks → your endpoint: deliveries should be 200.

---

## 8. Going live

1. Turn off test mode in the Stripe Dashboard and create a live key (`sk_live_…` or `rk_live_…`).
2. Add the same webhook endpoint again in **live mode** (it has its **own** `whsec_`).
3. ```bash
   cd worker
   npx wrangler secret put STRIPE_SECRET_KEY       # live key
   npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_ of the live endpoint
   ```
No redeploy or reflash. The **TEST** label goes away when the kiosk reconnects (reset the board if it doesn't);
the serial log then shows `"live":true`.

---

## Maintenance

| Task | How |
|---|---|
| Update the Worker code | `cd worker && npm run typecheck && npm test && npm run e2e && npx wrangler deploy` (add `--var RECEIPT_EMAIL:…` if you keep your email out of the file) |
| Roll back | `cd worker && npx wrangler rollback` |
| List secrets (names only) | `cd worker && npx wrangler secret list` |
| Change the price | Edit `PRICE_SATANG` in **both** `wrangler.jsonc` and `config.h`, deploy and reflash |
| Change the run time | Edit `RUN_SECONDS` in `config.h` and reflash |
| Change the QR lifetime | Edit `PAYMENT_TTL_SEC` in `wrangler.jsonc` and deploy |
| Kiosk stolen / token leaked | `openssl rand -hex 24` → `npx wrangler secret put DEVICE_TOKEN`, reflash your board with the new value |
| Roll the Stripe key | Stripe Dashboard → API keys → Roll key, then `npx wrangler secret put STRIPE_SECRET_KEY` |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Build error `Missing include/secrets.h` | Step 6: copy `secrets.h.example` to `secrets.h`. |
| Header says **ไม่มี WiFi**, serial `[WIFI] status=1` | Network not found (5 GHz only, or a typo in the name). |
| Serial `[WIFI] status=4` | Wrong WiFi password. |
| Stuck on **กำลังเชื่อมต่อ** (connecting) | Wrong `WS_HOST`, or not deployed: try `curl https://<host>/health`. `ws auth rejected` in `wrangler tail` means `DEVICE_TOKEN` differs between `secrets.h` and the secret. TLS also fails if NTP (UDP 123) is blocked. |
| `/ws` answers `server misconfigured` | The `DEVICE_TOKEN` secret isn't set, or is shorter than 16 characters (`wrangler tail` says which). |
| Every tap errors; tail says `STRIPE_SECRET_KEY secret is not set` / `… is not a Stripe secret key` | The key is missing, empty (see the `secret put` note in step 4) or not a secret key. Set the full `sk_…`/`rk_…` again. |
| The board reboots a few seconds after the relay switches on; serial `[BOOT] reset reason BROWNOUT` | The relay coil drags the 3.3 V rail down. Give the relay its own 5 V supply: [hardware.md → Power](hardware.md#power-read-this-if-the-board-reboots). |
| Every tap ends in **เกิดข้อผิดพลาด** (error) | `wrangler tail`: `amount … != PRICE_SATANG` = the two prices differ; `PRICE_SATANG is missing` = invalid var; `payment provider error (…)` = PromptPay off, non-Thai account, wrong key, or no `RECEIPT_EMAIL`. |
| Paid, but the screen only changes when the QR runs out | Webhooks don't arrive: check the URL (`/stripe/webhook`), the three events, and that `STRIPE_WEBHOOK_SECRET` belongs to that endpoint in that mode. `wrangler tail` shows `webhook rejected: bad signature` for a wrong secret. The money is safe: the Worker checks Stripe at QR expiry and when the kiosk reconnects. |
| Relay works backwards | `RELAY_ACTIVE_HIGH = false` in `config.h`. |
| Touch is off / colours inverted | See the board variants in [hardware.md](hardware.md). |

Still stuck? Watch the serial log and `wrangler tail` side by side and compare with [PROTOCOL.md](../PROTOCOL.md).

## Costs

- **Cloudflare:** one kiosk keeps one WebSocket open and makes a few requests per payment. The 20 s pings are
  answered by the runtime without waking the Durable Object. The Free plan is plenty (100,000 Worker requests per
  day; SQLite-backed Durable Objects are available on Free).
- **Stripe:** no monthly fee; a PromptPay fee per payment at your account's rate (Dashboard → Pricing).
- **Hardware:** a CYD board (about ฿300 / $10) and a relay module.
