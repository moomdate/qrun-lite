// Screens on the CYD's 320x240 display. Each frame is drawn in full into an 8-bit sprite, then pushed.
//
// To customise:  colours -> include/theme.h   texts -> include/strings.h   brand/price/run time -> include/config.h
// To change a layout, edit the "Layout" rectangles below and the screen function that uses them.
// To add a screen: add it to lite::Screen (logic.h), write a function like idle() below, add a case in draw().
#include "ui.h"

#include <Arduino.h>
#include <TFT_eSPI.h>
#include <qrcode.h>
#include "config.h"
#include "credit.h"
#include "credit_crc.h"
#include "logo_birdlab.h"
#include "logo_birdlab_small.h"
#include "strings.h"
#include "theme.h"
#include "fonts/sarabun18.h"       // body text (Thai + ASCII)
#include "fonts/sarabunBold36.h"   // titles, price, countdown

namespace ui {
namespace {

using namespace theme;

TFT_eSPI tft;
TFT_eSprite fb(&tft);   // 8-bit 320x240 frame buffer (75 KB)

bool splashFinished = false;   // the boot splash ran to its end this boot
bool creditIntact = false;     // the credit assets match credit_crc.h (computed once in begin())

// ---------------------------------------------------------------- Layout (pixels; the screen is 320 x 240)

struct Rect {
  int x, y, w, h;
  bool has(int px, int py) const { return px >= x && px < x + w && py >= y && py < y + h; }
};
// Touch targets: keep both >= 48 px. hitPrice()/hitCancel() test exactly these rectangles.
const Rect PRICE_BTN = {24, 44, 272, 132};    // IDLE: the big price button
const Rect QR_CARD = {4, 4, 204, 232};        // QR: white card (QR + caption); the right column is x 212..320
const Rect CANCEL_BTN = {216, 180, 100, 56};  // QR: cancel
constexpr int COL_X = 266;                    // QR: centre of the right column
constexpr int URGENT_SEC = 30;                // QR: amber below this many seconds left
constexpr int PANIC_SEC = 10;                 // QR: red and blinking below this

// ---------------------------------------------------------------- Drawing helpers

const uint8_t* loaded = nullptr;
void use(const uint8_t* font) {
  if (font != loaded) { fb.loadFont(font); loaded = font; }   // loading parses the glyph table: only on change
}
int width(const uint8_t* font, const char* s) { use(font); return fb.textWidth(s); }
// Text anchored at (x, y) by `datum` (MC_DATUM = centred). `bg` must be the colour under the text (smooth fonts blend into it).
void text(const uint8_t* font, const char* s, int x, int y, uint16_t fg, uint16_t bg, uint8_t datum = MC_DATUM) {
  use(font);
  fb.setTextDatum(datum);
  fb.setTextColor(fg, bg);
  fb.drawString(s, x, y);
}

// A rounded button/card with a small drop shadow.
void raised(const Rect& r, int radius, uint16_t fill) {
  fb.fillRoundRect(r.x, r.y + 4, r.w, r.h, radius, SHADOW);
  fb.fillRoundRect(r.x, r.y, r.w, r.h, radius, fill);
}

// Progress bar: `left` of `total` seconds, shrinking.
void bar(int x, int y, int w, int h, uint32_t left, uint32_t total, uint16_t color) {
  fb.fillRoundRect(x, y, w, h, h / 2, SURFACE);
  if (!total || !left) return;
  int fw = left >= total ? w : (int)((uint64_t)w * left / total);
  if (fw < h) fw = h;
  fb.fillRoundRect(x, y, fw, h, h / 2, color);
}

// Progress ring, same idea: the remaining part is drawn from 12 o'clock backwards, so it eats itself clockwise.
// (TFT_eSPI arcs: 0 deg = 6 o'clock, 180 = 12 o'clock, drawn clockwise from start to end.)
void ring(int cx, int cy, int r, int ir, uint32_t left, uint32_t total, uint16_t color) {
  fb.drawSmoothArc(cx, cy, r, ir, 0, 360, SURFACE, BG);
  if (!total || !left) return;
  uint32_t deg = left >= total ? 360 : (uint32_t)((uint64_t)360 * left / total);
  if (deg < 10) deg = 10;
  fb.drawSmoothArc(cx, cy, r, ir, deg >= 360 ? 0 : (540 - deg) % 360, deg >= 360 ? 360 : 180, color, SURFACE, deg < 360);
}

const char* priceText(uint32_t satang) {
  static char out[32];
  char baht[16];
  snprintf(out, sizeof out, "%s%s", str::CURRENCY, lite::formatBaht(satang, baht, sizeof baht));
  return out;
}

// Small rounded outline badge, e.g. TEST.
void badge(int cx, int cy, const char* s, uint16_t color, uint16_t under) {
  int w = width(sarabun18, s) + 20;
  fb.drawRoundRect(cx - w / 2, cy - 10, w, 20, 10, color);
  text(sarabun18, s, cx, cy, color, under);
}

// An 8-bit alpha mask (tools/gen_logo.py) tinted `color` and blended onto the background colour `under`.
void mask(const uint8_t* a, int w, int h, int x0, int y0, uint16_t color, uint16_t under) {
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++)
      if (uint8_t v = a[y * w + x]) fb.drawPixel(x0 + x, y0 + y, fb.alphaBlend(v, color, under));
}

// Top bar: brand + logo mark on the left, link status pill on the right, TEST badge in the middle.
void header(const View& v) {
  fb.fillRoundRect(10, 8, 7, 7, 2, ACCENT);       // logo mark: three QR-ish squares
  fb.fillRoundRect(19, 8, 7, 7, 2, ACCENT);
  fb.fillRoundRect(10, 17, 7, 7, 2, ACCENT);
  // An unmodified credit and a completed splash show the brand; otherwise the header says so. Payments are unaffected.
  bool genuine = lite::authentic(splashFinished, creditIntact ? credit::EXPECTED_CRC : 0, credit::EXPECTED_CRC);
  text(sarabun18, genuine ? cfg::BRAND_NAME : credit::UNOFFICIAL, 34, 16, genuine ? TEXT : BAD, BG, ML_DATUM);

  const char* st = v.online ? str::ONLINE : v.wifi ? str::CONNECTING : str::NO_WIFI;
  uint16_t dot = v.online ? GOOD : v.wifi ? WARN : BAD;
  int w = width(sarabun18, st) + 34, x = 312 - w;
  fb.fillRoundRect(x, 4, w, 24, 12, SURFACE);
  fb.fillCircle(x + 14, 16, 4, dot);
  text(sarabun18, st, x + 24, 16, MUTED, SURFACE, ML_DATUM);

  if (v.online && !v.live) badge(160, 16, str::TEST, WARN, BG);   // Stripe test mode
}

// ---------------------------------------------------------------- Screens

// QR card. Keep it white with black modules and an 8 px+ quiet zone: phone cameras need the contrast.
void drawQr(const char* data) {
  const Rect& c = QR_CARD;
  fb.fillRoundRect(c.x, c.y, c.w, c.h, 10, QR_BG);
  static QRCode qr;          // encoding is slow: do it once per payload
  static uint8_t buf[800];   // >= qrcode_getBufferSize(15)
  static char encoded[lite::QR_MAX + 1] = "";
  static bool ok = false;
  if (strcmp(encoded, data) != 0) {
    strlcpy(encoded, data, sizeof encoded);
    uint8_t ver = lite::qrVersionFor(strlen(data));
    ok = ver && qrcode_initText(&qr, buf, ver, ECC_LOW, data) == 0;
  }
  if (!ok) return text(sarabun18, str::QR_ERROR, c.x + c.w / 2, c.y + c.w / 2, BAD, QR_BG);
  int scale = (c.w - 16) / qr.size, size = qr.size * scale;   // >= 8 px quiet zone
  int ox = c.x + (c.w - size) / 2, oy = c.y + (c.w - size) / 2;
  for (int y = 0; y < qr.size; y++)
    for (int x = 0; x < qr.size; x++)
      if (qrcode_getModule(&qr, x, y)) fb.fillRect(ox + x * scale, oy + y * scale, scale, scale, QR_FG);
  text(sarabun18, str::SCAN_TO_PAY, c.x + c.w / 2, c.y + c.w + (c.h - c.w) / 2 - 2, BG, QR_BG);
}

// Boot credit: wordmark, tagline, progress, version, "crafted by" + birdlab.th logo.
void splash(const View& v) {
  text(sarabunBold36, credit::WORDMARK, 160, 62, TEXT, BG);
  text(sarabun18, str::TAGLINE, 160, 98, MUTED, BG);
  bar(80, 124, 160, 8, v.splashPct, 100, ACCENT);
  text(sarabun18, v.version, 160, 154, DIM, BG);
  int tw = width(sarabun18, credit::CRAFTED_BY), x = (320 - (tw + 8 + LOGO_BIRDLAB_W)) / 2, y = 190;
  text(sarabun18, credit::CRAFTED_BY, x, y + LOGO_BIRDLAB_H / 2, MUTED, BG, ML_DATUM);
  mask(logo_birdlab, LOGO_BIRDLAB_W, LOGO_BIRDLAB_H, x + tw + 8, y, TEXT, BG);
}

void idle(const View& v) {
  header(v);
  const Rect& b = PRICE_BTN;
  uint16_t fill = v.online ? ACCENT : SURFACE, fg = v.online ? TEXT : DIM;
  raised(b, 18, fill);
  text(sarabunBold36, priceText(v.price), 160, b.y + 52, fg, fill);
  text(sarabun18, v.online ? str::TAP_TO_PAY : str::WAITING, 160, b.y + 100, fg, fill);
  char run[96];   // Thai is 3 bytes per character in UTF-8: size buffers generously
  snprintf(run, sizeof run, str::RUN_INFO, (unsigned long)cfg::RUN_SECONDS);
  text(sarabun18, run, 160, 202, MUTED, BG);
  // Small credit, bottom right: well clear of the price button (and its tap rectangle) above.
  mask(logo_birdlab_small, LOGO_BIRDLAB_SMALL_W, LOGO_BIRDLAB_SMALL_H, 314 - LOGO_BIRDLAB_SMALL_W, 224, DIM, BG);
}

void creating(const View& v) {
  header(v);
  Rect card = {20, 52, 280, 140};
  raised(card, 18, SURFACE);
  for (int i = 0; i < 3; i++) fb.fillCircle(140 + i * 20, 84, 5, i == 1 ? ACCENT : MUTED);
  text(sarabunBold36, str::CREATING, 160, 124, TEXT, SURFACE);
  text(sarabun18, priceText(v.price), 160, 164, MUTED, SURFACE);
}

void qr(const View& v) {
  drawQr(v.qr);
  const char* price = priceText(v.price);
  text(width(sarabunBold36, price) <= 96 ? sarabunBold36 : sarabun18, price, COL_X, 30, TEXT, BG);   // big prices: small font
  if (!v.live) badge(COL_X, 58, str::TEST, WARN, BG);

  bool urgent = v.secondsLeft <= URGENT_SEC, panic = v.secondsLeft <= PANIC_SEC;
  uint16_t tone = panic ? BAD : urgent ? WARN : ACCENT;
  // Last seconds: the clock blinks (the frame is redrawn every second, so odd/even seconds alternate).
  uint16_t clock = panic && (v.secondsLeft & 1) ? TEXT : urgent ? tone : TEXT;
  text(sarabun18, !v.online ? str::OFFLINE : urgent ? str::HURRY : str::TIME_LEFT, COL_X, 92, v.online ? (urgent ? tone : MUTED) : WARN, BG);
  char t[12];
  text(sarabunBold36, lite::formatClock(v.secondsLeft, t, sizeof t), COL_X, 122, clock, BG);
  bar(CANCEL_BTN.x, 148, CANCEL_BTN.w, 8, v.secondsLeft, v.totalSeconds, tone);

  const Rect& b = CANCEL_BTN;
  bool on = v.online && !v.cancelling;   // cancel needs the Worker; offline, the QR simply expires
  uint16_t fill = on ? BAD : SURFACE;
  raised(b, 12, fill);
  text(sarabun18, v.cancelling ? str::CANCELLING : str::CANCEL, b.x + b.w / 2, b.y + b.h / 2, on ? TEXT : DIM, fill);
}

void running(const View& v) {
  header(v);
  ring(160, 126, 76, 64, v.secondsLeft, v.totalSeconds, GOOD);
  text(sarabun18, str::PAID, 160, 96, GOOD, BG);
  char t[12];
  text(sarabunBold36, lite::formatClock(v.secondsLeft, t, sizeof t), 160, 127, TEXT, BG);
  text(sarabun18, str::RUNNING, 160, 160, MUTED, BG);
  text(sarabun18, str::THANKS, 160, 224, MUTED, BG);
}

// Result: a coloured icon over a title, in the order of lite::Message.
void message(const View& v) {
  static const uint16_t DISC[] = {MUTED, WARN, BAD, BAD};      // icon disc colour
  static const uint16_t GLYPH[] = {BG, BG, TEXT, TEXT};        // icon glyph colour
  header(v);
  Rect card = {20, 44, 280, 152};
  raised(card, 18, SURFACE);
  int cx = 160, cy = 84, m = v.message;
  fb.fillCircle(cx, cy, 24, DISC[m]);
  switch (m) {
    case lite::MSG_CANCELED:
    case lite::MSG_FAILED:   // X
      fb.drawWideLine(cx - 9, cy - 9, cx + 9, cy + 9, 5, GLYPH[m], DISC[m]);
      fb.drawWideLine(cx - 9, cy + 9, cx + 9, cy - 9, 5, GLYPH[m], DISC[m]);
      break;
    case lite::MSG_EXPIRED:  // clock hands
      fb.drawWideLine(cx, cy, cx, cy - 12, 4, GLYPH[m], DISC[m]);
      fb.drawWideLine(cx, cy, cx + 9, cy + 5, 4, GLYPH[m], DISC[m]);
      break;
    default:                 // !
      fb.drawWideLine(cx, cy - 12, cx, cy + 3, 5, GLYPH[m], DISC[m]);
      fb.fillCircle(cx, cy + 12, 3, GLYPH[m]);
  }
  text(sarabunBold36, str::MSG_TITLE[m], 160, 134, TEXT, SURFACE);
  text(sarabun18, m == lite::MSG_ERROR ? str::TRY_AGAIN : str::NO_CHARGE, 160, 172, MUTED, SURFACE);
  text(sarabun18, str::TAP_BACK, 160, 222, DIM, BG);
}

}  // namespace

bool begin() {
  tft.init();
  tft.setRotation(1);
  tft.fillScreen(BG);
  fb.setColorDepth(8);
  creditIntact = lite::creditCrc(logo_birdlab, sizeof logo_birdlab, logo_birdlab_small, sizeof logo_birdlab_small,
                                 credit::CRAFTED_BY, credit::WORDMARK) == credit::EXPECTED_CRC;
  return fb.createSprite(320, 240) != nullptr;
}

void draw(const View& v) {
  fb.fillSprite(BG);
  switch (v.screen) {
    case lite::IDLE:     idle(v); break;
    case lite::CREATING: creating(v); break;
    case lite::QR:       qr(v); break;
    case lite::RUNNING:  running(v); break;
    case lite::MESSAGE:  message(v); break;
    case lite::SPLASH:   splash(v); break;
  }
  fb.pushSprite(0, 0);
}

void splashDone() { splashFinished = true; }
bool hitPrice(int x, int y) { return PRICE_BTN.has(x, y); }
bool hitCancel(int x, int y) { return CANCEL_BTN.has(x, y); }

}  // namespace ui
