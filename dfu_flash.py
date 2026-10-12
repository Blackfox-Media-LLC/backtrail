#!/usr/bin/env python3
"""Nordic legacy-DFU flasher over BLE (bleak) for goTenna Mesh recovery.

Flashes the goTenna recovery packages (firmware/nrf52_phase*.zip) to a device
sitting in the Nordic legacy DFU bootloader ("DfuTarg"), straight from this PC's
Bluetooth adapter — no phone required.

This implements the nRF5-SDK *legacy* DFU protocol (DFU service 0x1530, the one
this device exposes), driving the Control Point (0x1531) and Packet (0x1532)
characteristics.

SAFETY
------
  * `--dry-run` (default) parses the package(s) and prints the exact DFU steps
    and byte counts it WOULD send. No Bluetooth, no writes. Always run this first.
  * A real flash requires BOTH `--flash` and `--i-understand-risk`.
  * Flash order for full recovery: phase1 -> phase2_part1 -> phase2_part2.
    The --all mode enforces that order. Do not power off the device mid-flash.
  * A failed stage is normally recoverable: the device re-enters DFU ("DfuTarg")
    and the stage can be re-run.

Usage:
  python dfu_flash.py --dry-run --all
  python dfu_flash.py --flash --i-understand-risk --all
  python dfu_flash.py --flash --i-understand-risk firmware/nrf52_phase1.zip
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import sys
import time
import zipfile
from pathlib import Path

DFU_CONTROL = "00001531-1212-efde-1523-785feabcd123"
DFU_PACKET = "00001532-1212-efde-1523-785feabcd123"
DFU_NAME = "DfuTarg"

# Legacy DFU control-point opcodes
START_DFU = 0x01
INIT_DFU = 0x02
RECEIVE_FW = 0x03
VALIDATE = 0x04
ACTIVATE_RESET = 0x05
PRN_REQ = 0x08
RESPONSE = 0x10
PRN = 0x11

# Image-type bitmask
T_SOFTDEVICE = 0x01
T_BOOTLOADER = 0x02
T_APPLICATION = 0x04

PRN_INTERVAL = 8           # request a receipt notification every N packets
CHUNK = 20                 # BLE payload bytes per packet write
PROJECT = Path(__file__).resolve().parent
PHASE_ORDER = ["nrf52_phase1.zip", "nrf52_phase2_part1.zip", "nrf52_phase2_part2.zip"]


class DfuError(Exception):
    pass


class Package:
    """A parsed Nordic legacy DFU .zip."""

    def __init__(self, path: Path):
        self.path = path
        z = zipfile.ZipFile(path)
        man = json.loads(z.read("manifest.json"))["manifest"]
        # Exactly one of these keys is present.
        if "bootloader" in man:
            e = man["bootloader"]; self.img_type = T_BOOTLOADER; kind = "bootloader"
        elif "softdevice_bootloader" in man:
            e = man["softdevice_bootloader"]; self.img_type = T_SOFTDEVICE | T_BOOTLOADER
            kind = "softdevice+bootloader"
        elif "application" in man:
            e = man["application"]; self.img_type = T_APPLICATION; kind = "application"
        elif "softdevice" in man:
            e = man["softdevice"]; self.img_type = T_SOFTDEVICE; kind = "softdevice"
        else:
            raise DfuError(f"{path.name}: unknown manifest keys {list(man)}")
        self.kind = kind
        self.bin = z.read(e["bin_file"])
        self.dat = z.read(e["dat_file"])
        # Size triplet (softdevice, bootloader, application) for the START packet.
        sd = e.get("sd_size", 0)
        bl = e.get("bl_size", 0)
        if self.img_type == T_BOOTLOADER:
            sd, bl, app = 0, len(self.bin), 0
        elif self.img_type == T_APPLICATION:
            sd, bl, app = 0, 0, len(self.bin)
        elif self.img_type == (T_SOFTDEVICE | T_BOOTLOADER):
            app = 0
            if sd + bl != len(self.bin):
                raise DfuError(f"{path.name}: sd({sd})+bl({bl}) != bin({len(self.bin)})")
        else:  # softdevice only
            sd, bl, app = len(self.bin), 0, 0
        self.sizes = (sd, bl, app)

    def size_packet(self) -> bytes:
        import struct
        return struct.pack("<III", *self.sizes)

    def describe(self) -> str:
        n_chunks = (len(self.bin) + CHUNK - 1) // CHUNK
        return (
            f"{self.path.name}: {self.kind}  type=0x{self.img_type:02x}  "
            f"sizes(sd,bl,app)={self.sizes}  bin={len(self.bin)}B ({n_chunks} chunks)  "
            f"init={len(self.dat)}B [{self.dat.hex()}]"
        )


# --------------------------------------------------------------------------- #
# Dry run
# --------------------------------------------------------------------------- #
def dry_run(packages: list[Package]) -> None:
    print("DRY RUN — nothing is sent to the device.\n")
    for pkg in packages:
        print("=" * 70)
        print(pkg.describe())
        print(f"  1) notify-enable control point {DFU_CONTROL}")
        print(f"  2) ctrl <- START_DFU,type : {bytes([START_DFU, pkg.img_type]).hex(' ')}")
        print(f"  3) pkt  <- size triplet    : {pkg.size_packet().hex(' ')}")
        print(f"     await RESPONSE 10 01 01")
        print(f"  4) ctrl <- INIT_DFU,rx     : {bytes([INIT_DFU, 0x00]).hex(' ')}")
        print(f"     pkt  <- init packet      : {pkg.dat.hex(' ')}")
        print(f"     ctrl <- INIT_DFU,done    : {bytes([INIT_DFU, 0x01]).hex(' ')}")
        print(f"     await RESPONSE 10 02 01")
        print(f"  5) ctrl <- PRN_REQ,{PRN_INTERVAL}       : {bytes([PRN_REQ, PRN_INTERVAL, 0]).hex(' ')}")
        print(f"  6) ctrl <- RECEIVE_FW      : {bytes([RECEIVE_FW]).hex(' ')}")
        print(f"     pkt  <- {len(pkg.bin)} bytes in {CHUNK}-byte chunks (PRN every {PRN_INTERVAL})")
        print(f"     await RESPONSE 10 03 01")
        print(f"  7) ctrl <- VALIDATE        : {bytes([VALIDATE]).hex(' ')}")
        print(f"     await RESPONSE 10 04 01")
        print(f"  8) ctrl <- ACTIVATE_RESET  : {bytes([ACTIVATE_RESET]).hex(' ')}  (device reboots)")
    print("=" * 70)
    print(f"\n{len(packages)} package(s) would be flashed, in the order shown.")


# --------------------------------------------------------------------------- #
# Real flash
# --------------------------------------------------------------------------- #
async def _find_dfu(BleakScanner, timeout=15.0):
    print(f"  scanning up to {timeout:.0f}s for '{DFU_NAME}' ...")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for dev, adv in found.values():
        name = adv.local_name or dev.name or ""
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        if name == DFU_NAME or any(u.startswith("00001530") for u in uuids):
            print(f"  found {dev.address} (name={name!r}, rssi={adv.rssi})")
            return dev
    return None


async def _flash_one(BleakClient, dev, pkg: Package) -> None:
    import struct
    print(f"\n--- flashing {pkg.path.name} ({pkg.kind}) ---")
    async with BleakClient(dev, timeout=25.0) as client:
        q: asyncio.Queue = asyncio.Queue()

        def on_notify(_c, data: bytearray):
            q.put_nowait(bytes(data))

        await client.start_notify(DFU_CONTROL, on_notify)

        async def await_response(req_op: int, timeout=30.0):
            end = time.time() + timeout
            while time.time() < end:
                data = await asyncio.wait_for(q.get(), timeout=end - time.time())
                if data and data[0] == RESPONSE and data[1] == req_op:
                    if data[2] == 0x01:
                        return
                    raise DfuError(f"DFU op 0x{req_op:02x} failed, resp=0x{data[2]:02x}")
                # ignore stray PRN here
            raise DfuError(f"timeout awaiting response to op 0x{req_op:02x}")

        async def await_prn(timeout=30.0):
            end = time.time() + timeout
            while time.time() < end:
                data = await asyncio.wait_for(q.get(), timeout=end - time.time())
                if data and data[0] == PRN:
                    return struct.unpack("<I", data[1:5])[0]
                if data and data[0] == RESPONSE:  # early final response
                    return None
            raise DfuError("timeout awaiting packet-receipt notification")

        # 2+3) START_DFU + size triplet
        await client.write_gatt_char(DFU_CONTROL, bytes([START_DFU, pkg.img_type]), response=True)
        await client.write_gatt_char(DFU_PACKET, pkg.size_packet(), response=False)
        await await_response(START_DFU)
        print("    start accepted")

        # 4) init packet
        await client.write_gatt_char(DFU_CONTROL, bytes([INIT_DFU, 0x00]), response=True)
        await client.write_gatt_char(DFU_PACKET, pkg.dat, response=False)
        await client.write_gatt_char(DFU_CONTROL, bytes([INIT_DFU, 0x01]), response=True)
        await await_response(INIT_DFU)
        print("    init packet accepted")

        # 5) packet-receipt interval
        await client.write_gatt_char(DFU_CONTROL, bytes([PRN_REQ, PRN_INTERVAL, 0x00]), response=True)

        # 6) receive firmware image
        await client.write_gatt_char(DFU_CONTROL, bytes([RECEIVE_FW]), response=True)
        sent = 0
        since_prn = 0
        total = len(pkg.bin)
        for off in range(0, total, CHUNK):
            chunk = pkg.bin[off:off + CHUNK]
            await client.write_gatt_char(DFU_PACKET, chunk, response=False)
            sent += len(chunk)
            since_prn += 1
            if since_prn >= PRN_INTERVAL:
                since_prn = 0
                acked = await await_prn()
                if acked is not None and acked != sent:
                    raise DfuError(f"PRN mismatch: device acked {acked}, sent {sent}")
                pct = 100 * sent // total
                print(f"\r    sending firmware: {sent}/{total} ({pct}%)", end="", flush=True)
        print(f"\r    sending firmware: {sent}/{total} (100%)      ")
        await await_response(RECEIVE_FW, timeout=60.0)
        print("    firmware image received")

        # 7) validate
        await client.write_gatt_char(DFU_CONTROL, bytes([VALIDATE]), response=True)
        await await_response(VALIDATE)
        print("    firmware validated")

        # 8) activate + reset (device reboots; no response expected)
        try:
            await client.write_gatt_char(DFU_CONTROL, bytes([ACTIVATE_RESET]), response=True)
        except Exception:
            pass  # device often resets before the write is acked
        print("    activate+reset sent; device rebooting")


async def real_flash(packages: list[Package]) -> None:
    from bleak import BleakClient, BleakScanner
    for i, pkg in enumerate(packages):
        dev = await _find_dfu(BleakScanner)
        if dev is None:
            raise DfuError(f"'{DFU_NAME}' not found before {pkg.path.name}. "
                           "Is the goTenna on and blinking white?")
        await _flash_one(BleakClient, dev, pkg)
        if i < len(packages) - 1:
            print("  waiting 8s for the device to reset back into DFU ...")
            await asyncio.sleep(8.0)
    print("\nAll packages flashed. Run `python probe.py scan` — success = no longer 'DfuTarg'.")


# --------------------------------------------------------------------------- #
def resolve_packages(args) -> list[Package]:
    if args.all:
        paths = [PROJECT / "firmware" / n for n in PHASE_ORDER]
    else:
        paths = [Path(p) for p in args.packages]
    missing = [p for p in paths if not p.exists()]
    if missing:
        print("Missing package(s):", ", ".join(str(m) for m in missing))
        sys.exit(2)
    return [Package(p) for p in paths]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("packages", nargs="*", help="DFU .zip package paths (or use --all)")
    ap.add_argument("--all", action="store_true", help="flash the 3 firmware/ phases in order")
    ap.add_argument("--dry-run", action="store_true", help="parse + print the plan, no BLE (default if --flash absent)")
    ap.add_argument("--flash", action="store_true", help="actually flash over BLE")
    ap.add_argument("--i-understand-risk", action="store_true", help="required with --flash")
    args = ap.parse_args()

    if not args.all and not args.packages:
        ap.error("give package path(s) or --all")
    packages = resolve_packages(args)

    if not args.flash:
        dry_run(packages)
        print("\n(Add --flash --i-understand-risk to actually flash.)")
        return
    if not args.i_understand_risk:
        print("REFUSED: --flash requires --i-understand-risk.")
        sys.exit(2)
    print("Flashing order:", " -> ".join(p.path.name for p in packages), "\n")
    asyncio.run(real_flash(packages))


if __name__ == "__main__":
    main()
