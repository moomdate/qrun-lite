// Screens on the CYD's 320x240 display. Each frame is drawn in full into an 8-bit sprite, then pushed.
#pragma once
#include <stdint.h>
#include "logic.h"

namespace ui {

struct View {
  lite::Screen screen;
  bool wifi, online, live;
  uint32_t price;          // satang
  uint32_t secondsLeft;    // QR or run countdown
  uint32_t totalSeconds;   // length of that countdown (progress bar / ring); 0 = unknown
  const char* qr;          // QR payload (QR screen)
  bool cancelling;         // cancel sent, waiting for the Worker
  lite::Message message;   // MESSAGE screen
  uint32_t splashPct;      // SPLASH progress 0..100
  const char* version;     // SPLASH firmware version text
};

bool begin();                       // false if the frame buffer can't be allocated
void draw(const View& v);
void splashDone();                   // the boot splash ran to its end (needed for the authentic credit check)
bool hitPrice(int x, int y);        // the price button (IDLE)
bool hitCancel(int x, int y);       // the cancel button (QR)

}  // namespace ui
