# Backtrail

Off-grid messaging for **goTenna Mesh®** and **Meshtastic®** radios, by BlackFox Media LLC.
Available on Google Play and the Apple App Store. This repository is the complete
corresponding source code of the app, licensed under the **GNU GPL v3.0** (see `LICENSE`).

Backtrail talks to radios you own over Bluetooth LE: group and direct messages with delivery
receipts, optional AES-256-GCM encryption for goTenna, check-ins, location sharing, SOS, an
offline radar map with breadcrumb trails and GPX export, contacts and QR codes, and Meshtastic
nodes, channels, and radio settings. No account, no servers, no analytics.

## Layout

| Path | What it is |
|---|---|
| `webapp/` | The app itself (HTML/CSS/JS). Runs as a PWA in Chrome/Edge (Web Bluetooth) and inside the native apps. |
| `webapp/gt.js`, `webapp/ble.js` | Independent goTenna Mesh protocol implementation and Bluetooth driver |
| `webapp/mesh.js` | Meshtastic adapter on the official `@meshtastic/core` library |
| `webapp/vendor/` | Bundled third-party code, built by `vendor-build/` |
| `vendor-build/` | Reproducible build of `webapp/vendor/*.js` (esbuild) |
| `android/` | Capacitor 8 Android project |
| `ios/` | Capacitor 8 iOS project (Swift Package Manager) |
| `tools/store-demo.js` | Developer tool for staging store screenshots (not shipped) |
| `*.py` | Python reference implementation and CLI tools (`gotenna.py`, `backtrail.py`, ...) |
| `FINDINGS.md`, `RECOVERY.md` | Protocol research notes |

## Build

Requirements: Node.js 20+, JDK 21 and the Android SDK (Android), Xcode 16+ on macOS (iOS).

```sh
npm install
npm run build:vendor      # rebuild webapp/vendor from source (optional; prebuilt copies are committed)
npm run sync:android      # copy webapp/ into android/ and sync plugins
cd android && ./gradlew assembleRelease     # unsigned unless you configure signing (see android/app/build.gradle)
```

iOS (on a Mac):

```sh
npm install
npm run sync:ios          # copy webapp/ into ios/ and sync plugins
open ios/App/App.xcodeproj
```

Web: serve `webapp/` over HTTPS (or `localhost`) and open it in Chrome or Edge.

## Not included

- goTenna's recovery firmware (proprietary to goTenna, Inc.)
- Release signing keys and store credentials

## Legal

Backtrail is independent interoperability software. It contains no goTenna, Inc. software, SDK,
or brand assets. goTenna Mesh® is a registered trademark, and goTenna™ is a trademark, of
goTenna, Inc. Meshtastic® is a registered trademark of Meshtastic LLC. BlackFox Media LLC is not
affiliated with, authorized by, or endorsed by goTenna, Inc. or Meshtastic LLC.

Third-party components and their licenses: `THIRD_PARTY_NOTICES.md`.
Privacy: `PRIVACY.md`. Not for emergency use: Backtrail cannot contact emergency services.

© 2026 BlackFox Media LLC. Support: support@blackfox-media.com
