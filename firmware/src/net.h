// WebSocket link to the Worker (PROTOCOL.md): TLS with a pinned root CA bundle, device token, keepalive.
#pragma once
#include <stdint.h>

namespace net {

struct Config {
  const char* host;
  uint16_t port;
  bool tls;
  const char* deviceId;
  const char* authHeader;   // "Authorization: Bearer <device token>"
  const char* caBundle;
};

// Called from pump() for each frame / link change.
struct Handlers {
  void (*linkUp)();
  void (*linkDown)();
  void (*hello)(bool live);
  void (*payment)(const char* pi, const char* ref, const char* qr, int64_t expires);
  void (*status)(const char* pi, const char* status);
  void (*error)(const char* ref, const char* msg);
};

void begin(const Config& cfg, const Handlers& h);
void pump();
bool up();
void hello(const char* fw);
void create(uint32_t satang, const char* ref);
void cancel(const char* pi);

}  // namespace net
