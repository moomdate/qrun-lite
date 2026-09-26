// QRun Lite: tap the price, scan the PromptPay QR, the relay runs.
//
//   IDLE ──tap──▶ CREATING ──payment──▶ QR ──status succeeded──▶ RUNNING ──time up──▶ IDLE
//                    │                   ├──cancel / expired / failed──▶ MESSAGE ──4 s or tap──▶ IDLE
//                    └──error / 20 s─────┴──────────────────────────────▶ MESSAGE
//
// The board never holds a Stripe key: it talks to your Cloudflare Worker with its own device token (secrets.h).
// Wire format: ../../PROTOCOL.md. Frame decisions: ../include/logic.h (host-tested).
#include <Arduino.h>
#include "config.h"
#include "hw.h"
#include "logic.h"
#include "net.h"
#include "root_ca.h"
#include "ui.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#error "Missing include/secrets.h: copy include/secrets.h.example to include/secrets.h and fill it in (README step 5)"
#endif

#ifndef WS_USE_TLS
#define WS_USE_TLS 1
#endif
#if !WS_USE_TLS
#warning "WS_USE_TLS 0: the device token is sent in cleartext. Only for a local `wrangler dev`."
#endif

using namespace lite;

static constexpr const char* FW_VERSION = "lite-1.0.0";
static constexpr uint32_t CREATE_TIMEOUT_MS = 20000;   // no answer to a create
static constexpr uint32_t CANCEL_TIMEOUT_MS = 10000;   // no answer to a cancel: back to IDLE (the QR expires anyway)
static constexpr uint32_t QR_GRACE_MS = 15000;         // the Worker should report "expired" first
static constexpr uint32_t MESSAGE_MS = 4000;
static constexpr uint32_t FALLBACK_TTL_SEC = 120;      // QR countdown before NTP time is known

static Screen screen = IDLE;
static char ref[16] = "", pi[PI_MAX + 1] = "", qr[QR_MAX + 1] = "", lastRunPi[PI_MAX + 1] = "";
static uint32_t since = 0, qrDeadline = 0, runUntil = 0, cancelAt = 0, lastDraw = 0;
static bool wifi = false, online = false, live = true, cancelling = false, dirty = true;
static Message message = MSG_ERROR;

static void go(Screen s) {
  screen = s;
  since = millis();
  dirty = true;
}

static void showMessage(Message m) {
  message = m;
  if (m != MSG_CANCELED) hw::beepError();
  go(MESSAGE);
}

static void run(const char* paidPi) {
  hw::relayOn(cfg::RUN_SECONDS * 1000);   // first: the esp_timer switches it off even if loop() hangs
  strlcpy(lastRunPi, paidPi, sizeof lastRunPi);
  runUntil = millis() + cfg::RUN_SECONDS * 1000;
  Serial.printf("[RUN] %s: relay on for %lu s\n", paidPi, (unsigned long)cfg::RUN_SECONDS);
  hw::beepPaid();
  go(RUNNING);
}

static State state() { return State{screen, ref, pi, lastRunPi}; }

// ---------------------------------------------------------------- Worker frames

static void onLinkUp() { net::hello(FW_VERSION); }
static void onLinkDown() { online = false; dirty = true; }
static void onHello(bool isLive) { online = true; live = isLive; dirty = true; }

static void onPayment(const char* id, const char* r, const char* data, int64_t expires) {
  switch (lite::onPayment(state(), id, r, data)) {
    case SHOW_QR:
      if (!same(id, pi) || screen != QR) cancelling = false;
      strlcpy(pi, id, sizeof pi);
      strlcpy(ref, r, sizeof ref);
      strlcpy(qr, data, sizeof qr);
      qrDeadline = millis() + secondsLeft(expires, (int64_t)time(nullptr), FALLBACK_TTL_SEC) * 1000;
      go(QR);
      break;
    case REJECT_QR:
      net::cancel(id);
      showMessage(MSG_ERROR);
      break;
    default:
      break;
  }
}

static void onStatus(const char* id, const char* status) {
  switch (lite::onStatus(state(), id, status)) {
    case RUN: run(id); break;
    case SHOW_RESULT: showMessage(messageFor(status)); break;
    default: break;
  }
}

static void onError(const char* r, const char* msg) {
  Serial.printf("[ERR] %s\n", msg);
  switch (lite::onError(state(), r)) {
    case SHOW_ERROR: showMessage(MSG_ERROR); break;
    case CANCEL_FAILED: cancelling = false; dirty = true; hw::beepError(); break;
    default: break;
  }
}

// ---------------------------------------------------------------- setup / loop

void setup() {
  Serial.begin(115200);
  hw::begin();   // relay off before anything else can fail
  if (!ui::begin()) Serial.println("[UI] frame buffer alloc failed");
  hw::wifiBegin(WIFI_SSID, WIFI_PASS);
  net::begin({WS_HOST, WS_PORT, WS_USE_TLS, DEVICE_ID, "Authorization: Bearer " DEVICE_TOKEN, ROOT_CA_BUNDLE},
             {onLinkUp, onLinkDown, onHello, onPayment, onStatus, onError});
  Serial.printf("[QRun Lite] %s, price %lu satang, run %lu s -> %s://%s:%d\n", FW_VERSION, (unsigned long)cfg::PRICE_SATANG,
                (unsigned long)cfg::RUN_SECONDS, WS_USE_TLS ? "wss" : "ws", WS_HOST, WS_PORT);
}

void loop() {
  net::pump();   // a paid status switches the relay on right here, before any drawing
  hw::pump();
  bool w = hw::wifiUp();
  if (w != wifi) { wifi = w; dirty = true; }
  if (!net::up() && online) { online = false; dirty = true; }
  uint32_t now = millis();

  int x, y;
  if (hw::tapped(x, y)) {
    if (screen == IDLE && online && ui::hitPrice(x, y)) {
      formatRef(esp_random(), esp_random(), ref, sizeof ref);
      pi[0] = 0;
      net::create(cfg::PRICE_SATANG, ref);
      go(CREATING);
    } else if (screen == QR && online && !cancelling && ui::hitCancel(x, y)) {
      net::cancel(pi);
      cancelling = true;
      cancelAt = now;
      dirty = true;
    } else if (screen == MESSAGE && now - since > 600) {
      go(IDLE);
    }
  }

  switch (screen) {
    case CREATING:
      if (now - since > CREATE_TIMEOUT_MS) showMessage(MSG_ERROR);
      break;
    case QR:
      if (cancelling && now - cancelAt > CANCEL_TIMEOUT_MS) go(IDLE);   // a late "succeeded" still runs
      else if ((int32_t)(now - qrDeadline) > (int32_t)QR_GRACE_MS) showMessage(MSG_EXPIRED);
      break;
    case RUNNING:
      if ((int32_t)(now - runUntil) >= 0) {
        hw::relayOff();
        Serial.println("[RUN] done");
        go(IDLE);
      }
      break;
    case MESSAGE:
      if (now - since > MESSAGE_MS) go(IDLE);
      break;
    default:
      break;
  }

  // Full redraw on every change, and once a second while a countdown is on screen.
  bool ticking = screen == QR || screen == RUNNING;
  if (dirty || (ticking && now - lastDraw >= 1000)) {
    uint32_t end = screen == QR ? qrDeadline : runUntil;
    uint32_t left = (int32_t)(end - now) > 0 ? (end - now + 999) / 1000 : 0;
    ui::draw({screen, wifi, online, live, cfg::PRICE_SATANG, left, qr, cancelling, message});
    dirty = false;
    lastDraw = now;
  }
  delay(2);
}
