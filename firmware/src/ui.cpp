#include "ui.h"

#include <Arduino.h>
#include <TFT_eSPI.h>
#include <qrcode.h>
#include "config.h"
#include "fonts/sarabun18.h"       // body text (Thai + ASCII)
#include "fonts/sarabunBold36.h"   // titles, price, countdown

namespace ui {
namespace {

TFT_eSPI tft;
TFT_eSprite fb(&tft);   // 8-bit 320x240 frame buffer (75 KB)

// RGB565 colours (the 8-bit sprite rounds them to RGB332)
constexpr uint16_t BG = 0x0129, CARD = 0x2A0B, TEXT = TFT_WHITE, MUTED = 0xAD7F, BLUE = 0x04BF, GREEN = 0x2EC9,
                   RED = 0xD8A7, AMBER = 0xFDA0, GREY = 0x6B6D;

struct Rect {
  int x, y, w, h;
  bool has(int px, int py) const { return px >= x && px < x + w && py >= y && py < y + h; }
};
const Rect PRICE_BTN = {40, 44, 240, 132};
const Rect QR_CARD = {4, 4, 204, 232};
const Rect CANCEL_BTN = {216, 180, 100, 56};

const uint8_t* loaded = nullptr;
void use(const uint8_t* font) {
  if (font != loaded) { fb.loadFont(font); loaded = font; }   // loading parses the glyph table: only on change
}
int width(const uint8_t* font, const char* s) { use(font); return fb.textWidth(s); }
void text(const uint8_t* font, const char* s, int x, int y, uint16_t fg, uint16_t bg, uint8_t datum = MC_DATUM) {
  use(font);
  fb.setTextDatum(datum);
  fb.setTextColor(fg, bg);
  fb.drawString(s, x, y);
}

const char* priceText(uint32_t satang) {
  static char out[24];
  char baht[16];
  snprintf(out, sizeof out, "฿%s", lite::formatBaht(satang, baht, sizeof baht));
  return out;
}

void header(const View& v) {
  text(sarabun18, "QRun Lite", 10, 16, TEXT, BG, ML_DATUM);
  const char* st = v.online ? "ออนไลน์" : v.wifi ? "กำลังเชื่อมต่อ" : "ไม่มี WiFi";
  text(sarabun18, st, 310, 16, MUTED, BG, MR_DATUM);
  fb.fillCircle(310 - width(sarabun18, st) - 10, 16, 4, v.online ? GREEN : v.wifi ? AMBER : RED);
  if (v.online && !v.live) text(sarabun18, "TEST", 160, 16, AMBER, BG);   // Stripe test mode
}

void drawQr(const char* data) {
  const Rect& c = QR_CARD;
  fb.fillRoundRect(c.x, c.y, c.w, c.h, 10, TFT_WHITE);
  static QRCode qr;          // encoding is slow: do it once per payload
  static uint8_t buf[800];   // >= qrcode_getBufferSize(15)
  static char encoded[lite::QR_MAX + 1] = "";
  static bool ok = false;
  if (strcmp(encoded, data) != 0) {
    strlcpy(encoded, data, sizeof encoded);
    uint8_t ver = lite::qrVersionFor(strlen(data));
    ok = ver && qrcode_initText(&qr, buf, ver, ECC_LOW, data) == 0;
  }
  if (!ok) return text(sarabun18, "QR error", c.x + c.w / 2, c.y + c.w / 2, RED, TFT_WHITE);
  int scale = (c.w - 16) / qr.size, size = qr.size * scale;   // >= 8 px quiet zone
  int ox = c.x + (c.w - size) / 2, oy = c.y + (c.w - size) / 2;
  for (int y = 0; y < qr.size; y++)
    for (int x = 0; x < qr.size; x++)
      if (qrcode_getModule(&qr, x, y)) fb.fillRect(ox + x * scale, oy + y * scale, scale, scale, TFT_BLACK);
  text(sarabun18, "สแกนจ่าย PromptPay", c.x + c.w / 2, c.y + c.w + (c.h - c.w) / 2 - 2, BG, TFT_WHITE);
}

void idle(const View& v) {
  header(v);
  const Rect& b = PRICE_BTN;
  uint16_t fill = v.online ? BLUE : CARD;
  fb.fillRoundRect(b.x, b.y, b.w, b.h, 16, fill);
  text(sarabunBold36, priceText(v.price), 160, b.y + 50, v.online ? TEXT : GREY, fill);
  text(sarabun18, v.online ? "แตะเพื่อจ่าย" : "กำลังเชื่อมต่อ...", 160, b.y + 98, v.online ? TEXT : GREY, fill);
  char run[48];
  snprintf(run, sizeof run, "จ่ายแล้วทำงาน %lu วินาที", (unsigned long)cfg::RUN_SECONDS);
  text(sarabun18, run, 160, 200, MUTED, BG);
  text(sarabun18, "สแกนจ่ายด้วยแอปธนาคาร (PromptPay)", 160, 224, MUTED, BG);
}

void creating(const View& v) {
  header(v);
  text(sarabunBold36, "กำลังสร้าง QR...", 160, 108, TEXT, BG);
  text(sarabun18, priceText(v.price), 160, 150, MUTED, BG);
}

void qr(const View& v) {
  drawQr(v.qr);
  const char* price = priceText(v.price);
  text(width(sarabunBold36, price) <= 96 ? sarabunBold36 : sarabun18, price, 266, 34, TEXT, BG);   // big prices: small font
  if (!v.live) text(sarabun18, "TEST", 266, 68, AMBER, BG);
  text(sarabun18, v.online ? "เหลือเวลา" : "ออฟไลน์", 266, 104, v.online ? MUTED : AMBER, BG);
  char t[12];
  text(sarabunBold36, lite::formatClock(v.secondsLeft, t, sizeof t), 266, 138, v.secondsLeft <= 30 ? AMBER : TEXT, BG);
  const Rect& b = CANCEL_BTN;
  bool on = v.online && !v.cancelling;   // cancel needs the Worker; offline, the QR simply expires
  fb.fillRoundRect(b.x, b.y, b.w, b.h, 10, on ? RED : CARD);
  text(sarabun18, v.cancelling ? "กำลังยกเลิก" : "ยกเลิก", b.x + b.w / 2, b.y + b.h / 2, on ? TEXT : GREY, on ? RED : CARD);
}

void running(const View& v) {
  header(v);
  text(sarabunBold36, "กำลังทำงาน", 160, 72, GREEN, BG);
  char t[12];
  text(sarabunBold36, lite::formatClock(v.secondsLeft, t, sizeof t), 160, 130, TEXT, BG);
  text(sarabun18, "ชำระเงินสำเร็จ ขอบคุณครับ", 160, 200, MUTED, BG);
}

void message(const View& v) {
  static const char* const TITLE[] = {"ยกเลิกแล้ว", "QR หมดอายุ", "ชำระเงินไม่สำเร็จ", "เกิดข้อผิดพลาด"};
  static const uint16_t COLOR[] = {TEXT, AMBER, RED, RED};
  header(v);
  text(sarabunBold36, TITLE[v.message], 160, 96, COLOR[v.message], BG);
  text(sarabun18, v.message == lite::MSG_ERROR ? "กรุณาลองใหม่อีกครั้ง" : "ไม่มีการตัดเงิน", 160, 140, MUTED, BG);
  text(sarabun18, "แตะเพื่อกลับ", 160, 212, GREY, BG);
}

}  // namespace

bool begin() {
  tft.init();
  tft.setRotation(1);
  tft.fillScreen(BG);
  fb.setColorDepth(8);
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
  }
  fb.pushSprite(0, 0);
}

bool hitPrice(int x, int y) { return PRICE_BTN.has(x, y); }
bool hitCancel(int x, int y) { return CANCEL_BTN.has(x, y); }

}  // namespace ui
