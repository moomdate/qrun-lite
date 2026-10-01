# Third-party notices

QRun Lite's own code is under the [MIT License](LICENSE). It bundles or builds against the components below, which
keep their own licenses.

## Bundled in this repository

| Component | Where | License |
|---|---|---|
| [Sarabun](https://github.com/cadsondemak/Sarabun) font, © 2018 The Sarabun Project Authors | `firmware/src/fonts/sarabun18.h`, `sarabunBold36.h` (converted to TFT_eSPI smooth-font arrays, ASCII + Thai subset) | [SIL Open Font License 1.1](firmware/src/fonts/OFL.txt) |
| Root CA certificates: GTS Root R1, GTS Root R4 (Google Trust Services), ISRG Root X1 (Internet Security Research Group) | `firmware/include/root_ca.h` | public trust anchors, redistributed unchanged |

## Attribution and brand

[NOTICE](NOTICE): QRun Lite is crafted by birdlab.th. The birdlab.th logo (`tools/art/birdlab-logo.png`,
`firmware/include/logo_birdlab*.h`) is the author's brand, not MIT-licensed, included only as credit; keep the
boot-splash credit when you share builds.

## Downloaded at build time (not in this repository)

Firmware (`firmware/platformio.ini`, versions pinned there):

| Component | License |
|---|---|
| [Arduino-ESP32](https://github.com/espressif/arduino-esp32) core, via the [pioarduino](https://github.com/pioarduino/platform-espressif32) platform | LGPL-2.1 (core); ESP-IDF and its components: Apache-2.0 and others |
| [TFT_eSPI](https://github.com/Bodmer/TFT_eSPI) by Bodmer | mixed: FreeBSD and MIT (see its `license.txt`) |
| [arduinoWebSockets](https://github.com/Links2004/arduinoWebSockets) by Markus Sattler | LGPL-2.1 |
| [ArduinoJson](https://github.com/bblanchon/ArduinoJson) by Benoît Blanchon | MIT |
| [QRCode](https://github.com/ricmoo/QRCode) by Richard Moore | MIT |
| [Unity](https://github.com/ThrowTheSwitch/Unity) (native tests only) | MIT |

Worker (`worker/package.json`, development tools only; the deployed Worker has no runtime dependencies):

| Component | License |
|---|---|
| [wrangler](https://github.com/cloudflare/workers-sdk), [@cloudflare/workers-types](https://github.com/cloudflare/workerd) | MIT OR Apache-2.0 |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 |
| [Vitest](https://github.com/vitest-dev/vitest) | MIT |

## Notes for people who ship firmware binaries

- If you distribute a compiled firmware image (for example, preloaded kiosks), the LGPL-2.1 parts (Arduino-ESP32
  core, arduinoWebSockets) require that recipients can relink or rebuild it: pointing them to this repository and
  your exact `platformio.ini` satisfies that for most setups.
