// The Durable Object: holds the kiosk's WebSocket (hibernation API) and its one payment.
//
//   create ──▶ pending ──(webhook / hello re-fetch: paid)──▶ succeeded
//                 │    ──(webhook: failed)──────────────────▶ failed    (PI canceled at Stripe)
//                 │    ──(device cancel / new create)───────▶ canceled
//                 └────(alarm at expiry)────────────────────▶ expired   (PI canceled at Stripe)
//
// A final status is pushed to the socket and then forgotten. If the kiosk was offline, it is kept and sent on the
// next `hello`. Best effort: a status sent into a half-open socket is lost (QRun Pro adds replay/recovery for that).
import { cancelIntent, createPromptPay, deviceError, getIntent, isLiveKey, type StripeCfg, type StripeResult } from "./stripe";
import type { PaymentEvent } from "./stripe";
import { log, parsePrice, validRef } from "./util";

export interface Env {
  TERMINAL: DurableObjectNamespace;
  STRIPE_SECRET_KEY?: string; // secret
  STRIPE_WEBHOOK_SECRET?: string; // secret
  DEVICE_TOKEN?: string; // secret
  PRICE_SATANG?: string; // var: the only amount a device may charge
  PAYMENT_TTL_SEC?: string; // var: QR lifetime
  RECEIPT_EMAIL?: string; // var: PromptPay needs billing_details.email
  STRIPE_API_BASE?: string; // tests only (mock Stripe), ignored for live keys
}

type Final = "succeeded" | "canceled" | "failed" | "expired";

export interface Payment {
  pi: string;
  ref: string;
  amount: number;
  qr: string;
  expires: number; // unix seconds
  status: "pending" | Final;
  cancelReason?: "canceled" | "expired"; // why *we* canceled it: a later `canceled` webhook keeps "expired"
}

export const FRAME_MAX = 4096;
const KEY = "payment";
const OPEN = 1;

export class Terminal {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    // {"t":"ping"} is answered by the runtime without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/ws") {
      await this.ctx.storage.put("device", req.headers.get("X-Device-Id") || "kiosk");
      for (const old of this.ctx.getWebSockets()) close(old, 4000, "replaced by new connection");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === "/event" && req.method === "POST") {
      const e = (await req.json()) as PaymentEvent;
      await this.serial(() => this.onEvent(e));
      return new Response("ok");
    }
    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if ((typeof msg === "string" ? msg.length : msg.byteLength) > FRAME_MAX) return;
    let m: { t?: unknown; amount?: unknown; ref?: unknown; pi?: unknown };
    try {
      m = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg));
    } catch {
      return; // not JSON: ignore
    }
    if (!m || typeof m !== "object") return;
    switch (m.t) {
      case "ping":
        return void send(ws, { t: "pong" });
      case "hello":
        return this.serial(() => this.onHello(ws));
      case "create":
        return this.serial(() => this.onCreate(ws, m.amount, m.ref));
      case "cancel":
        return this.serial(() => this.onCancel(ws, m.pi));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    close(ws, code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason); // those codes may not be sent
  }

  async alarm(): Promise<void> {
    await this.serial(() => this.onAlarm());
  }

  // ---------------------------------------------------------------- handlers

  private async onHello(ws: WebSocket): Promise<void> {
    const device = (await this.ctx.storage.get<string>("device")) ?? "kiosk";
    send(ws, { t: "hello", device, live: isLiveKey(this.env.STRIPE_SECRET_KEY ?? "") });
    const p = await this.load();
    if (!p) return;
    if (p.status !== "pending") {
      // Finished while the kiosk was offline: deliver it now.
      if (send(ws, statusMsg(p))) await this.ctx.storage.delete(KEY);
      return;
    }
    // Still pending: ask Stripe, in case it was paid while we missed the webhook.
    const g = await getIntent(this.stripe, p.pi);
    if (!g.ok) log(`hello: re-fetch ${p.pi} failed: ${g.msg}`);
    const st = g.ok ? finalOf(g, p) : null;
    if (st) return this.finalize(p, st);
    send(ws, paymentMsg(p));
  }

  private async onCreate(ws: WebSocket, amount: unknown, ref: unknown): Promise<void> {
    if (!validRef(ref)) return void send(ws, { t: "error", msg: "invalid ref (1..40 chars)" });
    const price = parsePrice(this.env.PRICE_SATANG);
    if (price === null) {
      log("PRICE_SATANG is missing or not an integer in 1000..15000000");
      return void send(ws, { t: "error", ref, msg: "server misconfigured" });
    }
    if (amount !== price) {
      log(`create ${ref}: amount ${String(amount).slice(0, 20)} != PRICE_SATANG ${price}, rejected`);
      return void send(ws, { t: "error", ref, msg: "amount not allowed" });
    }

    const old = await this.load();
    if (old && old.status !== "pending" && send(ws, statusMsg(old))) await this.ctx.storage.delete(KEY); // undelivered result
    if (old?.status === "pending") {
      if (old.ref === ref) return void send(ws, paymentMsg(old)); // same create sent twice
      const st = await this.cancelOrCheck(old, "canceled"); // one payment at a time
      if (!st) return void send(ws, { t: "error", ref, msg: "payment provider unreachable" });
      await this.finalize(old, st);
    }

    const device = (await this.ctx.storage.get<string>("device")) ?? "kiosk";
    const r = await createPromptPay(this.stripe, { amount: price, device, ref, email: this.env.RECEIPT_EMAIL ?? "" });
    if (!r.ok) {
      log(`create ${ref} failed: HTTP ${r.status} ${r.code ?? ""} ${r.msg}`);
      return void send(ws, { t: "error", ref, msg: deviceError(r) });
    }
    if (r.replayed) {
      // Stripe answered from its idempotency cache: that QR may be long finished. Never show it.
      log(`create ${ref}: ref reused, rejected`);
      return void send(ws, { t: "error", ref, msg: "duplicate ref" });
    }
    const qr = r.pi.next_action?.promptpay_display_qr_code?.data;
    if (r.pi.status !== "requires_action" || !qr) {
      log(`create ${ref}: no QR in ${r.pi.id} (status ${r.pi.status})`);
      return void send(ws, { t: "error", ref, msg: `unexpected PaymentIntent state: ${r.pi.status}` });
    }
    const p: Payment = { pi: r.pi.id, ref, amount: r.pi.amount, qr, expires: nowSec() + this.ttl, status: "pending" };
    await this.ctx.storage.put(KEY, p);
    await this.ctx.storage.setAlarm(p.expires * 1000);
    log(`created ${p.pi} ref=${ref} amount=${p.amount}`);
    send(ws, paymentMsg(p));
  }

  private async onCancel(ws: WebSocket, pi: unknown): Promise<void> {
    const p = await this.load();
    if (!p || p.pi !== pi || p.status !== "pending") return void send(ws, { t: "error", msg: "no such payment" });
    const st = await this.cancelOrCheck(p, "canceled");
    if (!st) return void send(ws, { t: "error", ref: p.ref, msg: "cancel failed, try again" });
    await this.finalize(p, st);
  }

  /** A signed Stripe event (already verified by the router). */
  private async onEvent(e: PaymentEvent): Promise<void> {
    const p = await this.load();
    if (!p || p.pi !== e.pi || p.status !== "pending") return log(`webhook ${e.outcome} ${e.pi}: not the pending payment, ignored`);
    // Defense in depth: the event must describe exactly the payment we created.
    if (e.amount !== p.amount || e.currency !== "thb" || e.ref !== p.ref) {
      return log(`webhook ${e.outcome} ${e.pi}: amount/currency/ref mismatch, ignored`);
    }
    await this.finalize(p, e.outcome === "canceled" ? (p.cancelReason ?? "canceled") : e.outcome);
  }

  private async onAlarm(): Promise<void> {
    const p = await this.load();
    if (!p || p.status !== "pending") return;
    if (p.expires * 1000 > Date.now() + 1000) return this.ctx.storage.setAlarm(p.expires * 1000);
    const st = await this.cancelOrCheck(p, "expired");
    if (!st) {
      log(`expire ${p.pi}: Stripe unreachable, retry in 30 s`);
      return this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
    await this.finalize(p, st);
  }

  // ---------------------------------------------------------------- helpers

  /** Cancel at Stripe. If Stripe refuses (e.g. it was just paid), ask for the real status. null = unknown. */
  private async cancelOrCheck(p: Payment, reason: "canceled" | "expired"): Promise<Final | null> {
    p.cancelReason = reason;
    await this.ctx.storage.put(KEY, p);
    const c = await cancelIntent(this.stripe, p.pi);
    if (c.ok) return reason;
    log(`cancel ${p.pi} refused: ${c.msg}; re-fetching`);
    const g = await getIntent(this.stripe, p.pi);
    return g.ok ? finalOf(g, p) : null;
  }

  /** Mark final and push it; forget it once a socket took it, else keep it for the next hello. */
  private async finalize(p: Payment, st: Final): Promise<void> {
    if (st === "failed") {
      const c = await cancelIntent(this.stripe, p.pi); // a failed PromptPay attempt must not stay payable
      if (!c.ok) log(`cancel after failure ${p.pi}: ${c.msg}`);
    }
    p.status = st;
    await this.ctx.storage.deleteAlarm();
    let delivered = false;
    for (const ws of this.ctx.getWebSockets()) delivered = send(ws, statusMsg(p)) || delivered;
    if (delivered) await this.ctx.storage.delete(KEY);
    else await this.ctx.storage.put(KEY, p);
    log(`${p.pi} ${st} (${delivered ? "delivered" : "kept for next hello"})`);
  }

  /** Serialize state changes: the Stripe calls in between would otherwise let events interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(fn);
    this.chain = r.catch(() => undefined);
    return r;
  }

  private load(): Promise<Payment | undefined> {
    return this.ctx.storage.get<Payment>(KEY);
  }

  private get stripe(): StripeCfg {
    return { key: this.env.STRIPE_SECRET_KEY ?? "", base: this.env.STRIPE_API_BASE };
  }

  private get ttl(): number {
    const n = Number.parseInt(this.env.PAYMENT_TTL_SEC ?? "", 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 5), 3600) : 120;
  }
}

/** Stripe status of the stored payment -> final status, or null while still pending. */
function finalOf(g: Extract<StripeResult, { ok: true }>, p: Payment): Final | null {
  switch (g.pi.status) {
    case "succeeded":
      return "succeeded";
    case "canceled":
      return p.cancelReason ?? "canceled";
    case "requires_payment_method": // a failed PromptPay attempt
      return "failed";
    default:
      return null; // requires_action (QR shown) / processing
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);
const paymentMsg = (p: Payment) => ({ t: "payment", pi: p.pi, ref: p.ref, amount: p.amount, qr: p.qr, expires: p.expires });
const statusMsg = (p: Payment) => ({ t: "status", pi: p.pi, status: p.status, amount: p.amount, ref: p.ref });

function send(ws: WebSocket, msg: object): boolean {
  if (ws.readyState !== OPEN) return false;
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

function close(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    /* already closed */
  }
}
