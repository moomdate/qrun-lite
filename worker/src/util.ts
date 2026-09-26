// Small helpers: constant-time compare, HMAC, input validation, log hygiene.

/** Constant-time string compare (always walks the longer input; the length difference is folded in). */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `ref` from the device: 1..40 printable ASCII chars. It goes into an HTTP header, Stripe metadata and logs. */
export function validRef(v: unknown): v is string {
  return typeof v === "string" && /^[\x21-\x7e]{1,40}$/.test(v);
}

/** Device id from `/ws?device=` (only echoed back in `hello` and stored in Stripe metadata). */
export function validDeviceId(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v);
}

/** PRICE_SATANG var -> satang, or null if it isn't an integer in 1000..15000000 (฿10 is Stripe's THB minimum). */
export function parsePrice(raw: string | undefined): number | null {
  if (!/^\d{4,8}$/.test((raw ?? "").trim())) return null;
  const n = Number(raw);
  return n >= 1000 && n <= 15_000_000 ? n : null;
}

/** Redact Stripe keys / webhook secrets, strip control chars (no log-line forging), truncate. */
export function logSafe(s: string, max = 500): string {
  let out = s
    .replace(/\b([sprk]k_(?:live|test)_)[A-Za-z0-9*]+/g, "$1[redacted]")
    .replace(/\bwhsec_[A-Za-z0-9*]+/g, "whsec_[redacted]")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  if (out.length > max) out = `${out.slice(0, max)}…`;
  return out;
}

export const log = (line: string): void => console.log(logSafe(line));
