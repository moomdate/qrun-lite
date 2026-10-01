// Pure kiosk logic: what to do with each Worker frame, plus small formatting helpers.
// No Arduino here, so it is unit-tested on the host: `pio test -e native`.
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace lite {

enum Screen : uint8_t { IDLE, CREATING, QR, RUNNING, MESSAGE, SPLASH };   // SPLASH: the boot credit, first ~1.8 s
enum Message : uint8_t { MSG_CANCELED, MSG_EXPIRED, MSG_FAILED, MSG_ERROR };

// Longest payment id / QR payload the kiosk keeps. A longer QR can't be drawn (see qrVersionFor).
static constexpr size_t PI_MAX = 63;
static constexpr size_t QR_MAX = 520;

inline bool empty(const char* s) { return !s || !*s; }
inline bool same(const char* a, const char* b) { return !empty(a) && !empty(b) && strcmp(a, b) == 0; }

// What the kiosk is doing, as far as frame decisions care.
struct State {
  Screen screen;
  const char* ref;        // ref of our create (CREATING / QR)
  const char* pi;         // payment shown (QR)
  const char* lastRunPi;  // last payment the relay ran for
};

enum Action : uint8_t {
  IGNORE,
  SHOW_QR,        // show this payment's QR
  REJECT_QR,      // ours, but too big to keep: cancel it and show an error
  DISCARD_QR,     // a pending payment we did not ask for (e.g. after a reboot): cancel it quietly
  RUN,            // paid: switch the relay on
  DEFER_RUN,      // paid while the boot splash is up: remember it, run the relay when the splash ends
  SHOW_RESULT,    // canceled / expired / failed: show the message
  SHOW_ERROR,     // our create failed
  CANCEL_FAILED,  // our cancel failed: let the customer press it again
};

// {"t":"payment", pi, ref, qr}
inline Action onPayment(const State& s, const char* pi, const char* ref, const char* qr) {
  if (empty(pi) || empty(qr)) return IGNORE;
  // Still pending after a reboot: nobody is standing at the kiosk waiting for that QR any more, so don't pop it
  // up on its own — cancel it. If the customer had already paid, the cancel is refused and the Worker sends
  // "succeeded", which runs the relay as usual.
  // The same goes for any payment that arrives while no QR can be shown (after the create timed out, or while the
  // relay runs because an earlier QR was paid): nobody can pay it, so don't leave it payable until the Worker's TTL.
  if (s.screen == IDLE || s.screen == MESSAGE || s.screen == RUNNING || s.screen == SPLASH) return DISCARD_QR;
  bool ours = (s.screen == CREATING && same(ref, s.ref)) ||
              (s.screen == QR && same(pi, s.pi));     // re-sent after a reconnect
  if (!ours) return IGNORE;
  return strlen(pi) <= PI_MAX && strlen(qr) <= QR_MAX ? SHOW_QR : REJECT_QR;
}

// {"t":"status", pi, status}
inline Action onStatus(const State& s, const char* pi, const char* status) {
  if (empty(pi) || strlen(pi) > PI_MAX) return IGNORE;
  if (s.screen == RUNNING) return IGNORE;                        // never restart or extend a run
  if (same(status, "succeeded")) {   // paid is paid, whatever is on screen
    if (same(pi, s.lastRunPi)) return IGNORE;
    return s.screen == SPLASH ? DEFER_RUN : RUN;   // the splash never switches the relay; it runs right after
  }
  if (same(pi, s.pi) && s.screen == QR) return SHOW_RESULT;
  return IGNORE;
}

// {"t":"error", ref?, msg}
inline Action onError(const State& s, const char* ref) {
  if (s.screen == CREATING && (empty(ref) || same(ref, s.ref))) return SHOW_ERROR;
  if (s.screen == QR && same(ref, s.ref)) return CANCEL_FAILED;
  return IGNORE;
}

inline Message messageFor(const char* status) {
  if (same(status, "canceled")) return MSG_CANCELED;
  if (same(status, "expired")) return MSG_EXPIRED;
  if (same(status, "failed")) return MSG_FAILED;
  return MSG_ERROR;
}

// Milliseconds from `since` to `now`, 0 if `since` is later (it was stamped after `now` was read, e.g. a screen
// change in the same loop pass). A plain `now - since` on uint32_t wraps to ~4.29e9 there and fires every timeout.
inline uint32_t elapsedMs(uint32_t now, uint32_t since) {
  int32_t d = (int32_t)(now - since);
  return d < 0 ? 0 : (uint32_t)d;
}

// Ignore taps for the first `guard` ms after boot. Sticky: once passed it stays passed, so the 49.7-day millis()
// wrap doesn't bring back a "just booted" window (a plain `now > guard` would).
struct BootGuard {
  bool over = false;
  bool passed(uint32_t now, uint32_t guard) {
    if (!over && now >= guard) over = true;
    return over;
  }
};

// A timer that fires once. Wrap-safe, and has its own "running" flag, so an end time that happens to be 0 after
// the millis() wrap is not mistaken for "not running".
struct OneShot {
  bool running = false;
  uint32_t end = 0;
  void start(uint32_t now, uint32_t ms) { running = true; end = now + ms; }
  bool due(uint32_t now) {
    if (!running || (int32_t)(now - end) < 0) return false;
    running = false;
    return true;
  }
};

// esp_reset_reason() as text for the boot log (values of ESP-IDF's esp_reset_reason_t; main.cpp checks them).
inline const char* resetReasonName(int r) {
  static const char* const N[] = {"UNKNOWN", "POWERON", "EXT", "SW", "PANIC", "INT_WDT", "TASK_WDT", "WDT",
                                  "DEEPSLEEP", "BROWNOUT", "SDIO", "USB", "JTAG", "EFUSE", "PWR_GLITCH", "CPU_LOCKUP"};
  return r >= 0 && r < (int)(sizeof N / sizeof N[0]) ? N[r] : "UNKNOWN";
}

// A reset nobody asked for: a crash, a watchdog, or the supply voltage sagging (BROWNOUT, PWR_GLITCH).
inline bool resetWasFault(int r) { return (r >= 4 && r <= 7) || r == 9 || r == 14 || r == 15; }

// Resistive touch glitches (noise at power-up, a finger sliding) must not count as taps: a tap is a press
// held continuously for TAP_HOLD_MS at a point on the screen, and counts once per press.
struct TapFilter {
  static constexpr uint32_t TAP_HOLD_MS = 40;
  uint32_t downAt = 0;
  bool down = false, fired = false;
  bool update(bool pressed, uint32_t now, int x, int y) {
    if (!pressed) { down = fired = false; return false; }
    if (!down) { down = true; downAt = now; return false; }
    if (fired || now - downAt < TAP_HOLD_MS) return false;
    if (x < 0 || x >= 320 || y < 0 || y >= 240) return false;
    fired = true;
    return true;
  }
};

// Seconds a QR has left: from the Worker's `expires` (unix s) when the clock is NTP-synced, else `fallback`.
inline uint32_t secondsLeft(int64_t expires, int64_t now, uint32_t fallback) {
  if (now < 1700000000 || expires <= 0) return fallback;
  int64_t r = expires - now;
  return r < 0 ? 0 : r > 3600 ? 3600 : (uint32_t)r;
}

// ricmoo/QRCode silently corrupts data that overflows a version: pick it from the byte-mode ECC_LOW
// capacity table, v3..v15. 0 = too long.
inline uint8_t qrVersionFor(size_t len) {
  static const uint16_t cap[] = {0, 17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 321, 367, 425, 458, 520};
  uint8_t v = 3;
  while (v < 15 && cap[v] < len) v++;
  return cap[v] >= len ? v : 0;
}

// CRC-32 (IEEE, as zlib/PNG), continuing from `crc` (0 to start).
inline uint32_t crc32(uint32_t crc, const uint8_t* p, size_t n) {
  crc = ~crc;
  while (n--) {
    crc ^= *p++;
    for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1)));
  }
  return ~crc;
}

// CRC over the birdlab.th credit: both logo masks, the "crafted by" label and the splash wordmark. The expected
// value lives in include/credit_crc.h, away from the splash code.
inline uint32_t creditCrc(const uint8_t* logo, size_t logoLen, const uint8_t* small, size_t smallLen,
                          const char* crafted, const char* wordmark) {
  uint32_t c = crc32(0, logo, logoLen);
  c = crc32(c, small, smallLen);
  c = crc32(c, (const uint8_t*)crafted, strlen(crafted));
  return crc32(c, (const uint8_t*)wordmark, strlen(wordmark));
}

// Unmodified credit AND the splash ran to its end this boot. Only the header label depends on it; payments never do.
inline bool authentic(bool splashCompleted, uint32_t actualCrc, uint32_t expectedCrc) {
  return splashCompleted && actualCrc == expectedCrc;
}

// 2000 -> "20", 2050 -> "20.50"
inline char* formatBaht(uint32_t satang, char* out, size_t n) {
  if (satang % 100) snprintf(out, n, "%lu.%02lu", (unsigned long)(satang / 100), (unsigned long)(satang % 100));
  else snprintf(out, n, "%lu", (unsigned long)(satang / 100));
  return out;
}

// 65 -> "1:05"
inline char* formatClock(uint32_t sec, char* out, size_t n) {
  snprintf(out, n, "%lu:%02lu", (unsigned long)(sec / 60), (unsigned long)(sec % 60));
  return out;
}

// create ref: 12 lowercase hex chars from two random words (the Worker accepts 1..40 printable ASCII).
inline char* formatRef(uint32_t a, uint32_t b, char* out, size_t n) {
  snprintf(out, n, "%08lx%04lx", (unsigned long)a, (unsigned long)(b & 0xFFFF));
  return out;
}

}  // namespace lite
