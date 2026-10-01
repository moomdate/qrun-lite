// QRun Lite: tap the price, scan the PromptPay QR, the relay runs.
//
//   IDLE ──tap──▶ CREATING ──payment──▶ QR ──status succeeded──▶ RUNNING ──time up──▶ IDLE
//                    │                   ├──cancel / expired / failed──▶ MESSAGE ──4 s or tap──▶ IDLE
//                    └──error / 20 s─────┴──────────────────────────────▶ MESSAGE
//
// The board never holds a Stripe key: it talks to your Cloudflare Worker with its own device token (secrets.h).
// Wire format: ../../PROTOCOL.md. Frame decisions: ../include/logic.h (host-tested).
#include <Arduino.h>
#include <esp_core_dump.h>
#include <esp_system.h>
#include "config.h"
#include "credit.h"
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

static_assert(ESP_RST_POWERON == 1 && ESP_RST_SW == 3 && ESP_RST_PANIC == 4 && ESP_RST_TASK_WDT == 6 &&
                  ESP_RST_BROWNOUT == 9 && ESP_RST_CPU_LOCKUP == 15,
              "esp_reset_reason_t changed: update lite::resetReasonName()");

static constexpr const char* FW_VERSION = "lite-1.0.0";
static constexpr uint32_t CREATE_TIMEOUT_MS = 20000;   // no answer to a create
static constexpr uint32_t CANCEL_TIMEOUT_MS = 10000;   // no answer to a cancel: back to IDLE (the QR expires anyway)
static constexpr uint32_t QR_GRACE_MS = 15000;         // the Worker should report "expired" first
static constexpr uint32_t MESSAGE_MS = 4000;
static constexpr uint32_t BOOT_TAP_GUARD_MS = 1500;   // ignore touch noise while the panel powers up
static constexpr uint32_t SPLASH_MS = 1800;            // boot credit, always shown
static constexpr uint32_t SPLASH_SKIP_MS = 1000;       // a tap may skip it only after this
static constexpr uint32_t SPLASH_FRAME_MS = 50;        // progress bar redraw interval
static constexpr uint32_t FALLBACK_TTL_SEC = 120;      // QR countdown before NTP time is known

static Screen screen = SPLASH;   // the boot credit; payment frames are held back until it ends (see finishSplash)
static char ref[16] = "", pi[PI_MAX + 1] = "", qr[QR_MAX + 1] = "", lastRunPi[PI_MAX + 1] = "", deferredPi[PI_MAX + 1] = "";
static uint32_t since = 0, qrDeadline = 0, qrTotalSec = 0, runUntil = 0, cancelAt = 0, lastDraw = 0;
static bool wifi = false, online = false, live = true, cancelling = false, dirty = true;
static BootGuard bootGuard;
static Message message = MSG_ERROR;

static const char* screenName(Screen s) {
  switch (s) {
    case IDLE: return "idle"; case CREATING: return "creating"; case QR: return "qr";
    case RUNNING: return "running"; case MESSAGE: return "message"; case SPLASH: return "splash";
  }
  return "?";
}

static void go(Screen s) {
  if (s != screen) Serial.printf("[UI] %s -> %s\n", screenName(screen), screenName(s));
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
  Serial.printf("[RUN] %s: relay on for %lu s (GPIO %d, active %s)\n", paidPi, (unsigned long)cfg::RUN_SECONDS,
                cfg::RELAY_PIN, cfg::RELAY_ACTIVE_HIGH ? "high" : "low");
  hw::beepPaid();
  go(RUNNING);
}

// End of the boot splash. A payment that was reported paid meanwhile (e.g. a QR paid just before a reboot) runs now.
static void finishSplash() {
  ui::splashDone();
  if (deferredPi[0]) {
    Serial.printf("[PAY] %s was paid during the splash: running now\n", deferredPi);
    run(deferredPi);
    deferredPi[0] = 0;
  } else {
    go(IDLE);
  }
}

static State state() { return State{screen, ref, pi, lastRunPi}; }

// ---------------------------------------------------------------- diagnostics (serial only)

// Why the board restarted. A crash also leaves a core dump in flash (the "coredump" partition): print its summary once
// and erase it. Decode the backtrace with the ELF of the firmware that crashed:
//   ~/.platformio/packages/toolchain-xtensa-esp-elf/bin/xtensa-esp32-elf-addr2line -pfiaC -e .pio/build/esp32dev/firmware.elf <addresses>
static void logBoot() {
  int reset = (int)esp_reset_reason();
  Serial.printf("\n[BOOT] reset reason %s (%d), heap %u free, %u largest block\n", resetReasonName(reset), reset,
                (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap());
  if (reset == ESP_RST_BROWNOUT || reset == ESP_RST_PWR_GLITCH)
    Serial.println("[BOOT] the 3.3 V supply sagged: power the relay from its own supply (docs/hardware.md, 'Power')");
  else if (resetWasFault(reset))
    Serial.println("[BOOT] crash or watchdog reset: please report it with the serial log");
  if (esp_core_dump_image_check() != ESP_OK) return;
  esp_core_dump_summary_t d;
  // A partial or stale dump (erased flash reads 0xa5/0xff, task name not text) is reported as such, not as garbage.
  bool sane = esp_core_dump_get_summary(&d) == ESP_OK && d.exc_pc >= 0x40000000 && d.exc_pc < 0x42000000;
  for (int i = 0; sane && i < (int)sizeof d.exc_task && d.exc_task[i]; i++) sane = d.exc_task[i] >= 0x20 && d.exc_task[i] < 0x7f;
  if (!sane) Serial.println("[BOOT] an unreadable core dump was left in flash (older firmware or interrupted write): erased");
  if (sane) {
    Serial.printf("[BOOT] core dump: task %.16s, PC 0x%08lx, cause %lu, vaddr 0x%08lx, elf %.8s\n", d.exc_task,
                  (unsigned long)d.exc_pc, (unsigned long)d.ex_info.exc_cause, (unsigned long)d.ex_info.exc_vaddr,
                  (const char*)d.app_elf_sha256);
    Serial.print("[BOOT] backtrace");
    for (uint32_t i = 0; i < d.exc_bt_info.depth && i < 16; i++) Serial.printf(" 0x%08lx", (unsigned long)d.exc_bt_info.bt[i]);
    Serial.println(d.exc_bt_info.corrupted ? " (corrupted)" : "");
  }
  esp_core_dump_image_erase();
}

// Once a second while the relay runs: heap and loop-stack trend, to tell a leak or overflow from a power problem.
static void logRunning(uint32_t now, uint32_t left) {
  static uint32_t last = 0;
  if (elapsedMs(now, last) < 1000) return;
  last = now;
  Serial.printf("[RUN] %lus left, heap %u free / %u largest / %u min, loop stack %u free\n", (unsigned long)left,
                (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getMaxAllocHeap(), (unsigned)ESP.getMinFreeHeap(),
                (unsigned)uxTaskGetStackHighWaterMark(nullptr));
}

// ---------------------------------------------------------------- Worker frames

static void onLinkUp() { net::hello(FW_VERSION); }
static void onLinkDown() { online = false; dirty = true; }
static void onHello(bool isLive) { online = true; live = isLive; dirty = true; }

static void onPayment(const char* id, const char* r, const char* data, int64_t expires) {
  switch (lite::onPayment(state(), id, r, data)) {
    case SHOW_QR: {
      if (!same(id, pi) || screen != QR) cancelling = false;
      strlcpy(pi, id, sizeof pi);
      strlcpy(ref, r, sizeof ref);
      strlcpy(qr, data, sizeof qr);
      uint32_t ttl = secondsLeft(expires, (int64_t)time(nullptr), FALLBACK_TTL_SEC);
      qrDeadline = millis() + ttl * 1000;
      if (screen != QR || ttl > qrTotalSec) qrTotalSec = ttl;   // progress bar length (a re-sent QR keeps the first)
      go(QR);
      break;
    }
    case REJECT_QR:
      net::cancel(id);
      showMessage(MSG_ERROR);
      break;
    case DISCARD_QR:
      Serial.printf("[PAY] %s pending from before, not shown: cancelling\n", id);
      net::cancel(id);
      break;
    default:
      break;
  }
}

static void onStatus(const char* id, const char* status) {
  switch (lite::onStatus(state(), id, status)) {
    case RUN: run(id); break;
    case DEFER_RUN:   // the splash never touches the relay; a second paid id during it is dropped like one during RUNNING
      if (!deferredPi[0]) strlcpy(deferredPi, id, sizeof deferredPi);
      break;
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
  logBoot();
  if (!ui::begin()) Serial.println("[UI] frame buffer alloc failed");
  hw::wifiBegin(WIFI_SSID, WIFI_PASS);
  net::begin({WS_HOST, WS_PORT, WS_USE_TLS, DEVICE_ID, "Authorization: Bearer " DEVICE_TOKEN, ROOT_CA_BUNDLE},
             {onLinkUp, onLinkDown, onHello, onPayment, onStatus, onError});
  Serial.println("[QRun Lite] crafted by birdlab.th (birdlab.moomdate.tech)");
  Serial.printf("[QRun Lite] %s, price %lu satang, run %lu s -> %s://%s:%d\n", FW_VERSION, (unsigned long)cfg::PRICE_SATANG,
                (unsigned long)cfg::RUN_SECONDS, WS_USE_TLS ? "wss" : "ws", WS_HOST, WS_PORT);
  since = millis();   // the splash starts now; loop() draws it and keeps net::pump() running meanwhile
}

void loop() {
  net::pump();   // a paid status switches the relay on right here, before any drawing
  hw::pump();
  bool w = hw::wifiUp();
  if (w != wifi) { wifi = w; dirty = true; }
  if (!net::up() && online) { online = false; dirty = true; }
  uint32_t now = millis();

  int x, y;
  if (hw::tapped(x, y) && bootGuard.passed(now, BOOT_TAP_GUARD_MS)) {
    Serial.printf("[TAP] %d,%d on %s\n", x, y, screenName(screen));
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
    } else if (screen == MESSAGE && elapsedMs(now, since) > 600) {
      go(IDLE);
    } else if (screen == SPLASH && elapsedMs(now, since) > SPLASH_SKIP_MS) {
      finishSplash();   // the tap is consumed here: it does not reach the idle screen
    }
  }

  switch (screen) {
    case SPLASH:
      if (elapsedMs(now, since) >= SPLASH_MS) finishSplash();
      break;
    case CREATING:
      if (elapsedMs(now, since) > CREATE_TIMEOUT_MS) showMessage(MSG_ERROR);
      break;
    case QR:
      if (cancelling && elapsedMs(now, cancelAt) > CANCEL_TIMEOUT_MS) go(IDLE);   // a late "succeeded" still runs
      else if ((int32_t)(now - qrDeadline) > (int32_t)QR_GRACE_MS) showMessage(MSG_EXPIRED);
      break;
    case RUNNING:
      logRunning(now, (int32_t)(runUntil - now) > 0 ? (runUntil - now) / 1000 : 0);
      if ((int32_t)(now - runUntil) >= 0) {
        hw::relayOff();
        Serial.println("[RUN] done");
        go(IDLE);
      }
      break;
    case MESSAGE:
      if (elapsedMs(now, since) > MESSAGE_MS) go(IDLE);
      break;
    default:
      break;
  }

  // Full redraw on every change, and once a second while a countdown is on screen.
  bool ticking = screen == QR || screen == RUNNING;
  if (dirty || (ticking && elapsedMs(now, lastDraw) >= 1000) || (screen == SPLASH && elapsedMs(now, lastDraw) >= SPLASH_FRAME_MS)) {
    uint32_t sp = elapsedMs(now, since) * 100 / SPLASH_MS;
    uint32_t end = screen == QR ? qrDeadline : runUntil;
    uint32_t left = (int32_t)(end - now) > 0 ? (end - now + 999) / 1000 : 0;
    ui::draw({screen, wifi, online, live, cfg::PRICE_SATANG, left,
             screen == QR ? qrTotalSec : cfg::RUN_SECONDS, qr, cancelling, message, sp > 100 ? 100 : sp, FW_VERSION});
    dirty = false;
    lastDraw = now;
  }
  delay(2);
}
