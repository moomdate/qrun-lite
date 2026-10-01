// HTTP routes: device WebSocket (token auth) + Stripe webhook, both routed to the one Durable Object.
//   GET  /health          "ok"
//   GET  /ws              Authorization: Bearer <DEVICE_TOKEN>, WebSocket upgrade (PROTOCOL.md)
//   POST /webhook/<provider>  authenticated provider notifications (<provider> must be the active PAYMENT_PROVIDER)
//   POST /stripe/webhook      the original path of the Stripe endpoint, same as /webhook/stripe (keep: deployed endpoints use it)
import type { Env } from "./env";
import { resolveProvider } from "./providers";
import { log, MIN_DEVICE_TOKEN, secret, timingSafeEqual, validDeviceId } from "./util";

/** Webhook bodies are a few KB. */
export const MAX_WEBHOOK_BYTES = 64 * 1024;

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });
const terminal = (env: Env) => env.TERMINAL.get(env.TERMINAL.idFromName("kiosk")); // Lite: exactly one kiosk

/** True if the `Authorization` header carries DEVICE_TOKEN (constant-time compare). */
export function checkToken(authorization: string | null, expected: string): boolean {
  const presented = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  return timingSafeEqual(presented, expected) && presented.length > 0 && expected.length > 0;
}

async function handleWs(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method !== "GET") return text("method not allowed", 405);
  const token = secret(env.DEVICE_TOKEN);
  if (!token) {
    log("DEVICE_TOKEN secret is not set");
    return text("server misconfigured", 500);
  }
  if (token.length < MIN_DEVICE_TOKEN) {
    log(`DEVICE_TOKEN is too short (${token.length} chars, minimum ${MIN_DEVICE_TOKEN}): set one from \`openssl rand -hex 24\``);
    return text("server misconfigured", 500);
  }
  if (!checkToken(req.headers.get("Authorization"), token)) {
    log("ws auth rejected");
    return text("unauthorized", 401);
  }
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return text("expected websocket upgrade", 426);
  const d = url.searchParams.get("device");
  return terminal(env).fetch("https://do/ws", { headers: { Upgrade: "websocket", "X-Device-Id": validDeviceId(d) ? d : "kiosk" } });
}

async function handleWebhook(req: Request, env: Env, name: string): Promise<Response> {
  const provider = resolveProvider(env);
  if (provider.name !== name) return text("not found", 404); // only the active provider has a webhook
  if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return text("payload too large", 413);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_WEBHOOK_BYTES) return text("payload too large", 413);
  const raw = new TextDecoder().decode(buf);
  const w = await provider.parseWebhook(raw, req.headers);
  if (w.kind === "bad") {
    log(`webhook rejected: ${w.reason}`);
    return text("bad signature", 400);
  }
  if (w.kind === "ignored") return text("ignored"); // authentic but not for us: 200 so the provider doesn't retry
  const e = w.event;
  try {
    const r = await terminal(env).fetch("https://do/event", { method: "POST", body: JSON.stringify(e) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    log(`webhook ${e.id} failed: ${(err as Error).message}`);
    return text("retry", 500); // the provider retries later
  }
  return text("ok");
}

const WEBHOOK_PATH = /^\/webhook\/([a-z0-9_-]{1,32})$/;

export default {
  async fetch(req, env): Promise<Response> {
    try {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/health":
          return text("ok");
        case "/ws":
          return await handleWs(req, env, url);
        default: {
          const name = url.pathname === "/stripe/webhook" ? "stripe" : WEBHOOK_PATH.exec(url.pathname)?.[1];
          if (!name) return text("not found", 404);
          return req.method === "POST" ? await handleWebhook(req, env, name) : text("method not allowed", 405);
        }
      }
    } catch (e) {
      log(`unhandled error: ${(e as Error)?.message ?? String(e)}`); // never leak a stack trace
      return text("internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;
