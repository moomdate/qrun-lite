// Stripe webhook signature verification and event parsing.
import { describe, expect, it } from "vitest";
import { parseEvent, verifySignature } from "../src/providers/stripe";
import { hmacSha256Hex } from "../src/util";

const SECRET = "whsec_unit";
const NOW = 1_800_000_000;
const sig = (body: string, t = NOW, secret = SECRET) => hmacSha256Hex(secret, `${t}.${body}`);
const header = async (body: string, t = NOW, secret = SECRET) => `t=${t},v1=${await sig(body, t, secret)}`;
const BODY = '{"id":"evt_1","type":"payment_intent.succeeded"}';

describe("verifySignature", () => {
  it("accepts a valid signature", async () => {
    expect(await verifySignature(BODY, await header(BODY), SECRET, NOW)).toBe(true);
  });

  it("accepts any matching v1 (secret rotation)", async () => {
    expect(await verifySignature(BODY, `t=${NOW},v1=${"0".repeat(64)},v1=${await sig(BODY)}`, SECRET, NOW)).toBe(true);
  });

  it("accepts timestamps up to 300 s off, rejects beyond", async () => {
    expect(await verifySignature(BODY, await header(BODY, NOW - 300), SECRET, NOW)).toBe(true);
    expect(await verifySignature(BODY, await header(BODY, NOW - 301), SECRET, NOW)).toBe(false);
    expect(await verifySignature(BODY, await header(BODY, NOW + 301), SECRET, NOW)).toBe(false);
  });

  it.each([
    ["wrong secret", () => header(BODY, NOW, "whsec_other")],
    ["tampered body", () => header(`${BODY} `)],
    ["missing header", async () => null],
    ["no timestamp", async () => `v1=${await sig(BODY)}`],
    ["no v1", async () => `t=${NOW},v0=${await sig(BODY)}`],
    ["garbage", async () => "hello"],
    ["too long", async () => `t=${NOW},v1=${await sig(BODY)},${"x".repeat(1100)}`],
    ["too many v1", async () => `t=${NOW},${Array(9).fill(`v1=${await sig(BODY)}`).join(",")}`],
  ])("rejects %s", async (_what, h) => {
    expect(await verifySignature(BODY, await h(), SECRET, NOW)).toBe(false);
  });

  it("rejects everything when no secret is configured", async () => {
    expect(await verifySignature(BODY, await header(BODY), "", NOW)).toBe(false);
  });
});

describe("parseEvent", () => {
  const ev = (over: object = {}, obj: object = {}) =>
    JSON.stringify({
      type: "payment_intent.succeeded",
      livemode: false,
      data: { object: { id: "pi_1", object: "payment_intent", amount: 2000, currency: "thb", status: "succeeded", metadata: { ref: "r1" }, ...obj } },
      ...over,
    });

  it("maps the three handled event types", () => {
    expect(parseEvent(ev(), false)).toEqual({ outcome: "succeeded", id: "pi_1", amount: 2000, currency: "thb", ref: "r1" });
    expect(parseEvent(ev({ type: "payment_intent.payment_failed" }, { status: "requires_payment_method" }), false)?.outcome).toBe("failed");
    expect(parseEvent(ev({ type: "payment_intent.canceled" }, { status: "canceled" }), false)?.outcome).toBe("canceled");
  });

  it.each([
    ["livemode mismatch", ev({ livemode: true })],
    ["unhandled type", ev({ type: "charge.succeeded" })],
    ["prototype key as type", ev({ type: "__proto__" })],
    ["Connect event", ev({ account: "acct_1" })],
    ["not a payment_intent", ev({}, { object: "charge" })],
    ["succeeded event with a non-succeeded object", ev({}, { status: "requires_action" })],
    ["bad JSON", "{"],
  ])("ignores %s", (_what, body) => {
    expect(parseEvent(body, false)).toBeNull();
  });

  it("accepts live events only with a live key", () => {
    expect(parseEvent(ev({ livemode: true }), true)?.id).toBe("pi_1");
  });
});
