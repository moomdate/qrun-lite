#include "hw.h"

#include <Arduino.h>
#include <WiFi.h>   // before TFT_eSPI headers
#include <TFT_Touch.h>
#include <esp_timer.h>
#include "config.h"

namespace hw {
namespace {

constexpr int PIN_SPK = 26;
constexpr int PIN_LED_R = 4, PIN_LED_G = 16, PIN_LED_B = 17;   // RGB LED, active LOW (kept off)

TFT_Touch touch(33, 25, 32, 39);
esp_timer_handle_t stopTimer = nullptr;
bool prevTouch = false, prevWifi = false;
uint32_t beepEnd = 0, lastWifiLog = 0;

void relaySet(bool on) { digitalWrite(cfg::RELAY_PIN, on == cfg::RELAY_ACTIVE_HIGH ? HIGH : LOW); }

// Runs in the esp_timer task, so the relay goes off on time even while loop() is blocked (e.g. a TLS reconnect).
void stopTimerCb(void*) { relaySet(false); }

void beep(uint16_t freq, uint16_t ms) {
  ledcWriteTone(PIN_SPK, freq);
  beepEnd = millis() + ms;
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
  touch.setCal(526, 3443, 750, 3377, 320, 240, 1);   // CYD, rotation 1
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
  if (beepEnd && (int32_t)(millis() - beepEnd) >= 0) { ledcWriteTone(PIN_SPK, 0); beepEnd = 0; }
}

bool tapped(int& x, int& y) {
  bool p = touch.Pressed();
  bool tap = p && !prevTouch;
  if (tap) { x = touch.X(); y = touch.Y(); }
  prevTouch = p;
  return tap;
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
