// End-to-end test: mock Stripe + `wrangler dev` (fake secrets, random ports) + a fake kiosk over a real WebSocket.
//
//   npm run e2e        (-v prints every frame and the wrangler log)
//
// Never reads worker/.dev.vars and never calls real Stripe: the Worker runs from a generated config in a temp dir
// with fake values only, and STRIPE_API_BASE points at ./mock-stripe.mjs (honoured for sk_test_ keys only).
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockStripe } from "./mock-stripe.mjs";

const WORKER = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOKEN = "e2e-device-token-0123456789abcdef";
const TTL = 6; // PAYMENT_TTL_SEC for the run: the expiry scenario waits for it
const VERBOSE = process.argv.includes("-v");
// The price the firmware's button sends (firmware/include/config.h) is the price the Worker enforces.
const PRICE = Number(/PRICE_SATANG\s*=\s*(\d+)/.exec(readFileSync(resolve(WORKER, "../firmware/include/config.h"), "utf8"))?.[1]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((ok, bad) => {
    const s = createServer();
    s.once("error", bad);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

async function startWorker(mockUrl) {
  const dir = mkdtempSync(join(tmpdir(), "qrun-lite-e2e-"));
  const [port, inspector] = [await freePort(), await freePort()];
  const config = {
    name: "qrun-lite-e2e",
    main: join(WORKER, "src/index.ts"),
    compatibility_date: "2026-09-01",
    durable_objects: { bindings: [{ name: "TERMINAL", class_name: "Terminal" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Terminal"] }],
    vars: {
      PRICE_SATANG: String(PRICE),
      PAYMENT_TTL_SEC: String(TTL),
      RECEIPT_EMAIL: "e2e@example.com",
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_WEBHOOK_SECRET: "whsec_test",
      DEVICE_TOKEN: TOKEN,
      STRIPE_API_BASE: mockUrl,
    },
  };
  const cfgPath = join(dir, "wrangler.jsonc");
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  const args = [join(WORKER, "node_modules/wrangler/bin/wrangler.js"), "dev", "--config", cfgPath, "--ip", "127.0.0.1", "--port", String(port),
    "--inspector-port", String(inspector), "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false", "--log-level", "log"];
  const proc = spawn(process.execPath, args, {
    cwd: dir,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  const onData = (d) => {
    log.push(d.toString());
    if (VERBOSE) process.stderr.write(`[wrangler] ${d}`);
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`wrangler exited early:\n${log.join("")}`);
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > 90_000) throw new Error(`wrangler dev did not start:\n${log.join("")}`);
    await sleep(250);
  }
  return {
    base,
    log,
    stop: async () => {
      if (proc.exitCode === null) {
        proc.kill("SIGINT");
        await Promise.race([new Promise((r) => proc.once("exit", r)), sleep(5000)]);
        if (proc.exitCode === null) proc.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------- fake kiosk

class Kiosk {
  constructor(base) {
    this.unread = [];
    this.waiters = [];
    this.ws = new WebSocket(`${base.replace("http", "ws")}/ws?device=e2e-kiosk`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    this.opened = new Promise((ok, bad) => {
      this.ws.onopen = ok;
      this.ws.onerror = () => bad(new Error("ws error"));
    });
    this.ws.onmessage = (e) => {
      if (VERBOSE) console.log(`    < ${e.data}`);
      const m = JSON.parse(e.data);
      const i = this.waiters.findIndex((w) => w.pred(m));
      if (i >= 0) this.waiters.splice(i, 1)[0].ok(m);
      else this.unread.push(m);
    };
    this.closed = new Promise((ok) => (this.ws.onclose = ok));
  }

  static async connect(base) {
    const k = new Kiosk(base);
    await k.opened;
    k.send({ t: "hello", fw: "e2e" });
    await k.next((m) => m.t === "hello");
    return k;
  }

  send(obj) {
    if (VERBOSE) console.log(`    > ${JSON.stringify(obj)}`);
    this.ws.send(JSON.stringify(obj));
  }

  next(pred, ms = 5000) {
    const i = this.unread.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.unread.splice(i, 1)[0]);
    return new Promise((ok, bad) => {
      const w = { pred, ok };
      this.waiters.push(w);
      setTimeout(() => {
        if (this.waiters.includes(w)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          bad(new Error(`timeout; unread: ${JSON.stringify(this.unread)}`));
        }
      }, ms);
    });
  }

  async none(pred, ms = 500) {
    await sleep(ms);
    const m = this.unread.find(pred);
    if (m) throw new Error(`unexpected frame ${JSON.stringify(m)}`);
  }

  async create(amount, ref) {
    this.send({ t: "create", amount, ref });
    return this.next((m) => (m.t === "payment" || m.t === "error") && m.ref === ref, 8000);
  }

  async close() {
    this.ws.close();
    await Promise.race([this.closed, sleep(1500)]);
  }
}

function eq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

/** Raw upgrade request, to read the HTTP status the WebSocket API hides. */
function upgradeStatus(base, auth) {
  return new Promise((ok, bad) => {
    const u = new URL(`${base}/ws`);
    const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
    if (auth) headers.Authorization = auth;
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, headers });
    req.on("response", (r) => (r.resume(), ok(r.statusCode)));
    req.on("upgrade", (r, sock) => (sock.destroy(), ok(r.statusCode)));
    req.on("error", bad);
    req.end();
  });
}

const status = (pi) => (m) => m.t === "status" && m.pi === pi;
const anyStatus = (m) => m.t === "status";

// ---------------------------------------------------------------- scenarios (one kiosk: run in order)

function scenarios(B, mock) {
  return {
    async happy_path() {
      const k = await Kiosk.connect(B);
      k.send({ t: "ping" });
      await k.next((m) => m.t === "pong");
      const p = await k.create(PRICE, "happy1");
      eq([p.t, p.amount, p.ref], ["payment", PRICE, "happy1"], "payment");
      if (!p.qr.includes(p.pi) || Math.abs(p.expires - (Date.now() / 1000 + TTL)) > 5) throw new Error(`bad payment ${JSON.stringify(p)}`);
      eq(await mock.settle(p.pi, "succeeded"), 200, "webhook accepted");
      eq(await k.next(status(p.pi)), { t: "status", pi: p.pi, status: "succeeded", amount: PRICE, ref: "happy1" }, "status");
      await k.none(anyStatus);
      await k.close();
    },

    async wrong_price() {
      const k = await Kiosk.connect(B);
      const before = mock.calls.create;
      for (const amount of [PRICE + 1, 1000 === PRICE ? 2000 : 1000, 15_000_000, `${PRICE}`]) {
        eq(await k.create(amount, `bad${amount}`), { t: "error", ref: `bad${amount}`, msg: "amount not allowed" }, `amount ${amount}`);
      }
      eq(mock.calls.create, before, "no Stripe call for a wrong price");
      await k.close();
    },

    async cancel() {
      const k = await Kiosk.connect(B);
      const p = await k.create(PRICE, "cancel1");
      k.send({ t: "cancel", pi: p.pi });
      eq((await k.next(status(p.pi))).status, "canceled", "status");
      eq(mock.intents.get(p.pi).status, "canceled", "PI canceled at Stripe");
      await mock.idle(); // Stripe's own payment_intent.canceled webhook must not produce a second status
      await k.none(anyStatus);
      await k.close();
    },

    async expiry() {
      const k = await Kiosk.connect(B);
      const p = await k.create(PRICE, "exp1");
      eq((await k.next(status(p.pi), (TTL + 15) * 1000)).status, "expired", "status");
      eq(mock.intents.get(p.pi).status, "canceled", "PI canceled at Stripe by the alarm");
      await mock.idle();
      await k.none(anyStatus);
      await k.close();
    },

    async paid_while_offline() {
      let k = await Kiosk.connect(B);
      const p = await k.create(PRICE, "off1");
      await k.close();
      await sleep(300);
      await mock.settle(p.pi, "succeeded", { webhook: false }); // and the webhook got lost too
      k = await Kiosk.connect(B);
      eq((await k.next(status(p.pi))).status, "succeeded", "hello re-fetched it from Stripe");
      await k.close();
    },

    async bad_token() {
      eq(await upgradeStatus(B, "Bearer wrong"), 401, "wrong token");
      eq(await upgradeStatus(B, undefined), 401, "no token");
      eq(await upgradeStatus(B, `Bearer ${TOKEN}`), 101, "right token");
    },

    async bad_signature() {
      const k = await Kiosk.connect(B);
      const p = await k.create(PRICE, "sig1");
      eq(await mock.settle(p.pi, "succeeded", { badSig: true }), 400, "forged webhook rejected");
      await k.none(anyStatus);
      eq((await fetch(`${B}/stripe/webhook`, { method: "POST", body: "{}" })).status, 400, "unsigned webhook rejected");
      eq(await mock.fireWebhook(mock.intents.get(p.pi), "payment_intent.succeeded"), 200, "genuine webhook");
      eq((await k.next(status(p.pi))).status, "succeeded", "status after the genuine webhook");
      await k.close();
    },
  };
}

// ---------------------------------------------------------------- main

const t0 = Date.now();
const mock = await startMockStripe();
let W;
let failed = 0;
try {
  if (!Number.isInteger(PRICE) || PRICE < 1000) throw new Error("could not read PRICE_SATANG (>= 1000) from firmware/include/config.h");
  W = await startWorker(mock.url);
  mock.cfg.webhookUrl = `${W.base}/stripe/webhook`;
  console.log(`mock stripe ${mock.url}, wrangler dev ${W.base}, price ${PRICE} satang, TTL ${TTL}s`);
  for (const [name, fn] of Object.entries(scenarios(W.base, mock))) {
    const s = Date.now();
    try {
      await fn();
      console.log(`PASS  ${name.padEnd(20)} ${String(Date.now() - s).padStart(5)} ms`);
    } catch (e) {
      failed++;
      console.log(`FAIL  ${name.padEnd(20)} ${String(Date.now() - s).padStart(5)} ms\n      ${e.message}`);
    }
  }
  const c = mock.calls;
  console.log(`stripe calls: create=${c.create} get=${c.get} cancel=${c.cancel}`);
  console.log(`${failed ? "FAILED" : "all passed"} in ${Date.now() - t0} ms`);
  if (failed && !VERBOSE) console.log(`--- wrangler log tail ---\n${W.log.join("").split("\n").slice(-30).join("\n")}`);
} catch (e) {
  console.error(e);
  failed++;
} finally {
  await W?.stop();
  await mock.close();
}
process.exit(failed ? 1 : 0);
