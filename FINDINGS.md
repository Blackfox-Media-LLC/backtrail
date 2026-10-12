# Findings

## Device under test
- **Identity (USB iProduct string):** ` GOTENNA 900`
- **USB:** VID `1FC9` (NXP) / PID `8181` / REV `0101`, serial `MX########`
- **Class:** CDC-ACM (Communications 0x02 / Abstract Control Model 0x02), single
  virtual COM port (COM5 on this machine), `usbser` driver.
- **MCU (from teardowns):** NXP Kinetis MK24 (Cortex-M4). BT: nRF52832.
  Radio: Silicon Labs Si4460 (FSK, **not** LoRa).

## What this is / isn't
- **It is goTenna *application* firmware**, not a bootloader — the iProduct
  string is "GOTENNA 900" and it did not answer an NXP KBOOT ping.
- **It is a newer hardware/firmware revision** than the community-documented
  units, which enumerate as PID `2047` with iProduct "goTenna". The reverse-
  engineering notes (dogshoes, pyGT) all describe that older PID-2047 line.

## Probes tried on COM5 (all READ-ONLY or benign) — all silent
| Probe | Result |
|---|---|
| Passive listen, DTR low, 30 s + button press | 0 bytes |
| Passive listen, DTR+RTS raised, 20 s + button press | 0 bytes |
| Text CLI `version` with `;`, CR, LF, CRLF terminators | no reply |
| goTenna binary `OP_SYSINFO` frame (pyGT framing, CRC-OK) | no reply |
| Same, baud sweep 4800 / 19200 / 38400 / 57600 / 115200 / 230400 | no reply |
| NXP KBOOT ping `5A A6` | no reply |

**Conclusion:** this firmware revision does not expose the old text console, and
does not answer the pyGT BLE-style binary framing *over the USB serial link*.
Blind serial probing is exhausted.

## Validated assets we built
- `gt_protocol.py` — correct goTenna frame builder/parser: STX/ETX DLE framing,
  CRC16-XMODEM (verified against the 0x31C3 check value), opcode table, safe
  reply de-framing. Reusable over **any** transport (serial or BLE).
- `serial_probe.py` — gated serial toolkit (info/listen/send/op/kboot-ping).
- `probe.py` — BLE scanner/enumerator (works, `bleak` 3.0.2).

## Known goTenna BLE GATT UUIDs (from pyGT `gtdefs.py`)
These are the primary transport the protocol was designed for:
- Service: `12762b18-df5e-11e6-bf01-fe55135034f3`
- TX (write):  `1276b20a-df5e-11e6-bf01-fe55135034f3`
- RX (notify): `1276b20b-df5e-11e6-bf01-fe55135034f3`

## *** MAJOR FINDING: the device is in Nordic DFU bootloader mode ***

BLE scan found the unit advertising as **`DfuTarg`** (rssi -48, on the desk)
with Nordic's legacy DFU service. GATT enumeration confirmed:

- Device Name: `DfuTarg`
- Service `00001530-1212-efde-1523-785feabcd123` (Nordic **legacy** DFU, not
  Secure DFU which would be `0xFE59`)
  - `00001531` DFU Control Point (notify, write)
  - `00001532` DFU Packet (write-without-response)
  - `00001534` DFU Version = `08 00` (legacy DFU v8)

**Interpretation:** the goTenna's **nRF52832 (Bluetooth MCU) is not running its
application firmware** — it has fallen back to / been left in its DFU
bootloader, which only advertises `DfuTarg` when there is no valid app to boot
(or it was explicitly triggered into DFU). This matches the USB/Kinetis side
identifying as "GOTENNA 900" but answering no commands: **the unit is not booted
into normal operating firmware.**

Consequences:
- The goTenna BLE application service (`12762b18…`) is absent, so the pyGT
  command protocol has nothing to talk to over BLE either.
- To function again the unit needs valid firmware **restored** via this DFU
  bootloader. The official goTenna image is proprietary and the update servers
  are shut down, so it is not readily available.
- Because this is **legacy** DFU (typically no signature enforcement), the
  bootloader would likely accept an **unsigned** image — i.e. custom firmware is
  technically flashable here — but no open goTenna/nRF52 firmware exists, and
  the radio/mesh brains are the Kinetis + Si4460 anyway (still not Meshtastic-
  compatible: Si4460 is FSK, not LoRa; nRF52832 ≠ Meshtastic's nRF52840 target).

### DO NOT WRITE to the DFU control point (`00001531`) or packet (`00001532`)
Writing there starts/erases for a firmware update and is destructive without a
correct image in hand. All DFU interaction stays read-only until there is a
deliberate, image-in-hand decision.

### Zero-risk next diagnostic — DONE, CONCLUSIVE
Re-scanned three ways, all come up `DfuTarg` at the same address
`XX:XX:XX:XX:XX:XX`:
- plugged into USB → `DfuTarg`
- unplugged, on battery → `DfuTarg` (rssi -44)
- after a full power-off → power-on cycle → `DfuTarg`

**Conclusion: the nRF52 application firmware is gone/invalid.** The device boots
directly into the Nordic DFU bootloader every time. It will only recover by
flashing a valid firmware image back through legacy DFU.

### Revival route: obtain a firmware image, then legacy-DFU flash
Most promising source: goTenna distributed firmware **inside the mobile app**,
which OTA-updated the device. An archived goTenna Mesh **APK** likely bundles the
Nordic DFU package (a .zip containing `manifest.json` + `*.bin`/`*.dat`). Steps:
1. Obtain an old goTenna Mesh APK (APKMirror/APKPure/archive.org).
2. Unzip and search assets for a Nordic DFU package / firmware blobs.
3. Flash via legacy DFU (`nrfutil dfu ble`, or nRF Connect, or our own DFU
   client against control point `00001531` / packet `00001532`).
Also check: goTenna community forum archives and the Wayback Machine for a
published DFU image.

## Recommended next route: BLE, not serial
pyGT's framing is designed for BLE GATT (write frame in ≤20-byte chunks to TX,
read reply as notifications on RX). That is far more likely to work on this
BLE-first firmware than the serial link. Plan:
1. Put the goTenna in BLE advertising mode; `python probe.py scan`.
2. `python probe.py enumerate <addr>` — look for service `12762b18…`.
3. If present, send an `OP_SYSINFO` frame to TX `1276b20a…`, read RX
   `1276b20b…` notifications, de-frame with `gt_protocol`.

If BLE is also silent, the fallback is a **reference capture**: run an old
goTenna APK (local comms may still work offline) with Android HCI snoop logging,
or an nRF52840 BLE sniffer, to observe the real handshake this revision expects.

## *** RECOVERED 2026-10-11 ***
Flashed the 3 recovery packages from this PC with `dfu_flash.py` (legacy DFU
over bleak). All phases: start accepted -> init accepted -> image received ->
validated -> activate+reset. BLE address stepped C1:B7->C1:B8 (after bootloader)
->C1:B9 (after app), as expected for Nordic BL/app resets.

Post-recovery enumeration (addr XX:XX:XX:XX:XX:XX):
- Manufacturer Name: `Gotenna`
- Model Number: `goTenna Mesh`
- Hardware Revision: `00`
- **Firmware Revision: `1.1.8`**
- Service `1276aaee-df5e-11e6-bf01-fe55135034f3`:
  - `12762b18-…` read/notify  (status, = pyGT GT_UUID_ST)
  - `1276b20a-…` write/wnr     (command TX, = pyGT GT_UUID_TX)
  - `1276b20b-…` notify        (command RX, = pyGT GT_UUID_RX)

The unit is fully operational again on stock fw 1.1.8. The original goal —
a new app driving it over BLE — is now viable (and 1.1.8 also restores the USB
serial console).

## Second unit + message-size probe (2026-10-11)
- **Unit 2:** serial `MX########`, **firmware 1.1.12**, region North America,
  healthy (never in DFU). Seen at BLE address `XX:XX:XX:XX:XX:XX`.
- **Sysinfo layout (partial):** bytes 7-9 = firmware version major/minor/patch
  (`01 01 08` on unit 1, `01 01 0c` on unit 2); repeated in the last 3 bytes.
  Serial is the ASCII run at offset 13. Byte 5 changes slowly (battery?).
- **Max message size:** OP_SENDMSG accepted content blobs of 120/160/180/200/
  220/237 bytes (237 = TLV ceiling; PDU 265 B) on fw 1.1.8. Backtrail uses a
  conservative 180-byte blob until over-the-air delivery is confirmed between two
  units; raising it to 237 would cut airtime per long message ~25%.
- **Encrypted multi-part send** (2 parts) accepted on fw 1.1.12 as well.

## Over-the-air messaging between two units — VERIFIED (2026-10-11)
Unit 1 (MX########, fw 1.1.8) -> unit 2 (MX########, fw 1.1.12), units ~inches apart.

1. **App ID filter (root cause of first failure).** Devices only deliver received
   messages whose app ID matches their own. Our first messages used 0x7FFF and were
   silently dropped; the same shout with **0x3FFF (goTenna app's app ID)** arrived.
   Backtrail now uses 0x3FFF, which makes it work with stock-configured devices and
   lets it exchange plain messages with the original goTenna app. Short plain
   messages carry the goTenna-app CRC16 so that app can read them; Backtrail's
   encrypted/part blobs omit it, so that app ignores them rather than showing junk.
2. **Listener bug fixed.** The first message-waiting change was ignored because the
   status value wasn't seeded on connect. Now seeded + periodic inbox poll backstop.
3. **Loss rate ~1 in 5 per radio message** in this setup, intermittent, not tied to
   size (171 B arrived reliably), header duplication (identical headers both
   arrived), receiver read/delete races (idle-drain test still lost one), or spacing
   (4 s and 8 s gaps both lost one). Possibly receiver overload from the units being
   inches apart. Shout TTL 3 made it worse (receiver busy relaying); **TTL 1**
   (goTenna app default for shouts) improved it.
4. **Mitigation shipped:** TTL 1 for shouts; encrypted/multi-part messages sent in
   **2 passes**, 2.5 s apart, with receiver-side de-duplication; parts raised to the
   237-byte ceiling (fewer parts per message).
5. **Final end-to-end result:** plain shout, single-part encrypted, and a **5-part
   encrypted long message** all delivered, decrypted, and displayed **exactly once**.

Open: measure loss at realistic separation (3+ m, then range); consider a
receiver-requested resend (NACK) for P2P if field loss stays high.

## Direct messages, delivery receipts, and the real web app (2026-10-11)
- **Direct (P2P) messages need the radio's ID programmed.** `OP_SET_GID` (0x01)
  takes 10 bytes: class `00`, app ID `3F FF`, 6-byte GID, tag `00`. A radio only
  delivers P2P messages addressed to its programmed GID (verified: a message to a
  non-existent GID was not delivered). Both apps now program the user's ID on connect.
- **Native delivery receipts.** For a delivered P2P message the sender's radio
  gets an inbox item with a DLR TLV (`21 03 <status> <id16>`); status 1 = delivered.
  The id is **GTH16 over the message's 16-byte HEAD** (verified against a live
  receipt). Each part's HEAD is made unique (seq0 = msg id, seq1 = part index) so
  every part has its own receipt id. Both apps resend only unconfirmed parts
  (up to 2 extra rounds, 20 s wait each).
- **P2P PDU limit:** a 237-byte part was rejected for P2P (address + X04 TLV add
  12 bytes). Part size set to 225 bytes for all message types.
- **Live results:** 3-part encrypted P2P delivered + decrypted (all receipts
  matched, no resends needed).
- **Web app over real Web Bluetooth (Edge, Puppeteer-driven device picker):**
  connected, showed device info, sent encrypted P2P -> "Delivered", received an
  encrypted shout and a 2-part encrypted P2P, all decrypted. goTenna radios show in
  the browser's picker as **"Unknown or unsupported device (MAC)"** (no advertised
  name); the app now tells users to expect that.
- **Signal byte:** HOPS TLV second byte reads 218-227 at ~inches apart; treated as
  signed dBm-like (-38 to -29). `gotenna.py rangetest send|listen` logs per-ping
  signal and loss for field tests.
- **Test IDs left on the bench units:** unit 1 = 0x0000BBBB0002, unit 2 =
  0x0000AAAA0001. The app reprograms each radio to the user's own ID on connect.

## Multi-network: Meshtastic (2026-10-11)
Test radio: **Heltec V3** "[redacted]" (node `![redacted]`), Meshtastic fw
**2.7.12**, US region, USB via CP2102 (needed the Silicon Labs CP210x driver,
Windows problem code 28 until installed) on COM7. It heard no other Meshtastic
nodes, so over-the-air Meshtastic *reception* is not yet verified.

Verified on the real radio:
- `backtrail.py mesh-info` / `mesh-send` (official Python `meshtastic` 2.7.11).
- **Live bridge goTenna -> Meshtastic:** unit 2 shouted on goTenna; the bridge
  (unit 1 + Heltec) received it over the air, tagged it `[gT name]`, and
  transmitted it on Meshtastic.
- The **web adapter (`webapp/mesh.js`)** run in Node over USB against the radio
  (official Node serial transport injected in place of Web Serial): connects,
  reads node info, sends single and multi-part broadcasts.

Library behaviors found and handled (both would have hurt the app):
- `MeshDevice.configure()` awaits an ACK the radio never sends (library times out
  at ~60 s). Don't await it; wait for DeviceStatus 7 (configured). Connect went
  from 60.2 s to 4.8 s.
- `sendText()` for a **broadcast** never resolves on a quiet mesh (no routing
  ACK unless another node rebroadcasts). Wrapped with a 3 s cap (was 20 s).
  Direct messages use wantAck with a 60 s cap -> "Delivered"/"Not confirmed".
- `disconnect()` can hang on serial; capped at 3 s so the UI never freezes.
- The bundled library references Node's `process`; without the injected shim the
  page died with "process is not defined" before any UI loaded.
- Self-addressed Meshtastic text is not echoed back to the API (no loopback test
  possible); RX path verified with library-format packets instead.

Still to verify with a **second Meshtastic node**: over-the-air reception, the
Meshtastic -> goTenna relay, and direct-message ACKs.
