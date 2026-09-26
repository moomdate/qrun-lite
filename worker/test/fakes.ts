// Test doubles: a Durable Object context (storage + sockets + alarm) and an in-memory Stripe behind `fetch`.
import { vi } from "vitest";
import { Terminal, type Env } from "../src/terminal";

// Workers runtime global used by the Terminal constructor.
(globalThis as Record<string, unknown>).WebSocketRequestResponsePair ??= class {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
};

export class FakeWs {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(s: string) {
    if (this.readyState !== 1) throw new Error("closed");
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
  }
  /** Frames received since the last call. */
  take(): Record<string, unknown>[] {
    return this.sent.splice(0);
  }
}

export function fakeCtx() {
  const data = new Map<string, unknown>();
  const state = { alarm: null as number | null, sockets: [] as FakeWs[] };
  const storage = {
    get: async (k: string) => structuredClone(data.get(k)),
    put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
    delete: async (k: string) => data.delete(k),
    setAlarm: async (t: number) => void (state.alarm = t),
    deleteAlarm: async () => void (state.alarm = null),
  };
  const ctx = {
    storage,
    getWebSockets: () => state.sockets.filter((s) => s.readyState === 1),
    acceptWebSocket: () => undefined,
    setWebSocketAutoResponse: () => undefined,
  };
  return { ctx: ctx as unknown as DurableObjectState, data, state };
}

interface Intent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  livemode: boolean;
  metadata: Record<string, string>;
  next_action: unknown;
}

/** In-memory Stripe PaymentIntents API. `down` = network error, `failCreate` = next create answers HTTP 402. */
export function fakeStripe() {
  const intents = new Map<string, Intent>();
  const idem = new Map<string, Intent>();
  const calls: { method: string; path: string; body: string; headers: Record<string, string> }[] = [];
  const s = { intents, calls, down: false, failCreate: false, n: 0 };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method ?? "GET", path, body: String(init.body ?? ""), headers });
    if (s.down) throw new Error("connect ECONNREFUSED");
    if (path === "/v1/payment_intents") {
      const ik = headers["Idempotency-Key"] ?? "";
      if (idem.has(ik)) return json(200, idem.get(ik), { "Idempotent-Replayed": "true" });
      if (s.failCreate) {
        s.failCreate = false;
        return json(402, { error: { code: "card_declined", message: "secret detail req_123 sk_test_****abcd" } });
      }
      const f = new URLSearchParams(String(init.body));
      const id = `pi_test_${++s.n}`;
      const pi: Intent = {
        id,
        amount: Number(f.get("amount")),
        currency: f.get("currency") ?? "",
        status: "requires_action",
        livemode: false,
        metadata: { device_id: f.get("metadata[device_id]") ?? "", ref: f.get("metadata[ref]") ?? "" },
        next_action: { type: "promptpay_display_qr_code", promptpay_display_qr_code: { data: `00020101021230QR_${id}` } },
      };
      intents.set(id, pi);
      idem.set(ik, structuredClone(pi));
      return json(200, pi);
    }
    const m = /^\/v1\/payment_intents\/([^/]+)(\/cancel)?$/.exec(path);
    const pi = m ? intents.get(decodeURIComponent(m[1]!)) : undefined;
    if (!pi) return json(404, { error: { code: "resource_missing", message: "No such payment_intent" } });
    if (!m![2]) return json(200, pi);
    if (pi.status === "succeeded" || pi.status === "canceled") {
      return json(400, { error: { code: "payment_intent_unexpected_state", message: `status ${pi.status}` } });
    }
    pi.status = "canceled";
    pi.next_action = null;
    return json(200, pi);
  };
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  return s;
}

export const TOKEN = "test-device-token-0123456789abcdef";

export function env(over: Partial<Env> = {}): Env {
  return {
    TERMINAL: undefined as unknown as DurableObjectNamespace,
    STRIPE_SECRET_KEY: "sk_test_unit",
    STRIPE_WEBHOOK_SECRET: "whsec_unit",
    DEVICE_TOKEN: TOKEN,
    PRICE_SATANG: "2000",
    PAYMENT_TTL_SEC: "120",
    RECEIPT_EMAIL: "unit@example.com",
    ...over,
  };
}

/** A Terminal with a connected device, a fake Stripe and a fake clock-free storage. */
export function setup(over: Partial<Env> = {}) {
  const stripe = fakeStripe();
  const { ctx, data, state } = fakeCtx();
  const t = new Terminal(ctx, env(over));
  const connect = () => {
    const ws = new FakeWs();
    state.sockets.push(ws);
    return ws;
  };
  const say = (ws: FakeWs, msg: unknown) => t.webSocketMessage(ws as unknown as WebSocket, typeof msg === "string" ? msg : JSON.stringify(msg));
  const event = (e: object) => t.fetch(new Request("https://do/event", { method: "POST", body: JSON.stringify(e) }));
  return { t, stripe, data, state, connect, say, event };
}
