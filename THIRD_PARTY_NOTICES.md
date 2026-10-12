# Third-party notices

Backtrail is © 2026 BlackFox Media LLC and licensed under GPL-3.0 (see LICENSE).
All third-party components below are GPL-3.0-compatible.

Backtrail / goTenna Revival is independent, clean-room interoperability software.
It does not include or use goTenna's SDK.

## pyGT (protocol reverse engineering) — MIT License
The goTenna BLE/serial command framing, opcode values, GATT UUIDs, and message
envelope structure implemented here were reverse-engineered and documented by the
**pyGT** project (https://github.com/sybip/pyGT) and related work (gtm-lab,
gr-tenna). Our `gt_protocol.py`, `gt_message.py`, and `webapp/gt.js` are
independent implementations informed by that publicly available research.

pyGT is distributed under the MIT License:

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

(Confirm the exact upstream copyright line from the pyGT repository before
shipping.)

## Recovery firmware
The nRF52 recovery packages in `firmware/` are goTenna's own firmware images,
redistributed by the community for device recovery. They are the property of
goTenna, Inc. Ship/redistribute them only if you have the right to; otherwise
direct users to obtain them from the goTenna app/community themselves.

## Trademarks
goTenna Mesh® (U.S. Reg. No. 5,318,148) is a registered trademark, and goTenna™ is a trademark, of goTenna, Inc. All other marks belong to their owners.
This project is not affiliated with, authorized, or endorsed by goTenna, Inc.

## Meshtastic support — GPL-3.0-only
Backtrail's Meshtastic support uses the official Meshtastic libraries:
- **@meshtastic/core** 2.6.7 and **@meshtastic/transport-web-bluetooth** 0.1.5
  (GPL-3.0-only), bundled into `webapp/vendor/meshtastic.js`. The bundle includes
  the protobuf-es runtime (Apache-2.0) as shipped inside @meshtastic/core, and
  **crc** 4.3.2 (MIT). Build source: `vendor-build/` (entry, shims, build script);
  rebuild with `cd vendor-build && npm install && npm run build`.
- **meshtastic** (Python) 2.7.11 (GPL-3.0-only), with pypubsub (BSD-2-Clause),
  protobuf (BSD-3-Clause), bleak (MIT), and pyserial (BSD-3-Clause).
Meshtastic® is a registered trademark of Meshtastic LLC. BlackFox Media LLC is not
affiliated with, authorized by, or endorsed by Meshtastic LLC; the name is used
only to identify compatible hardware (nominative fair use).

## App platform and feature libraries
Bundled into `webapp/vendor/native.js` and `webapp/vendor/libs.js` (build source:
`vendor-build/`), or compiled into the Android/iOS apps:
- **Capacitor** 8.5.3 (@capacitor/core, android, ios) (MIT)
- **@capacitor-community/bluetooth-le** 8.3.0 (MIT)
- **@capacitor/local-notifications**, **@capacitor/geolocation**,
  **@capacitor/barcode-scanner**, **@capacitor/filesystem**, **@capacitor/share** (MIT)
- **@capawesome-team/capacitor-android-foreground-service** (MIT)
- **@meshtastic/transport-web-serial** 0.2.5 (GPL-3.0-only)
- **@bufbuild/protobuf** (protobuf-es) (Apache-2.0)
- **Leaflet** 1.9.4 (BSD-2-Clause), loaded only when the optional street map is on
- **qrcode-generator** 2.0.4 (MIT)

Map tiles and data (optional street map only): © OpenStreetMap contributors,
available under the Open Database License (ODbL). Tiles are served by the
OpenStreetMap Foundation subject to its Tile Usage Policy.
