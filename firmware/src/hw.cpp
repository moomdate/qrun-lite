#include "hw.h"

#include <Arduino.h>
#include <WiFi.h>   // before TFT_eSPI headers
#include <esp_timer.h>
#include "config.h"
#include "logic.h"

namespace hw {
namespace {

constexpr int PIN_SPK = 26;
constexpr int PIN_LED_R = 4, PIN_LED_G = 16, PIN_LED_B = 17;   // RGB LED, active LOW (kept off)

// XPT2046 resistive touch controller, bit-banged on its own pins (the CYD wires it apart from the display SPI).
namespace touch {
constexpr int CS = 33, CLK = 25, MOSI = 32, MISO = 39;
constexpr int PRESSED_Z1 = 150;   // pressure reading above this = finger down (idle reads ~0)
// Calibration for rotation 1: raw ADC reading at the left/right (X) and top/bottom (Y) screen edges.
constexpr int X_MIN = 526, X_MAX = 3443, Y_MIN = 750, Y_MAX = 3377;

uint16_t read(uint8_t cmd) {   // one 12-bit conversion; ~1 MHz clock, slow enough for every XPT2046 clone
  digitalWrite(CS, LOW);
  for (int i = 7; i >= 0; i--) {
    digitalWrite(MOSI, (cmd >> i) & 1);
    delayMicroseconds(1); digitalWrite(CLK, HIGH); delayMicroseconds(1); digitalWrite(CLK, LOW);
  }
  uint16_t v = 0;
  for (int i = 0; i < 16; i++) {
    delayMicroseconds(1); digitalWrite(CLK, HIGH); delayMicroseconds(1); digitalWrite(CLK, LOW);
    v = (v << 1) | digitalRead(MISO);
  }
  digitalWrite(CS, HIGH);
  return (v >> 4) & 0x0FFF;   // 1 busy bit + 12 data bits + 3 zero bits
}

uint16_t median5(uint8_t cmd) {
  uint16_t s[5];
  for (auto& v : s) v = read(cmd);
  for (int i = 1; i < 5; i++)
    for (int j = i; j > 0 && s[j] < s[j - 1]; j--) { uint16_t t = s[j]; s[j] = s[j - 1]; s[j - 1] = t; }
  return s[2];
}

void begin() {
  pinMode(CS, OUTPUT); digitalWrite(CS, HIGH);
  pinMode(CLK, OUTPUT); digitalWrite(CLK, LOW);
  pinMode(MOSI, OUTPUT); digitalWrite(MOSI, LOW);
  pinMode(MISO, INPUT);
}

// true + screen coordinates while a finger is down
bool sample(int& x, int& y) {
  if (read(0xB1) < PRESSED_Z1) return false;   // Z1 pressure
  uint16_t rx = median5(0x91), ry = median5(0xD1);   // 0x91 runs along the screen's x in rotation 1
  if (read(0xB1) < PRESSED_Z1) return false;   // lifted while sampling: the readings may be half-way values
  x = constrain(map(rx, X_MIN, X_MAX, 30, 290), 0, 319);
  y = constrain(map(ry, Y_MIN, Y_MAX, 30, 210), 0, 239);
  return true;
}
}  // namespace touch
esp_timer_handle_t stopTimer = nullptr;
bool prevWifi = false;
lite::OneShot beepEnd;
uint32_t lastWifiLog = 0;

void relaySet(bool on) { digitalWrite(cfg::RELAY_PIN, on == cfg::RELAY_ACTIVE_HIGH ? HIGH : LOW); }

// Runs in the esp_timer task, so the relay goes off on time even while loop() is blocked (e.g. a TLS reconnect).
void stopTimerCb(void*) { relaySet(false); }

void beep(uint16_t freq, uint16_t ms) {
  ledcWriteTone(PIN_SPK, freq);
  beepEnd.start(millis(), ms);
}

}  // namespace

void begin() {
  pinMode(cfg::RELAY_PIN, OUTPUT);
  relaySet(false);
  esp_timer_create_args_t ta = {};
  ta.callback = stopTimerCb;
  ta.name = "relay";
  if (esp_timer_create(&ta, &stopTimer) != ESP_OK) stopTimer = nullptr;

  for (int p : {PIN_LED_R, PIN_LED_G, PIN_LED_B}) { pinMode(p, OUTPUT); digitalWrite(p, HIGH); }
  ledcAttach(PIN_SPK, 2000, 8);
  ledcWriteTone(PIN_SPK, 0);
  touch::begin();
}

void relayOn(uint32_t ms) {
  if (!stopTimer) return;   // no safety timer, no relay
  relaySet(true);
  esp_timer_stop(stopTimer);
  esp_timer_start_once(stopTimer, (uint64_t)ms * 1000);
}

void relayOff() {
  if (stopTimer) esp_timer_stop(stopTimer);
  relaySet(false);
}

void beepPaid() { beep(1568, 250); }
void beepError() { beep(220, 300); }

void pump() {
  if (beepEnd.due(millis())) ledcWriteTone(PIN_SPK, 0);
}

bool tapped(int& x, int& y) {
  static lite::TapFilter filter;
  int tx = -1, ty = -1;
  bool p = touch::sample(tx, ty);
  if (!filter.update(p, millis(), tx, ty)) return false;
  x = tx; y = ty;
  return true;
}

void wifiBegin(const char* ssid, const char* pass) {
  WiFi.mode(WIFI_STA);
  WiFi.setHostname("qrun-lite");
  WiFi.begin(ssid, pass);
  configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");   // TLS needs the time; so does the QR countdown
}

bool wifiUp() {
  bool up = WiFi.status() == WL_CONNECTED;
  if (up != prevWifi) {
    prevWifi = up;
    if (up) Serial.printf("[WIFI] connected, IP %s\n", WiFi.localIP().toString().c_str());
  }
  if (!up && millis() - lastWifiLog > 5000) {   // 1 = SSID not found (5 GHz? typo), 4 = wrong password
    lastWifiLog = millis();
    Serial.printf("[WIFI] status=%d\n", (int)WiFi.status());
  }
  return up;
}

}  // namespace hw
