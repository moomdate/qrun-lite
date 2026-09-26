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
  const char* qr;          // QR payload (QR screen)
  bool cancelling;         // cancel sent, waiting for the Worker
  lite::Message message;   // MESSAGE screen
};

bool begin();                       // false if the frame buffer can't be allocated
void draw(const View& v);
bool hitPrice(int x, int y);        // the price button (IDLE)
bool hitCancel(int x, int y);       // the cancel button (QR)

}  // namespace ui
