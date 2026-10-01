// The Worker's bindings, secrets and vars. Providers read their own settings from here (one block per provider).
export interface Env {
  TERMINAL: DurableObjectNamespace;
  DEVICE_TOKEN?: string; // secret
  PRICE_SATANG?: string; // var: the only amount a device may charge
  PAYMENT_TTL_SEC?: string; // var: QR lifetime
  RECEIPT_EMAIL?: string; // var: PromptPay needs a billing email (Stripe)
  PAYMENT_PROVIDER?: string; // var: which provider in providers/index.ts; default "stripe"

  // Stripe (providers/stripe.ts)
  STRIPE_SECRET_KEY?: string; // secret
  STRIPE_WEBHOOK_SECRET?: string; // secret
  STRIPE_API_BASE?: string; // tests only (mock Stripe): used for test keys and loopback URLs only

  // Mock (providers/mock.ts), local development and tests ONLY
  ALLOW_MOCK_PAYMENTS?: string; // must be exactly MOCK_ENABLE_PHRASE, or the mock refuses to run
  MOCK_WEBHOOK_SECRET?: string; // secret, >= 16 chars: Authorization: Bearer <it> on POST /webhook/mock
}
