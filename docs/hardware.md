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
3V3` — check the silkscreen on yours; some boards also have IO22 on `P3`). Only `IO22` and `GND` are used: the
relay coil gets its **own 5 V supply**, never the CYD's `3V3` pin (see [Power](#power-read-this-if-the-board-reboots)).

```
      CYD  CN1                        relay module: own transistor driver + flyback diode,
   ┌──────────────┐                   IN switches at 3.3 V (opto-isolated is best)
   │ 3V3  ●  (not connected)          ┌────────────────────────┐
   │ IO22 ●───────┼───────────────────┤ IN                     │
   │ IO27 ●       │                   │                        │
   │ GND  ●───────┼─────────┬─────────┤ GND         COM ●──────┼──┐
   └──────────────┘         │    ┌────┤ VCC (5 V)   NO  ●──────┼──┼──┐
                            │    │    │             NC  ●      │  │  │
                            │    │    └────────────────────────┘  │  │
   5 V supply for the coil  │    │                                │  │
   (phone charger, buck)    │    │                                │  │
                  – ────────┘    │   (– joins the CYD's GND)      │  │
                  + ─────────────┘                                │  │
                                                                  │  │
      separate supply for the load                                │  │
   ┌───────────────┐   +                                          │  │   ┌──────────┐
   │ PSU / mains   ├──────────────────────────────────────────────┘  └───┤   LOAD   │
   │ (NOT the CYD) ├─────────────────────────────────────────────────────┤ (pump,   │
   └───────────────┘   –                                                 │  motor…) │
                                                                         └──────────┘
```

- **Power the load separately.** The relay contacts (`COM` / `NO`) switch the load's own supply. Never run a motor,
  pump or heater from the CYD's USB 5 V or 3.3 V pins.
- **Use a relay module, not a bare relay.** The module must have its own transistor (or optocoupler) driver and a
  flyback diode across the coil; nearly every "1-channel relay module" has both. A bare relay coil on a GPIO pin
  can't be driven and its switch-off spike can reset or damage the ESP32. An SSR with a 3–32 V input or a
  logic-level MOSFET driver board also works.
- **The input must switch at 3.3 V.** Opto-isolated modules with a `JD-VCC` jumper are the safest choice: remove the
  jumper, feed `JD-VCC` from the relay's 5 V supply and keep the input side on the CYD's GPIO and `GND`.
- **Polarity:** many cheap relay boards are *low-trigger* (the relay turns on when `IN` is pulled low). If the relay
  is on while idle and off while running, set `RELAY_ACTIVE_HIGH = false` in `firmware/include/config.h`.
- **Mains:** switching 230 V needs a relay rated for it, proper insulation, an enclosure and a fuse. If you're not
  qualified to wire mains, use a ready-made, certified relay/SSR box.
- The relay is switched off at boot before anything else runs, and a hardware timer switches it off after
  `RUN_SECONDS` even if the main loop hangs. During a reset GPIO 22 floats for a moment: prefer a module whose input
  is *off* when left open (most active-high modules), or add a 10 kΩ resistor from `IN` to `GND` (active-high) or to
  the module's `VCC` (low-trigger).

## Power (read this if the board reboots)

The CYD's 3.3 V regulator already feeds the ESP32, the display and the WiFi radio, which draws current peaks of a few
hundred mA while transmitting. A relay coil (70–150 mA, plus the spike when it switches) on the same rail can pull
the voltage below what the ESP32 needs, and the chip resets itself. Typical sign: **the board reboots a few seconds
after the relay clicks on**, often just as it sends the next WiFi packet.

Every boot prints why the board restarted, first thing on the serial monitor:

```
[BOOT] reset reason BROWNOUT (9)
[BOOT] the 3.3 V supply sagged: power the relay from its own supply (docs/hardware.md, 'Power')
```

| Reset reason | Meaning |
|---|---|
| `POWERON` | Plugged in, or the EN/RST button was pressed (the ESP32 reports both the same way). |
| `SW` | Software restart (e.g. after flashing). |
| `BROWNOUT`, `PWR_GLITCH` | **The supply voltage dropped.** Fix the power, see below. |
| `PANIC`, `INT_WDT`, `TASK_WDT`, `WDT`, `CPU_LOCKUP` | A crash or a hang. The boot log then also prints `[BOOT] core dump …` and `[BOOT] backtrace …` (saved in flash by the crash, printed once). Please open an issue with the whole serial log. |

While the relay runs, the serial log prints one line per second with the free memory, e.g.
`[RUN] 42s left, heap 180000 free / 110000 largest / 170000 min, loop stack 5000 free`. Steady numbers followed by
`BROWNOUT` point at the power supply; numbers that keep falling point at a software bug (please report it).

If you see `BROWNOUT`:

1. **Take the relay's `VCC` off the CYD's `3V3` pin.** Power the relay coil from a separate 5 V supply (a phone
   charger or a small buck converter), with its `GND` joined to the CYD's `GND` as in the diagram above.
2. **Use a relay module with its own driver and flyback diode** (see [Relay wiring](#relay-wiring)), or an SSR.
3. **Give the CYD a good 5 V / 2 A USB supply and a short cable.** Long, thin cables drop voltage when WiFi transmits.
4. **Suppress the load.** A motor, pump or solenoid needs a flyback diode (DC) or an RC snubber / varistor (AC)
   across it, and its wires should run away from the CYD.

A brownout while the relay runs switches it off early: the payment is already done at Stripe, so the rest of that
run is lost (refund it from the Stripe Dashboard if needed). QRun Lite does not resume a run after a reboot.

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
