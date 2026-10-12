# Backtrail

Off-grid messaging app for **goTenna Mesh** devices. Connects straight to the
device over **Web Bluetooth** (Chrome/Edge on desktop or Android) — no phone
app, no account, no servers. Everything is local and peer-to-peer.

## Features
- Connect to a goTenna Mesh over BLE and show live device info (model, firmware,
  serial, battery).
- **Shout** (broadcast) and **Direct** (point-to-point by GID) text messaging.
- Automatic **inbox** — incoming messages appear as they arrive (driven by the
  device's message-waiting indicator).
- **RF region** selector (US 900 MHz / EU 868 MHz / AU / NZ / JP).
- **End-to-end encryption:** set a channel passphrase shared with your group;
  message text and nickname are encrypted with AES-256-GCM. Messages from people
  without the passphrase show as locked.
- **Direct messages with delivery receipts:** your ID is programmed into the
  radio on connect; direct messages show "✓ Delivered" when the recipient's radio
  confirms, and unconfirmed parts are resent automatically.
- **Long messages** (up to ~2,000 characters): split into radio-sized parts and
  reassembled automatically, in any arrival order.
- Local identity (nickname + GID), stored only in the browser.
- Installable **PWA**, works **offline** (the app shell is cached — fitting for
  field use).
- Light / dark theme.

## Meshtastic (multi-network)
Connect a Meshtastic radio from the **Meshtastic radio** panel (Web Bluetooth).
Messages from both networks share one inbox, labeled by network. Choose
**via goTenna / Meshtastic / Both** when sending. Turn on **Relay** to forward
broadcasts between the two networks (direct messages are never relayed; relayed
text is tagged `[gT name]` / `[MT name]` and never relayed twice).
The Meshtastic code is the official GPL-3.0 library, bundled into
`vendor/meshtastic.js` from `../vendor-build/`.

## Run it (local, for development / self-host)
Web Bluetooth needs a secure context; `localhost` qualifies.
```
cd webapp
python -m http.server 8000
# open http://localhost:8000 in Chrome or Edge
```
Click **Connect**, pick your goTenna, and message.

> Requires a working goTenna Mesh. If yours shows up as `DfuTarg`, recover it
> first (see ../RECOVERY.md).

## Browser support
Web Bluetooth works in Chrome/Edge (desktop + Android) and Chromium browsers.
It is **not** available in Safari/iOS — for iOS, package with Capacitor + a
native BLE plugin (see ../ROLLOUT.md).

## Files
- `gt.js` — protocol (framing, CRC16-XMODEM, opcodes, message build/parse).
  Verified byte-for-byte against the Python reference and a real device.
- `ble.js` — Web Bluetooth driver (`GoTenna` class).
- `app.js` — UI logic. `index.html` / `styles.css` — interface.
- `sw.js` / `manifest.webmanifest` / `icon.svg` — PWA shell.

Not affiliated with goTenna, Inc. See ../ROLLOUT.md and ../THIRD_PARTY_NOTICES.md.
