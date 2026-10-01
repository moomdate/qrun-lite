# Contributing to QRun Lite

Thanks for helping. QRun Lite takes real money, so changes are judged on safety first: a small, boring, well-tested
change beats a clever one. Good first contributions: a new payment provider ([guide](docs/payment-providers.md)), docs,
translations, hardware notes for other boards.

## Layout

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker + Durable Object (TypeScript). `src/providers/` holds the payment providers. |
| `firmware/` | ESP32 firmware (PlatformIO, C++). |
| `PROTOCOL.md` | Kiosk ⇄ Worker wire protocol. Changing it breaks flashed boards: needs a very good reason. |
| `docs/` | Guides. |

## Dev setup

You need Node.js 22.12+ (Worker) and, for the firmware only, [PlatformIO](https://platformio.org/).

```bash
cd worker
npm ci
cp .dev.vars.example .dev.vars   # git-ignored; TEST keys only
npx wrangler dev                 # http://localhost:8787
```

## Tests

Run these before opening a pull request (CI runs the same):

```bash
cd worker
npm run typecheck   # tsc --noEmit
npm test            # vitest unit tests, no network
npm run e2e         # wrangler dev + a mock Stripe + a fake kiosk over a real WebSocket (~15 s)

cd ../firmware
pio test -e native  # host tests of the kiosk logic
pio run             # device build
```

`npm run e2e` never calls a real payment service and never reads your `.dev.vars`: it generates a config in a temp
directory with fake values. Add `-v` (`node test/e2e/run.mjs -v`) to see every frame. Behaviour changes need a test; a
bug fix needs a test that fails without the fix.

## Code style

- TypeScript `strict`, no `any`, no runtime dependencies in the Worker (plain `fetch` and Web Crypto).
- Small modules, short comments that say *why*. Match the surrounding code (2 spaces, double quotes, semicolons).
- The core (`terminal.ts`, `router.ts`) must not mention a provider's vocabulary; that belongs in `src/providers/<name>.ts`.
- Fail closed: a missing or malformed secret means "refuse and log why", never "try anyway".
- Errors the device can see are fixed strings or codes. Never forward a provider's message text.

## Secret hygiene

- **Never commit keys, tokens or passwords**: Stripe/Omise/... keys, `whsec_` secrets, `DEVICE_TOKEN`, WiFi passwords,
  `.dev.vars`, `firmware/include/secrets.h`. They are in `.gitignore`; do not work around that.
- Put real values only in `wrangler secret put` (production) or `worker/.dev.vars` (local, test keys). In tests use
  short, obviously fake values such as `sk_test_unit`.
- Don't paste logs, screenshots or `wrangler tail` output into issues without checking them for secrets.
- If you committed a secret by mistake, treat it as leaked: roll the key at the provider first, then tell the maintainer.
  Rewriting history does not un-leak it. Security problems: see [SECURITY.md](SECURITY.md).

## Pull requests

- One topic per PR; explain what and why, and what you tested (real hardware or a real provider sandbox, if you did).
- Say honestly what you could not verify.
- By contributing you agree that your work is released under the [MIT license](LICENSE).
