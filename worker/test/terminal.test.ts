// Payment state transitions and price enforcement of the Durable Object, against a fake Stripe.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setup } from "./fakes";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Connect, hello, create with the right price; returns the `payment` frame. */
async function paying(s: ReturnType<typeof setup>, ref = "ref1") {
  const ws = s.connect();
  await s.say(ws, { t: "hello", fw: "test" });
  await s.say(ws, { t: "create", amount: 2000, ref });
  const frames = ws.take();
  const p = frames.find((f) => f.t === "payment")!;
  expect(p).toBeTruthy();
  return { ws, p: p as { pi: string; ref: string; amount: number; qr: string; expires: number } };
}
const paid = (pi: string, over: object = {}) => ({ outcome: "succeeded", pi, amount: 2000, currency: "thb", ref: "ref1", ...over });

describe("create + price enforcement", () => {
  it("creates a PromptPay PaymentIntent for PRICE_SATANG and sends the QR", async () => {
    const s = setup();
    const ws = s.connect();
    await s.say(ws, { t: "hello", fw: "test" });
    expect(ws.take()).toEqual([{ t: "hello", device: "kiosk", live: false }]);
    await s.say(ws, { t: "create", amount: 2000, ref: "ref1" });
    const [p] = ws.take();
    expect(p).toMatchObject({ t: "payment", pi: "pi_test_1", ref: "ref1", amount: 2000, qr: "00020101021230QR_pi_test_1" });
    expect(s.state.alarm).toBe((p!.expires as number) * 1000);
    const c = s.stripe.calls[0]!;
    const f = new URLSearchParams(c.body);
    expect(f.get("amount")).toBe("2000");
    expect(f.get("currency")).toBe("thb");
    expect(f.get("payment_method_types[]")).toBe("promptpay");
    expect(f.get("payment_method_data[billing_details][email]")).toBe("unit@example.com");
    expect(f.get("confirm")).toBe("true");
    expect(c.headers["Idempotency-Key"]).toBe("kiosk:ref1");
  });

  it.each([1000, 2001, 1999, 20, 0, -2000, 2000.5, "2000", null, undefined, 1e309, [2000], { a: 2000 }])(
    "rejects amount %j without calling Stripe",
    async (amount) => {
      const s = setup();
      const ws = s.connect();
      await s.say(ws, { t: "create", amount, ref: "r" });
      expect(ws.take()).toEqual([{ t: "error", ref: "r", msg: "amount not allowed" }]);
      expect(s.stripe.calls).toHaveLength(0);
    },
  );

  it.each([undefined, "", "abc", "999", "20.00", "15000001", " "])("fails closed when PRICE_SATANG is %j", async (price) => {
    const s = setup({ PRICE_SATANG: price });
    const ws = s.connect();
    await s.say(ws, { t: "create", amount: 2000, ref: "r" });
    expect(ws.take()).toEqual([{ t: "error", ref: "r", msg: "server misconfigured" }]);
    expect(s.stripe.calls).toHaveLength(0);
  });

  it("honours a different configured price", async () => {
    const s = setup({ PRICE_SATANG: "1000" });
    const ws = s.connect();
    await s.say(ws, { t: "create", amount: 1000, ref: "r" });
    expect(ws.take()[0]).toMatchObject({ t: "payment", amount: 1000 });
  });

  it.each([undefined, "", "x".repeat(41), "has space", "ไทย", "a\nb", 42])("rejects ref %j", async (ref) => {
    const s = setup();
    const ws = s.connect();
    await s.say(ws, { t: "create", amount: 2000, ref });
    expect(ws.take()).toEqual([{ t: "error", msg: "invalid ref (1..40 chars)" }]);
    expect(s.stripe.calls).toHaveLength(0);
  });

  it("never shows Stripe's error text to the device", async () => {
    const s = setup();
    const ws = s.connect();
    s.stripe.failCreate = true;
    await s.say(ws, { t: "create", amount: 2000, ref: "r1" });
    expect(ws.take()).toEqual([{ t: "error", ref: "r1", msg: "payment provider error (card_declined)" }]);
    s.stripe.down = true;
    await s.say(ws, { t: "create", amount: 2000, ref: "r2" });
    expect(ws.take()).toEqual([{ t: "error", ref: "r2", msg: "payment provider unreachable" }]);
  });

  it("refuses a ref Stripe has already seen (idempotent replay) instead of showing an old QR", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    await s.event(paid(p.pi));
    ws.take();
    await s.say(ws, { t: "create", amount: 2000, ref: "ref1" });
    expect(ws.take()).toEqual([{ t: "error", ref: "ref1", msg: "duplicate ref" }]);
  });

  it("answers the same create twice with the same QR (one Stripe call)", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    await s.say(ws, { t: "create", amount: 2000, ref: "ref1" });
    expect(ws.take()).toEqual([expect.objectContaining({ t: "payment", pi: p.pi })]);
    expect(s.stripe.calls.filter((c) => c.path === "/v1/payment_intents")).toHaveLength(1);
  });

  it("a new create cancels the pending one first", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    await s.say(ws, { t: "create", amount: 2000, ref: "ref2" });
    const [st, p2] = ws.take();
    expect(st).toEqual({ t: "status", pi: p.pi, status: "canceled", amount: 2000, ref: "ref1" });
    expect(p2).toMatchObject({ t: "payment", ref: "ref2" });
    expect(s.stripe.intents.get(p.pi)!.status).toBe("canceled");
  });
});

describe("state transitions", () => {
  it("pending -> succeeded on a matching webhook; the result is then forgotten", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    await s.event(paid(p.pi));
    expect(ws.take()).toEqual([{ t: "status", pi: p.pi, status: "succeeded", amount: 2000, ref: "ref1" }]);
    expect(s.data.has("payment")).toBe(false);
    expect(s.state.alarm).toBeNull();
    await s.event(paid(p.pi)); // duplicate delivery
    expect(ws.take()).toEqual([]);
  });

  it.each([
    ["another PaymentIntent", { pi: "pi_other" }],
    ["a different amount", { amount: 1 }],
    ["a different currency", { currency: "usd" }],
    ["a different ref", { ref: "zzz" }],
  ])("ignores a signed event for %s", async (_what, over) => {
    const s = setup();
    const { ws, p } = await paying(s);
    await s.event(paid(p.pi, over));
    expect(ws.take()).toEqual([]);
    expect((s.data.get("payment") as { status: string }).status).toBe("pending");
  });

  it("pending -> canceled on the device's cancel", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    await s.say(ws, { t: "cancel", pi: p.pi });
    expect(ws.take()).toEqual([{ t: "status", pi: p.pi, status: "canceled", amount: 2000, ref: "ref1" }]);
    expect(s.stripe.intents.get(p.pi)!.status).toBe("canceled");
    await s.say(ws, { t: "cancel", pi: p.pi });
    expect(ws.take()).toEqual([{ t: "error", msg: "no such payment" }]);
  });

  it("cancel racing a payment reports succeeded (Stripe refuses the cancel)", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    s.stripe.intents.get(p.pi)!.status = "succeeded"; // paid, webhook not here yet
    await s.say(ws, { t: "cancel", pi: p.pi });
    expect(ws.take()).toEqual([{ t: "status", pi: p.pi, status: "succeeded", amount: 2000, ref: "ref1" }]);
  });

  it("cancel with Stripe unreachable keeps the payment pending", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    s.stripe.down = true;
    await s.say(ws, { t: "cancel", pi: p.pi });
    expect(ws.take()).toEqual([{ t: "error", ref: "ref1", msg: "cancel failed, try again" }]);
    expect((s.data.get("payment") as { status: string }).status).toBe("pending");
  });

  it("pending -> expired when the alarm fires; the later canceled webhook is ignored", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    vi.useFakeTimers({ now: (p.expires + 1) * 1000, toFake: ["Date"] });
    await s.t.alarm();
    expect(ws.take()).toEqual([{ t: "status", pi: p.pi, status: "expired", amount: 2000, ref: "ref1" }]);
    expect(s.stripe.intents.get(p.pi)!.status).toBe("canceled");
    await s.event({ ...paid(p.pi), outcome: "canceled" });
    expect(ws.take()).toEqual([]);
  });

  it("an early alarm re-arms; an alarm with Stripe down retries in 30 s", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    s.state.alarm = null;
    await s.t.alarm();
    expect(s.state.alarm).toBe(p.expires * 1000);
    vi.useFakeTimers({ now: (p.expires + 1) * 1000, toFake: ["Date"] });
    s.stripe.down = true;
    await s.t.alarm();
    expect(ws.take()).toEqual([]);
    expect(s.state.alarm).toBe((p.expires + 1) * 1000 + 30_000);
  });

  it("pending -> failed on payment_failed, and the PI is canceled at Stripe", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    s.stripe.intents.get(p.pi)!.status = "requires_payment_method";
    await s.event({ ...paid(p.pi), outcome: "failed" });
    expect(ws.take()).toEqual([{ t: "status", pi: p.pi, status: "failed", amount: 2000, ref: "ref1" }]);
    expect(s.stripe.intents.get(p.pi)!.status).toBe("canceled");
  });

  it("a result that happened while offline is kept and delivered once on the next hello", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    ws.close();
    await s.event(paid(p.pi));
    expect((s.data.get("payment") as { status: string }).status).toBe("succeeded");
    const ws2 = s.connect();
    await s.say(ws2, { t: "hello" });
    expect(ws2.take()).toEqual([
      { t: "hello", device: "kiosk", live: false },
      { t: "status", pi: p.pi, status: "succeeded", amount: 2000, ref: "ref1" },
    ]);
    await s.say(ws2, { t: "hello" });
    expect(ws2.take()).toEqual([{ t: "hello", device: "kiosk", live: false }]);
  });

  it("a create never drops an undelivered result: it is sent first", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    ws.close();
    await s.event(paid(p.pi));
    const ws2 = s.connect();
    await s.say(ws2, { t: "create", amount: 2000, ref: "ref2" }); // (a kiosk sends hello first; be safe anyway)
    const [st, p2] = ws2.take();
    expect(st).toEqual({ t: "status", pi: p.pi, status: "succeeded", amount: 2000, ref: "ref1" });
    expect(p2).toMatchObject({ t: "payment", ref: "ref2" });
  });

  it("hello re-fetches a pending payment: paid while the webhook was lost -> succeeded", async () => {
    const s = setup();
    const { ws, p } = await paying(s);
    ws.close();
    s.stripe.intents.get(p.pi)!.status = "succeeded";
    const ws2 = s.connect();
    await s.say(ws2, { t: "hello" });
    expect(ws2.take()[1]).toEqual({ t: "status", pi: p.pi, status: "succeeded", amount: 2000, ref: "ref1" });
  });

  it("hello re-sends the QR of a payment that is still pending", async () => {
    const s = setup();
    const { p } = await paying(s);
    const ws2 = s.connect();
    await s.say(ws2, { t: "hello" });
    expect(ws2.take()[1]).toEqual({ t: "payment", ...p });
  });
});

describe("frames", () => {
  it("ignores oversized, non-JSON and unknown frames; answers ping", async () => {
    const s = setup();
    const ws = s.connect();
    await s.say(ws, JSON.stringify({ t: "create", amount: 2000, ref: "r", pad: "x".repeat(5000) }));
    await s.say(ws, "not json{");
    await s.say(ws, "null");
    await s.say(ws, { t: "bogus" });
    await s.t.webSocketMessage(ws as unknown as WebSocket, new TextEncoder().encode("x".repeat(5000)).buffer as ArrayBuffer);
    expect(ws.take()).toEqual([]);
    expect(s.stripe.calls).toHaveLength(0);
    await s.say(ws, { t: "ping" });
    expect(ws.take()).toEqual([{ t: "pong" }]);
  });
});

describe("Stripe key misconfiguration (fail closed, never call Stripe with a bad key)", () => {
  const logs = () => vi.spyOn(console, "log").mockImplementation(() => undefined);

  it.each([
    ["not set", undefined, "STRIPE_SECRET_KEY secret is not set"],
    ["empty", "", "STRIPE_SECRET_KEY secret is not set"],
    ["blank", "   \n", "STRIPE_SECRET_KEY secret is not set"],
    ["a publishable key", "pk_test_abc123", "STRIPE_SECRET_KEY is not a Stripe secret key"],
    ["a webhook secret", "whsec_abc123", "STRIPE_SECRET_KEY is not a Stripe secret key"],
    ["in quotes", '"sk_test_abc123"', "STRIPE_SECRET_KEY is not a Stripe secret key"],
  ])("create, STRIPE_SECRET_KEY %s: generic device error, clear log, no Stripe call", async (_what, key, line) => {
    const spy = logs();
    const s = setup({ STRIPE_SECRET_KEY: key });
    const ws = s.connect();
    await s.say(ws, { t: "create", amount: 2000, ref: "r1" });
    expect(ws.take()).toEqual([{ t: "error", ref: "r1", msg: "server misconfigured" }]);
    expect(s.stripe.calls).toHaveLength(0);
    const out = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain(line);
    expect(out).not.toContain("abc123"); // the (wrong) value itself is never logged
  });

  it("hello with a pending payment and a missing key: re-sends the QR, no Stripe call", async () => {
    logs();
    const s = setup();
    const { p } = await paying(s);
    delete s.env.STRIPE_SECRET_KEY; // secret deleted after the QR was made
    const before = s.stripe.calls.length;
    const ws2 = s.connect();
    await s.say(ws2, { t: "hello" });
    expect(ws2.take()).toEqual([{ t: "hello", device: "kiosk", live: false }, { t: "payment", ...p }]);
    expect(s.stripe.calls.length).toBe(before);
  });

  it("trims whitespace a paste may leave around the key", async () => {
    const s = setup({ STRIPE_SECRET_KEY: "  sk_test_unit\n" });
    const ws = s.connect();
    await s.say(ws, { t: "create", amount: 2000, ref: "r1" });
    expect(ws.take()[0]).toMatchObject({ t: "payment" });
    expect(s.stripe.calls[0]!.headers.Authorization).toBe("Bearer sk_test_unit");
  });

  it("a live key with whitespace is still reported as live", async () => {
    const s = setup({ STRIPE_SECRET_KEY: "rk_live_x\n" });
    const ws = s.connect();
    await s.say(ws, { t: "hello" });
    expect(ws.take()[0]).toEqual({ t: "hello", device: "kiosk", live: true });
  });
});

describe("frame limit", () => {
  it("counts bytes, not UTF-16 units: 2000 Thai characters (6000 bytes) are ignored", async () => {
    const s = setup();
    const ws = s.connect();
    await s.say(ws, JSON.stringify({ t: "create", amount: 2000, ref: "r", pad: "ก".repeat(2000) }));
    expect(ws.take()).toEqual([]);
    expect(s.stripe.calls).toHaveLength(0);
  });
});
