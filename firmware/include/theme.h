// Colours of the on-screen UI. Edit here to re-skin the kiosk; layout lives in src/ui.cpp, texts in strings.h.
//
// The frame buffer is 8-bit (RGB332: 8 levels of red, 8 of green, only 4 of blue), so any other RGB565 value is
// rounded to the nearest of 256 colours and may shift. rgb332() takes the three levels directly, so what you
// write is exactly what the panel shows:  red 0..7, green 0..7, blue 0..3  (0 = none, max = full).
#pragma once
#include <stdint.h>

namespace theme {

// RGB332 levels -> RGB565 that the 8-bit sprite keeps unchanged.
constexpr uint16_t rgb332(uint8_t r, uint8_t g, uint8_t b) {
  return (uint16_t)((((r << 2) | (r >> 1)) << 11) | (((g << 3) | g) << 5) | ((b << 3) | (b << 1) | (b >> 1)));
}

constexpr uint16_t BG      = rgb332(0, 1, 1);   // screen background (navy)
constexpr uint16_t SURFACE = rgb332(1, 2, 1);   // cards, status pill, disabled buttons, progress tracks
constexpr uint16_t SHADOW  = rgb332(0, 0, 0);   // drop shadow under raised buttons
constexpr uint16_t TEXT    = rgb332(7, 7, 3);   // main text
constexpr uint16_t MUTED   = rgb332(4, 5, 3);   // secondary text
constexpr uint16_t DIM = rgb332(3, 3, 2);  // text on a disabled button

constexpr uint16_t ACCENT  = rgb332(1, 4, 3);   // brand colour: the price button, logo mark
constexpr uint16_t GOOD    = rgb332(0, 6, 1);   // paid / online / running
constexpr uint16_t WARN    = rgb332(7, 5, 0);   // TEST mode, connecting, QR running out of time
constexpr uint16_t BAD     = rgb332(6, 1, 0);   // errors, cancel button, last seconds of a QR

constexpr uint16_t QR_BG   = rgb332(7, 7, 3);   // QR card and quiet zone: keep white
constexpr uint16_t QR_FG   = rgb332(0, 0, 0);   // QR modules: keep black (maximum contrast)

}  // namespace theme
