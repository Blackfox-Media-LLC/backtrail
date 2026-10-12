# goTenna Mesh DFU recovery

Your unit boots straight into the Nordic DFU bootloader (`DfuTarg`) because its
nRF52832 Bluetooth **application firmware is gone**. This restores the official
goTenna firmware by flashing three Nordic legacy-DFU packages, in order, over
Bluetooth. After this the unit should boot and behave as a normal goTenna Mesh
again.

> This restores **official goTenna firmware** (makes it a working goTenna). It is
> not open-source firmware — there is none for this hardware (Si4460 radio, see
> FINDINGS.md). Reviving the device is the realistic win here.

> **Not included in this repository.** The recovery packages are goTenna, Inc.'s proprietary
> firmware and are not redistributed here. Obtain them from goTenna or the owner community.

## Firmware files (in `firmware/`, flash in THIS order)
| Order | File | What it writes | SHA-256 |
|---|---|---|---|
| 1 | `nrf52_phase1.zip` | bootloader | `9f900349…aa32e87` |
| 2 | `nrf52_phase2_part1.zip` | SoftDevice S132 + bootloader | `1f27e89d…47dc2b2f` |
| 3 | `nrf52_phase2_part2.zip` | goTenna application | `9df11ba5…e895d4a9` |

Source: community-archived `gotenna_files.zip` (pingturtle.com), the same bundle
referenced by multiple goTenna recovery guides. Each is a valid Nordic legacy
DFU package (verified `manifest.json`, dfu_version 0.5, nRF52832 + S132).

## ⚠️ Read before flashing
- **Flash all three, in the exact order above.** Order matters — phase1 first.
- **Do NOT power off the goTenna during the process.** A half-flashed device may
  need the whole sequence re-run (it re-enters DFU, so it is usually not fatal,
  but don't tempt it).
- Make sure the goTenna has **decent battery** and stays **close to the phone**.
- The device is already in DFU (white LED / `DfuTarg`), so no trigger needed.
- Honest risk note: recovery guides warn of a small chance of permanent damage.
  But the unit is **already non-functional**, and this is the documented fix, so
  the risk/reward strongly favors trying.

## Method A — Android nRF Connect (recommended, proven)
1. Copy the three `.zip` files from `firmware/` to your Android phone.
2. Install **nRF Connect for Mobile** (Nordic Semiconductor) from Play.
3. Open nRF Connect → **Scanner** → find **DfuTarg** → **Connect**.
4. Tap the **DFU** icon (the "DFU" / cloud-up button in the top bar).
5. Choose **Distribution packet (ZIP)** → select `nrf52_phase1.zip` → start.
6. When it finishes, repeat the DFU step with `nrf52_phase2_part1.zip`.
7. Then once more with `nrf52_phase2_part2.zip`.
8. After the third completes, the device reboots within seconds and should come
   up as a normal goTenna (no longer `DfuTarg`).

(nRF Toolbox works the same way if you prefer it — the original guide used it.)

## Method B — from this PC (optional)
A Windows-side flasher is possible against control point `00001531` / packet
`00001532` using `bleak`, implementing the Nordic legacy DFU protocol. It's more
work and a bit riskier than the proven phone app, so use Method A unless you want
the PC route — the tooling can be built on request.

## Verifying success
After the final reboot, from this repo:
```
python probe.py scan
```
Success = it no longer advertises `DfuTarg`; instead you should see a goTenna
name or the service `12762b18-df5e-11e6-bf01-fe55135034f3`. At that point the
original "write a new app" project becomes viable again over BLE.
