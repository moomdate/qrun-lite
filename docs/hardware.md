# Hardware

## Board

**ESP32-2432S028R**, the "Cheap Yellow Display" (CYD): an ESP32-WROOM-32, a 2.8" 320×240 ILI9341 display, an
XPT2046 resistive touch panel, a speaker connector and an RGB LED, powered over micro-USB (5 V). About $10.

What QRun Lite uses:

| Part | Pins | Notes |
|---|---|---|
| Display (ILI9341) | MOSI 13, SCLK 14, CS 15, DC 2, RST 12, backlight 21 | set in `firmware/platformio.ini` |
| Touch (XPT2046) | CS 33, CLK 25, DIN 32, DOUT 39 | calibration in `firmware/src/hw.cpp` |
| Speaker | GPIO 26 | paid / error beeps; plug a small speaker into the `SPEAK` connector |
| RGB LED | GPIO 4, 16, 17 (active low) | kept off |
| **Relay output** | **GPIO 22** | on the 4-pin `CN1` connector, 3.3 V logic |

## Relay wiring

The relay input goes to **GPIO 22**. On most CYD boards it is on `CN1` (4-pin JST 1.25 mm, labelled `GND IO22 IO27
3V3` — check the silkscreen on yours; some boards also have IO22 on `P3`).

```
      CYD  CN1                    relay module (3.3 V-compatible input)
   ┌─────────────┐              ┌───────────────────────┐
   │ 3V3  ●──────┼──────────────┤ VCC                   │
   │ IO22 ●──────┼──────────────┤ IN          COM ●─────┼──┐
   │ IO27 ●      │              │             NO  ●─────┼──┼──┐
   │ GND  ●──────┼──────────────┤ GND         NC  ●     │  │  │
   └─────────────┘              └───────────────────────┘  │  │
                                                           │  │
      separate supply for the load                         │  │
   ┌───────────────┐   +                                   │  │   ┌──────────┐
   │ PSU / mains   ├───────────────────────────────────────┘  └───┤   LOAD   │
   │ (NOT the CYD) ├──────────────────────────────────────────────┤ (pump,   │
   └───────────────┘   –                                          │  motor…) │
                                                                  └──────────┘
```

- **Power the load separately.** The relay contacts (`COM` / `NO`) switch the load's own supply. Never run a motor,
  pump or heater from the CYD's USB 5 V or 3.3 V pins.
- **Use a relay input that triggers at 3.3 V**: a 3.3 V relay module, an opto-isolated module, an SSR with a 3–32 V
  input, or a logic-level MOSFET driver. A bare 5 V relay coil can't be driven from a GPIO pin.
  If your module needs 5 V on `VCC`, take it from the CYD's 5 V pad or a separate 5 V supply (common `GND`) and make
  sure `IN` still switches at 3.3 V.
- **Polarity:** many cheap relay boards are *low-trigger* (the relay turns on when `IN` is pulled low). If the relay
  is on while idle and off while running, set `RELAY_ACTIVE_HIGH = false` in `firmware/include/config.h`.
- **Mains:** switching 230 V needs a relay rated for it, proper insulation, an enclosure and a fuse. If you're not
  qualified to wire mains, use a ready-made, certified relay/SSR box.
- The relay is switched off at boot before anything else runs, and a hardware timer switches it off after
  `RUN_SECONDS` even if the main loop hangs.

To use another pin, change `RELAY_PIN` in `firmware/include/config.h`. Avoid the pins the display, touch and
speaker already use (see the table above), GPIO 0/2/12/15 (boot straps) and GPIO 34–39 (input only).

## CYD variants

"CYD" is sold in several versions that look alike:

| Variant | What to change |
|---|---|
| **ESP32-2432S028R**, one micro-USB port (the original) | nothing; this is the default |
| Colours inverted (black is white) | toggle `TFT_INVERSION_ON` in `firmware/platformio.ini` (remove the flag or set it for your board) |
| Touch is off or mirrored | adjust `touch.setCal(...)` in `firmware/src/hw.cpp` (min/max X, min/max Y, rotation) |
| **CYD2USB** (micro-USB + USB-C) | uses an ST7789 display driver: replace `ILI9341_2_DRIVER` with `ST7789_DRIVER` in `platformio.ini`, and check the inversion flag |
| 2.4" / 3.2" / 3.5" "CYD-like" boards | different display, touch and pins; not supported as-is |

The board needs a **USB data cable** for flashing (many cheap cables are charge-only) and the CH340 USB-serial
driver on older macOS/Windows versions. It shows up as `/dev/cu.usbserial-*` on macOS and `/dev/ttyUSB*` on Linux.

## Enclosure tips

- Leave the USB port reachable for re-flashing.
- Put the relay (and anything carrying mains) in its own compartment, away from the CYD.
