// HTTP entry points: device token check, webhook gatekeeping, error hygiene.
import { describe, expect, it, vi } from "vitest";
import worker, { checkToken, MAX_WEBHOOK_BYTES } from "../src/router";
import type { Env } from "../src/terminal";
import { hmacSha256Hex, logSafe, timingSafeEqual } from "../src/util";
import { env as baseEnv, TOKEN } from "./fakes";

/** Env whose Durable Object stub records what reaches it. */
function envWithDo(over: Partial<Env> = {}) {
  const hits: { url: string; headers: Headers; body: string }[] = [];
  const stub = {
    fetch: vi.fn(async (url: string, init: RequestInit = {}) => {
      hits.push({ url, headers: new Headers(init.headers), body: String(init.body ?? "") });
      return new Response("ok");
    }),
  };
  const TERMINAL = { idFromName: (n: string) => n, get: () => stub } as unknown as DurableObjectNamespace;
  return { env: baseEnv({ TERMINAL, ...over }), hits };
}
const call = (req: Request, env: Env) => worker.fetch(req as Request<unknown, IncomingRequestCfProperties>, env);
const ws = (headers: Record<string, string> = {}, query = "") =>
  new Request(`https://w/ws${query}`, { headers: { Upgrade: "websocket", ...headers } });

describe("device token", () => {
  it("checkToken", () => {
    expect(checkToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(checkToken(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(checkToken(TOKEN, TOKEN)).toBe(false); // no scheme
    expect(checkToken("Bearer ", "")).toBe(false); // empty configured token never matches
    expect(checkToken(null, TOKEN)).toBe(false);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });

  it.each([
    ["no header", {}, ""],
    ["wrong token", { Authorization: "Bearer nope" }, ""],
    ["token in the query string", {}, `?token=${TOKEN}`],
    ["Basic scheme", { Authorization: `Basic ${TOKEN}` }, ""],
  ])("401 for %s, nothing reaches the Durable Object", async (_what, headers, query) => {
    const { env, hits } = envWithDo();
    expect((await call(ws(headers, query), env)).status).toBe(401);
    expect(hits).toHaveLength(0);
  });

  it("500 (fail closed) when DEVICE_TOKEN is not set", async () => {
    const { env } = envWithDo({ DEVICE_TOKEN: undefined });
    const r = await call(ws({ Authorization: "Bearer " }), env);
    expect(r.status).toBe(500);
    expect(await r.text()).toBe("server misconfigured");
  });

  it("500 (fail closed) for a weak DEVICE_TOKEN shorter than 16 characters, even when presented correctly", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env, hits } = envWithDo({ DEVICE_TOKEN: "1234" });
    const r = await call(ws({ Authorization: "Bearer 1234" }), env);
    expect(r.status).toBe(500);
    expect(hits).toHaveLength(0);
    expect(String(spy.mock.calls.at(-1)?.[0])).toContain("DEVICE_TOKEN is too short");
    spy.mockRestore();
  });

  it("accepts a DEVICE_TOKEN secret stored with a trailing newline (piped paste)", async () => {
    const { env, hits } = envWithDo({ DEVICE_TOKEN: `${TOKEN}\n` });
    await call(ws({ Authorization: `Bearer ${TOKEN}` }), env);
    expect(hits).toHaveLength(1);
  });

  it("426 without an upgrade header; forwards a valid upgrade with a sanitized device id", async () => {
    const { env, hits } = envWithDo();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await call(new Request("https://w/ws", { headers: auth }), env)).status).toBe(426);
    await call(ws(auth, "?device=pos-01"), env);
    await call(ws(auth, "?device=bad%20id%2F"), env);
    expect(hits.map((h) => h.headers.get("X-Device-Id"))).toEqual(["pos-01", "kiosk"]);
  });
});

describe("webhook", () => {
  const body = JSON.stringify({
    type: "payment_intent.succeeded",
    livemode: false,
    data: { object: { id: "pi_1", object: "payment_intent", amount: 2000, currency: "thb", status: "succeeded", metadata: { ref: "r1" } } },
  });
  const signed = async (b: string, secret = "whsec_unit") => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${b}`)}`;
  };
  const post = (b: string, sig?: string) =>
    new Request("https://w/stripe/webhook", { method: "POST", body: b, headers: sig ? { "Stripe-Signature": sig } : {} });

  it("routes a correctly signed event to the Durable Object", async () => {
    const { env, hits } = envWithDo();
    expect((await call(post(body, await signed(body)), env)).status).toBe(200);
    expect(JSON.parse(hits[0]!.body)).toEqual({ outcome: "succeeded", id: "pi_1", amount: 2000, currency: "thb", ref: "r1" });
  });

  it.each([
    ["no signature", undefined],
    ["wrong secret", "WRONG"],
  ])("400 for %s, nothing reaches the Durable Object", async (_what, which) => {
    const { env, hits } = envWithDo();
    const sig = which === "WRONG" ? await signed(body, "whsec_other") : undefined;
    expect((await call(post(body, sig), env)).status).toBe(400);
    expect(hits).toHaveLength(0);
  });

  it("accepts a webhook secret stored with surrounding whitespace", async () => {
    const { env, hits } = envWithDo({ STRIPE_WEBHOOK_SECRET: " whsec_unit\n" });
    expect((await call(post(body, await signed(body)), env)).status).toBe(200);
    expect(hits).toHaveLength(1);
  });

  it("400 for a correctly signed but stale (replayed > 300 s later) event", async () => {
    const { env, hits } = envWithDo();
    const t = Math.floor(Date.now() / 1000) - 301;
    const sig = `t=${t},v1=${await hmacSha256Hex("whsec_unit", `${t}.${body}`)}`;
    expect((await call(post(body, sig), env)).status).toBe(400);
    expect(hits).toHaveLength(0);
  });

  it("does not leak internals: a Durable Object failure is a plain 500 'retry'", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { env } = envWithDo();
    (env.TERMINAL.get as unknown as () => { fetch: () => Promise<Response> }) = () => ({
      fetch: async () => {
        throw new Error("internal detail sk_live_FAKE1 whsec_FAKE2");
      },
    });
    const r = await call(post(body, await signed(body)), env);
    expect([r.status, await r.text()]).toEqual([500, "retry"]);
    expect(spy.mock.calls.map((c) => String(c[0])).join()).not.toMatch(/FAKE1|FAKE2/);
    spy.mockRestore();
  });

  it("answers 200 'ignored' for authentic events that are not ours", async () => {
    const { env, hits } = envWithDo();
    const other = body.replace('"livemode":false', '"livemode":true');
    const r = await call(post(other, await signed(other)), env);
    expect(await r.text()).toBe("ignored");
    expect(hits).toHaveLength(0);
  });

  it("413 for oversized bodies, 405 for GET, 404 elsewhere", async () => {
    const { env } = envWithDo();
    const big = "x".repeat(MAX_WEBHOOK_BYTES + 1);
    expect((await call(post(big, await signed(big)), env)).status).toBe(413);
    expect((await call(new Request("https://w/stripe/webhook"), env)).status).toBe(405);
    expect((await call(new Request("https://w/admin"), env)).status).toBe(404);
    expect(await (await call(new Request("https://w/health"), env)).text()).toBe("ok");
  });
});

describe("logSafe", () => {
  it("redacts Stripe secrets and control characters", () => {
    expect(logSafe("key sk_live_abc123 rk_test_x whsec_abc sk_test_****abcd")).toBe(
      "key sk_live_[redacted] rk_test_[redacted] whsec_[redacted] sk_test_[redacted]",
    );
    expect(logSafe("a\nFORGED b")).toBe("a?FORGED b");
  });
});
