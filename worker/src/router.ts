// HTTP routes: device WebSocket (token auth) + Stripe webhook, both routed to the one Durable Object.
//   GET  /health          "ok"
//   GET  /ws              Authorization: Bearer <DEVICE_TOKEN>, WebSocket upgrade (PROTOCOL.md)
//   POST /stripe/webhook  signed Stripe events
import { isLiveKey, parseEvent, verifySignature } from "./stripe";
import type { Env } from "./terminal";
import { log, timingSafeEqual, validDeviceId } from "./util";

/** Stripe events are a few KB. */
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
  if (!env.DEVICE_TOKEN) {
    log("DEVICE_TOKEN secret is not set");
    return text("server misconfigured", 500);
  }
  if (!checkToken(req.headers.get("Authorization"), env.DEVICE_TOKEN)) {
    log("ws auth rejected");
    return text("unauthorized", 401);
  }
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return text("expected websocket upgrade", 426);
  const d = url.searchParams.get("device");
  return terminal(env).fetch("https://do/ws", { headers: { Upgrade: "websocket", "X-Device-Id": validDeviceId(d) ? d : "kiosk" } });
}

async function handleWebhook(req: Request, env: Env): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) return text("payload too large", 413);
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_WEBHOOK_BYTES) return text("payload too large", 413);
  const raw = new TextDecoder().decode(buf);
  if (!(await verifySignature(raw, req.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET ?? ""))) {
    log(env.STRIPE_WEBHOOK_SECRET ? "webhook rejected: bad signature" : "webhook rejected: STRIPE_WEBHOOK_SECRET is not set");
    return text("bad signature", 400);
  }
  const e = parseEvent(raw, isLiveKey(env.STRIPE_SECRET_KEY ?? ""));
  if (!e) return text("ignored"); // authentic but not for us: 200 so Stripe doesn't retry
  try {
    const r = await terminal(env).fetch("https://do/event", { method: "POST", body: JSON.stringify(e) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    log(`webhook ${e.pi} failed: ${(err as Error).message}`);
    return text("retry", 500); // Stripe retries later
  }
  return text("ok");
}

export default {
  async fetch(req, env): Promise<Response> {
    try {
      const url = new URL(req.url);
      switch (url.pathname) {
        case "/health":
          return text("ok");
        case "/ws":
          return await handleWs(req, env, url);
        case "/stripe/webhook":
          return req.method === "POST" ? await handleWebhook(req, env) : text("method not allowed", 405);
        default:
          return text("not found", 404);
      }
    } catch (e) {
      log(`unhandled error: ${(e as Error)?.message ?? String(e)}`); // never leak a stack trace
      return text("internal error", 500);
    }
  },
} satisfies ExportedHandler<Env>;
