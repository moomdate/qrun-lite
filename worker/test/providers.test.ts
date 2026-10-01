// Provider registry, the mock provider's safety interlocks, webhook routes, and old stored records.
import { afterEach, describe, expect, it, vi } from "vitest";
import { upgradeRecord } from "../src/terminal";
import { MOCK_ENABLE_PHRASE, MockProvider } from "../src/providers/mock";
import { providerName, REGISTRY, resolveProvider } from "../src/providers";
import router from "../src/router";
import { env, setup } from "./fakes";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MOCK = { PAYMENT_PROVIDER: "mock", ALLOW_MOCK_PAYMENTS: MOCK_ENABLE_PHRASE, MOCK_WEBHOOK_SECRET: "mock-secret-0123456789" };

describe("registry", () => {
  it("defaults to stripe, trims and lower-cases the name", () => {
    expect(providerName(env())).toBe("stripe");
    expect(providerName(env({ PAYMENT_PROVIDER: "  Stripe\n" }))).toBe("stripe");
    expect(resolveProvider(env()).name).toBe("stripe");
  });

  it("every registered factory yields a provider with its own name", () => {
    for (const [name, make] of Object.entries(REGISTRY)) expect(make(env()).name).toBe(name);
  });

  it.each(["omise", "__proto__", "constructor", "toString"])("unknown provider %j fails closed, never falls back to Stripe", async (name) => {
    const p = resolveProvider(env({ PAYMENT_PROVIDER: name }));
    expect(p.configProblem()).toMatch(/not a known provider/);
    expect(p.isLive()).toBe(false);
    const r = await p.createQr({ amount: 2000, ref: "r", device: "kiosk", email: "" });
    expect(r).toMatchObject({ ok: false, deviceMsg: "server misconfigured" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const s = setup({ PAYMENT_PROVIDER: name });
    const ws = s.connect();
    await s.say(ws, { t: "create", amount: 2000, ref: "r" });
    expect(ws.take()).toEqual([{ t: "error", ref: "r", msg: "server misconfigured" }]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("mock provider is impossible to enable by accident", () => {
  it.each([
    ["no flag", { ALLOW_MOCK_PAYMENTS: undefined }],
    ["wrong flag", { ALLOW_MOCK_PAYMENTS: "true" }],
    ["live key present", { STRIPE_SECRET_KEY: "sk_live_abc123" }],
    ["restricted live key present", { STRIPE_SECRET_KEY: "rk_live_abc123" }],
    ["no webhook secret", { MOCK_WEBHOOK_SECRET: undefined }],
    ["short webhook secret", { MOCK_WEBHOOK_SECRET: "short" }],
  ])("refuses: %s", async (_what, over) => {
    const e = env({ ...MOCK, ...over });
    const m = new MockProvider(e);
    expect(m.configProblem()).toBeTruthy();
    expect(await m.createQr({ amount: 2000, ref: "r", device: "k", email: "" })).toMatchObject({ ok: false, deviceMsg: "server misconfigured" });
    const w = await m.parseWebhook("{}", new Headers({ Authorization: `Bearer ${MOCK.MOCK_WEBHOOK_SECRET}` }));
    expect(w.kind).toBe("bad");
  });

  it("when enabled it is never `live` and runs the full create -> paid flow in the Durable Object", async () => {
    const s = setup(MOCK);
    const ws = s.connect();
    await s.say(ws, { t: "hello" });
    expect(ws.take()).toEqual([{ t: "hello", device: "kiosk", live: false }]);
    await s.say(ws, { t: "create", amount: 2000, ref: "r1" });
    expect(ws.take()[0]).toMatchObject({ t: "payment", pi: "mock_r1", ref: "r1", amount: 2000, qr: "MOCK-QR|mock_r1|2000" });
    const w = await new MockProvider(s.env).parseWebhook(
      JSON.stringify({ outcome: "succeeded", id: "mock_r1", amount: 2000, ref: "r1" }),
      new Headers({ Authorization: `Bearer ${MOCK.MOCK_WEBHOOK_SECRET}` }),
    );
    expect(w.kind).toBe("event");
    if (w.kind === "event") await s.event(w.event);
    expect(ws.take()).toEqual([{ t: "status", pi: "mock_r1", status: "succeeded", amount: 2000, ref: "r1" }]);
    expect(s.stripe.calls).toHaveLength(0); // no Stripe traffic at all
  });

  it("rejects a webhook without the bearer secret", async () => {
    const m = new MockProvider(env(MOCK));
    expect((await m.parseWebhook("{}", new Headers())).kind).toBe("bad");
    expect((await m.parseWebhook("{}", new Headers({ Authorization: "Bearer nope" }))).kind).toBe("bad");
  });
});

describe("webhook routes", () => {
  const hits: Request[] = [];
  const mk = (over = {}) => {
    hits.length = 0;
    const e = env(over);
    e.TERMINAL = {
      idFromName: () => "id",
      get: () => ({ fetch: async (u: string, i: RequestInit) => (hits.push(new Request(u, { ...i, method: "POST" })), new Response("ok")) }),
    } as unknown as DurableObjectNamespace;
    return e;
  };
  const post = (path: string, headers: Record<string, string> = {}, body = "{}") =>
    router.fetch(new Request(`https://w${path}`, { method: "POST", body, headers }) as never, mk(MOCK_ENV));
  let MOCK_ENV: object = {};

  it("/webhook/stripe and /stripe/webhook are the same route", async () => {
    MOCK_ENV = {};
    expect((await post("/webhook/stripe")).status).toBe(400); // reaches Stripe's signature check
    expect((await post("/stripe/webhook")).status).toBe(400);
  });

  it("a provider that is not the active one has no webhook (404)", async () => {
    MOCK_ENV = {};
    expect((await post("/webhook/mock")).status).toBe(404);
    expect((await post("/webhook/omise")).status).toBe(404);
    MOCK_ENV = MOCK;
    expect((await post("/stripe/webhook")).status).toBe(404);
    expect((await post("/webhook/stripe")).status).toBe(404);
  });

  it("the mock route accepts an authorised event only", async () => {
    MOCK_ENV = MOCK;
    const body = JSON.stringify({ outcome: "succeeded", id: "mock_r1", amount: 2000, ref: "r1" });
    expect((await post("/webhook/mock", {}, body)).status).toBe(400);
    expect(hits).toHaveLength(0);
    expect((await post("/webhook/mock", { Authorization: `Bearer ${MOCK.MOCK_WEBHOOK_SECRET}` }, body)).status).toBe(200);
    expect(hits).toHaveLength(1);
  });

  it("the mock route is dead when the interlock is off", async () => {
    MOCK_ENV = { ...MOCK, ALLOW_MOCK_PAYMENTS: undefined };
    expect((await post("/webhook/mock", { Authorization: `Bearer ${MOCK.MOCK_WEBHOOK_SECRET}` })).status).toBe(400);
  });
});

describe("records stored before the provider interface (key `pi`)", () => {
  const old = { pi: "pi_old_1", ref: "ref1", amount: 2000, qr: "00020101QR", expires: Math.floor(Date.now() / 1000) + 100, status: "pending" as const };

  it("upgradeRecord maps pi -> id and leaves new records alone", () => {
    const { pi, ...rest } = old;
    expect(upgradeRecord(old as never)).toEqual({ ...rest, id: "pi_old_1" });
    const cur = { ...rest, id: "x" };
    expect(upgradeRecord(cur)).toEqual(cur);
    expect(upgradeRecord(undefined)).toBeUndefined();
  });

  it("a pending old record still gets hello re-send, webhook completion and cancel; the wire still says `pi`", async () => {
    const s = setup();
    s.data.set("payment", structuredClone(old));
    const ws = s.connect();
    // Stripe fake does not know pi_old_1: hello re-fetch fails -> the QR is re-sent as pending
    await s.say(ws, { t: "hello" });
    expect(ws.take()).toEqual([
      { t: "hello", device: "kiosk", live: false },
      { t: "payment", pi: "pi_old_1", ref: "ref1", amount: 2000, qr: "00020101QR", expires: old.expires },
    ]);
    await s.event({ outcome: "succeeded", id: "pi_old_1", amount: 2000, currency: "thb", ref: "ref1" });
    expect(ws.take()).toEqual([{ t: "status", pi: "pi_old_1", status: "succeeded", amount: 2000, ref: "ref1" }]);
  });

  it("an old finished record is delivered on the next hello", async () => {
    const s = setup();
    s.data.set("payment", { ...structuredClone(old), status: "succeeded" });
    const ws = s.connect();
    await s.say(ws, { t: "hello" });
    expect(ws.take()[1]).toEqual({ t: "status", pi: "pi_old_1", status: "succeeded", amount: 2000, ref: "ref1" });
    expect(s.data.has("payment")).toBe(false);
  });

  it("device cancel of an old pending record reaches the provider with the old id", async () => {
    const s = setup();
    s.data.set("payment", structuredClone(old));
    const ws = s.connect();
    await s.say(ws, { t: "cancel", pi: "pi_old_1" });
    expect(s.stripe.calls.at(-2)?.path).toBe("/v1/payment_intents/pi_old_1/cancel");
  });

  it("the new shape is stored with `id` (documented one-way: roll back = old code can't read a new pending record)", async () => {
    const s = setup();
    await s.say(s.connect(), { t: "create", amount: 2000, ref: "r9" });
    expect(s.data.get("payment")).toMatchObject({ id: "pi_test_1" });
    expect(s.data.get("payment")).not.toHaveProperty("pi");
  });
});
