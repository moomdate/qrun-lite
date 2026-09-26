#include "net.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>

namespace net {
namespace {

constexpr uint32_t PING_EVERY_MS = 20000;
constexpr uint32_t SILENCE_MS = 65000;   // nothing received for this long: the link is dead, reconnect

WebSocketsClient ws;
Handlers H;
bool linkUp = false;
uint32_t lastRx = 0, lastPing = 0;

void send(JsonDocument& d) {
  String out;
  serializeJson(d, out);
  ws.sendTXT(out);
  Serial.printf("[WS] > %s\n", out.c_str());
}

void onText(const uint8_t* payload, size_t len) {
  lastRx = millis();
  JsonDocument d;
  if (deserializeJson(d, payload, len)) return;
  const char* t = d["t"] | "";
  if (!strcmp(t, "pong")) return;
  if (!strcmp(t, "hello")) H.hello(d["live"] | false);
  else if (!strcmp(t, "payment")) H.payment(d["pi"] | "", d["ref"] | "", d["qr"] | "", d["expires"] | (int64_t)0);
  else if (!strcmp(t, "status")) H.status(d["pi"] | "", d["status"] | "");
  else if (!strcmp(t, "error")) H.error(d["ref"] | "", d["msg"] | "");
  Serial.printf("[WS] < %.*s\n", (int)len, (const char*)payload);   // after acting on it: printing is slow
}

void onEvent(WStype_t type, uint8_t* payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("[WS] connected");
      linkUp = true;
      lastRx = lastPing = millis();
      H.linkUp();
      break;
    case WStype_DISCONNECTED:
      if (linkUp) Serial.println("[WS] disconnected");
      linkUp = false;
      H.linkDown();
      break;
    case WStype_TEXT:
      onText(payload, len);
      break;
    default:
      lastRx = millis();
      break;
  }
}

}  // namespace

void begin(const Config& c, const Handlers& h) {
  H = h;
  String path = String("/ws?device=") + c.deviceId;
  if (c.tls) ws.beginSslWithCA(c.host, c.port, path.c_str(), c.caBundle, "");
  else ws.begin(c.host, c.port, path.c_str(), "");
  ws.setExtraHeaders(c.authHeader);
  ws.onEvent(onEvent);
  ws.setReconnectInterval(3000);
}

void pump() {
  ws.loop();
  if (!linkUp) return;
  if (millis() - lastPing > PING_EVERY_MS) {
    lastPing = millis();
    ws.sendTXT("{\"t\":\"ping\"}");
  }
  if (millis() - lastRx > SILENCE_MS) {
    Serial.println("[WS] silent link, reconnecting");
    ws.disconnect();
    lastRx = millis();
  }
}

bool up() { return linkUp; }

void hello(const char* fw) { JsonDocument d; d["t"] = "hello"; d["fw"] = fw; send(d); }
void create(uint32_t satang, const char* ref) { JsonDocument d; d["t"] = "create"; d["amount"] = satang; d["ref"] = ref; send(d); }
void cancel(const char* pi) { JsonDocument d; d["t"] = "cancel"; d["pi"] = pi; send(d); }

}  // namespace net
