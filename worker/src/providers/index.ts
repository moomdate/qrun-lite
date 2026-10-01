// Provider registry. To add a provider: write src/providers/<name>.ts and add ONE line to REGISTRY.
// Select it with the PAYMENT_PROVIDER var (default "stripe"). Guide: docs/payment-providers.md
import type { Env } from "../env";
import { MockProvider } from "./mock";
import { StripeProvider } from "./stripe";
import type { PaymentProvider, ProviderFactory } from "./types";

export const REGISTRY: Record<string, ProviderFactory> = {
  stripe: (env) => new StripeProvider(env),
  mock: (env) => new MockProvider(env), // refuses to run unless ALLOW_MOCK_PAYMENTS is set (see mock.ts)
};

export const DEFAULT_PROVIDER = "stripe";

/** Name chosen by PAYMENT_PROVIDER (trimmed, lower-case; empty = default). */
export const providerName = (env: Env): string => (env.PAYMENT_PROVIDER ?? "").trim().toLowerCase() || DEFAULT_PROVIDER;

/** Fails closed: an unknown name gives a provider that refuses every call, never a silent fallback to Stripe. */
export function resolveProvider(env: Env): PaymentProvider {
  const name = providerName(env);
  const make = Object.hasOwn(REGISTRY, name) ? REGISTRY[name] : undefined;
  return make ? make(env) : unknownProvider(name);
}

function unknownProvider(name: string): PaymentProvider {
  const problem = `PAYMENT_PROVIDER "${name.slice(0, 40)}" is not a known provider (${Object.keys(REGISTRY).join(", ")})`;
  const no = { ok: false, status: -1, msg: problem, deviceMsg: "server misconfigured" } as const;
  return {
    name,
    isLive: () => false,
    configProblem: () => problem,
    createQr: async () => no,
    getStatus: async () => no,
    cancel: async () => no,
    parseWebhook: async () => ({ kind: "bad", reason: problem }),
  };
}
