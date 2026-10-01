// The Durable Object: holds the kiosk's WebSocket (hibernation API) and its one payment.
//
//   create ──▶ pending ──(webhook / hello re-fetch: paid)──▶ succeeded
//                 │    ──(webhook: failed)──────────────────▶ failed    (canceled at the provider)
//                 │    ──(device cancel / new create)───────▶ canceled
//                 └────(alarm at expiry)────────────────────▶ expired   (canceled at the provider)
//
// A final status is pushed to the socket and then forgotten. If the kiosk was offline, it is kept and sent on the
// next `hello`. Best effort: a status sent into a half-open socket is lost (QRun Pro adds replay/recovery for that).
import type { Env } from "./env";
import { resolveProvider } from "./providers";
import type { PaymentEvent, PaymentProvider, PaymentStatus } from "./providers/types";
import { log, parsePrice, validRef } from "./util";

export type { Env };

type Final = "succeeded" | "canceled" | "failed" | "expired";

export interface Payment {
  id: string; // the provider's payment id (the wire protocol calls it `pi`)
  ref: string;
  amount: number;
  qr: string;
  expires: number; // unix seconds
  status: "pending" | Final;
  cancelReason?: "canceled" | "expired"; // why *we* canceled it: a later `canceled` event keeps "expired"
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

  /** Rebuilt per use from the env, so a config change takes effect on the next call. */
  private get provider(): PaymentProvider {
    return resolveProvider(this.env);
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
    if (frameBytes(msg) > FRAME_MAX) return;
    let m: { t?: unknown; amount?: unknown; ref?: unknown; pi?: unknown }; // `pi`: the wire name of the payment id
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
    send(ws, { t: "hello", device, live: this.provider.isLive() });
    const p = await this.load();
    if (!p) return;
    if (p.status !== "pending") {
      // Finished while the kiosk was offline: deliver it now.
      if (send(ws, statusMsg(p))) await this.ctx.storage.delete(KEY);
      return;
    }
    // Still pending: ask the provider, in case it was paid while we missed the webhook.
    const g = await this.provider.getStatus(p.id);
    if (!g.ok) log(`hello: re-fetch ${p.id} failed: ${g.msg}`);
    const st = g.ok ? finalOf(g.value, p) : null;
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
    const provider = this.provider;
    const keyError = provider.configProblem();
    if (keyError) {
      log(`create ${ref}: ${keyError}; refused without calling the provider`); // e.g. "You did not provide an API key"
      return void send(ws, { t: "error", ref, msg: "server misconfigured" });
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
    const r = await provider.createQr({ amount: price, device, ref, email: this.env.RECEIPT_EMAIL ?? "" });
    if (!r.ok) {
      log(`create ${ref} failed: HTTP ${r.status} ${r.code ?? ""} ${r.msg}`);
      return void send(ws, { t: "error", ref, msg: r.deviceMsg });
    }
    const p: Payment = { id: r.value.id, ref, amount: r.value.amount, qr: r.value.qrPayload, expires: nowSec() + this.ttl, status: "pending" };
    await this.ctx.storage.put(KEY, p);
    await this.ctx.storage.setAlarm(p.expires * 1000);
    log(`created ${p.id} ref=${ref} amount=${p.amount}`);
    send(ws, paymentMsg(p));
  }

  private async onCancel(ws: WebSocket, id: unknown): Promise<void> {
    const p = await this.load();
    if (!p || p.id !== id || p.status !== "pending") return void send(ws, { t: "error", msg: "no such payment" });
    const st = await this.cancelOrCheck(p, "canceled");
    if (!st) return void send(ws, { t: "error", ref: p.ref, msg: "cancel failed, try again" });
    await this.finalize(p, st);
  }

  /** A verified provider event (authenticated by the router via the provider). */
  private async onEvent(e: PaymentEvent): Promise<void> {
    const p = await this.load();
    if (!p || p.id !== e.id || p.status !== "pending") return log(`webhook ${e.outcome} ${e.id}: not the pending payment, ignored`);
    // Defense in depth: the event must describe exactly the payment we created.
    if (e.amount !== p.amount || e.currency !== "thb" || e.ref !== p.ref) {
      return log(`webhook ${e.outcome} ${e.id}: amount/currency/ref mismatch, ignored`);
    }
    await this.finalize(p, e.outcome === "canceled" ? (p.cancelReason ?? "canceled") : e.outcome);
  }

  private async onAlarm(): Promise<void> {
    const p = await this.load();
    if (!p || p.status !== "pending") return;
    if (p.expires * 1000 > Date.now() + 1000) return this.ctx.storage.setAlarm(p.expires * 1000);
    const st = await this.cancelOrCheck(p, "expired");
    if (!st) {
      log(`expire ${p.id}: provider call failed, retry in 30 s`);
      return this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
    await this.finalize(p, st);
  }

  // ---------------------------------------------------------------- helpers

  /** Cancel at the provider. If it refuses (e.g. it was just paid), ask for the real status. null = unknown. */
  private async cancelOrCheck(p: Payment, reason: "canceled" | "expired"): Promise<Final | null> {
    p.cancelReason = reason;
    await this.ctx.storage.put(KEY, p);
    const c = await this.provider.cancel(p.id);
    if (c.ok) return reason;
    log(`cancel ${p.id} refused: ${c.msg}; re-fetching`);
    const g = await this.provider.getStatus(p.id);
    return g.ok ? finalOf(g.value, p) : null;
  }

  /** Mark final and push it; forget it once a socket took it, else keep it for the next hello. */
  private async finalize(p: Payment, st: Final): Promise<void> {
    if (st === "failed") {
      const c = await this.provider.cancel(p.id); // a failed attempt must not stay payable
      if (!c.ok) log(`cancel after failure ${p.id}: ${c.msg}`);
    }
    p.status = st;
    await this.ctx.storage.deleteAlarm();
    let delivered = false;
    for (const ws of this.ctx.getWebSockets()) delivered = send(ws, statusMsg(p)) || delivered;
    if (delivered) await this.ctx.storage.delete(KEY);
    else await this.ctx.storage.put(KEY, p);
    log(`${p.id} ${st} (${delivered ? "delivered" : "kept for next hello"})`);
  }

  /** Serialize state changes: the provider calls in between would otherwise let events interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const r = this.chain.then(fn);
    this.chain = r.catch(() => undefined);
    return r;
  }

  private async load(): Promise<Payment | undefined> {
    return upgradeRecord(await this.ctx.storage.get<Payment | StoredV1>(KEY));
  }

  private get ttl(): number {
    const n = Number.parseInt(this.env.PAYMENT_TTL_SEC ?? "", 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, 5), 3600) : 120;
  }
}

/** Provider status of the stored payment -> final status, or null while still pending. */
function finalOf(status: PaymentStatus, p: Payment): Final | null {
  switch (status) {
    case "succeeded":
    case "failed":
      return status;
    case "canceled":
      return p.cancelReason ?? "canceled";
    default:
      return null; // pending
  }
}

/** Records written before the provider interface kept the payment id in `pi`. A Durable Object deployed with one
 *  pending payment must keep working: read it as `id` (the next write stores the new shape). */
type StoredV1 = Omit<Payment, "id"> & { pi: string; id?: undefined };
export function upgradeRecord(r: Payment | StoredV1 | undefined): Payment | undefined {
  if (!r || typeof r.id === "string") return r as Payment | undefined;
  const { pi, ...rest } = r as StoredV1;
  return { ...rest, id: pi };
}

const nowSec = () => Math.floor(Date.now() / 1000);
const paymentMsg = (p: Payment) => ({ t: "payment", pi: p.id, ref: p.ref, amount: p.amount, qr: p.qr, expires: p.expires });
const statusMsg = (p: Payment) => ({ t: "status", pi: p.id, status: p.status, amount: p.amount, ref: p.ref });

/** Frame size in bytes (a JS string length counts UTF-16 units: Thai text is 3 bytes per character). */
function frameBytes(msg: string | ArrayBuffer): number {
  if (typeof msg !== "string") return msg.byteLength;
  return msg.length > FRAME_MAX ? msg.length : new TextEncoder().encode(msg).byteLength;
}

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
