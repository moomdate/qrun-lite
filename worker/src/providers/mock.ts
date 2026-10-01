// Mock provider: for local development and tests ONLY. It moves no money; anyone holding MOCK_WEBHOOK_SECRET can
// mark a payment as paid. So it refuses to run unless explicitly enabled, and never next to a live Stripe key.
//
//   PAYMENT_PROVIDER=mock
//   ALLOW_MOCK_PAYMENTS=<MOCK_ENABLE_PHRASE>
//   MOCK_WEBHOOK_SECRET=<>= 16 chars>        then:  POST /webhook/mock   Authorization: Bearer <secret>
//   body {"outcome":"succeeded"|"failed"|"canceled","id":"mock_<ref>","amount":2000,"ref":"<ref>"}
//
// Stateless: the payment id is derived from the ref and getStatus always says "pending" (use the webhook).
import type { Env } from "../env";
import { secret, timingSafeEqual } from "../util";
import type { CreateArgs, PaymentEvent, PaymentProvider, PaymentStatus, ProviderResult, QrPayment, WebhookResult } from "./types";
import { isLiveKey } from "./stripe";

export const MOCK_ENABLE_PHRASE = "yes-this-takes-no-real-money";
const MIN_SECRET = 16;

export class MockProvider implements PaymentProvider {
  readonly name = "mock";
  private readonly allow: string;
  private readonly whsec: string;
  private readonly stripeKey: string;

  constructor(env: Env) {
    this.allow = secret(env.ALLOW_MOCK_PAYMENTS);
    this.whsec = secret(env.MOCK_WEBHOOK_SECRET);
    this.stripeKey = secret(env.STRIPE_SECRET_KEY);
  }

  isLive = () => false; // the kiosk shows TEST

  configProblem(): string | null {
    if (this.allow !== MOCK_ENABLE_PHRASE) return "mock provider is disabled: set ALLOW_MOCK_PAYMENTS (local development only)";
    if (isLiveKey(this.stripeKey)) return "mock provider refused: a live Stripe key is configured";
    if (this.whsec.length < MIN_SECRET) return `MOCK_WEBHOOK_SECRET must be at least ${MIN_SECRET} characters`;
    return null;
  }

  private refuse(): ProviderResult<never> | null {
    const p = this.configProblem();
    return p ? { ok: false, status: -1, msg: p, deviceMsg: "server misconfigured" } : null;
  }

  async createQr(a: CreateArgs): Promise<ProviderResult<QrPayment>> {
    const id = `mock_${a.ref}`;
    return this.refuse() ?? { ok: true, value: { id, qrPayload: `MOCK-QR|${id}|${a.amount}`, amount: a.amount } };
  }

  async getStatus(_id: string): Promise<ProviderResult<PaymentStatus>> {
    return this.refuse() ?? { ok: true, value: "pending" };
  }

  async cancel(_id: string): Promise<ProviderResult<void>> {
    return this.refuse() ?? { ok: true, value: undefined };
  }

  async parseWebhook(raw: string, headers: Headers): Promise<WebhookResult> {
    if (this.configProblem()) return { kind: "bad", reason: "mock provider disabled" };
    const auth = headers.get("Authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !timingSafeEqual(auth.slice(7).trim(), this.whsec)) return { kind: "bad", reason: "bad token" };
    let b: Partial<Record<keyof PaymentEvent, unknown>>;
    try {
      b = JSON.parse(raw);
    } catch {
      return { kind: "ignored" };
    }
    if ((b.outcome !== "succeeded" && b.outcome !== "failed" && b.outcome !== "canceled") || typeof b.id !== "string") return { kind: "ignored" };
    return {
      kind: "event",
      event: { outcome: b.outcome, id: b.id, amount: typeof b.amount === "number" ? b.amount : -1, currency: "thb", ref: typeof b.ref === "string" ? b.ref : "" },
    };
  }
}
