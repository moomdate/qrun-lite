// Board I/O for the ESP32-2432S028R ("Cheap Yellow Display"): relay, speaker, touch, WiFi.
#pragma once
#include <stdint.h>

namespace hw {

void begin();                       // relay off first, then LEDs, speaker, touch
void relayOn(uint32_t ms);          // relay on + a hardware timer that switches it off after ms, even if loop() hangs
void relayOff();
void beepPaid();
void beepError();
void pump();                        // call every loop(): ends a beep
bool tapped(int& x, int& y);        // true once per new touch
void wifiBegin(const char* ssid, const char* pass);
bool wifiUp();                      // logs link changes

}  // namespace hw
