#!/usr/bin/env python3
"""goTenna Mesh BLE discovery prober.

A clean-room interoperability tool: it connects to a goTenna Mesh device you
own over Bluetooth LE and reports what the device's own firmware exposes
(GATT services, characteristics, descriptors) and what it sends. It never
touches goTenna's SDK and never modifies the device.

Subcommands:
  scan        Discover nearby BLE devices and flag likely goTenna units.
  enumerate   Connect and dump the full GATT table, reading readable values.
  monitor     Connect, subscribe to every notify/indicate characteristic,
              and log inbound frames with timestamps until Ctrl+C.
  send        Write raw hex bytes to one characteristic (command probing).

Everything is also written to a timestamped file under logs/.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as _dt
import logging
import sys
from pathlib import Path

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic

import gt_protocol as gt

# goTenna command GATT characteristics (pyGT gtdefs)
GT_TX = "1276b20a-df5e-11e6-bf01-fe55135034f3"  # app writes command frames here
GT_RX = "1276b20b-df5e-11e6-bf01-fe55135034f3"  # device replies via notifications

LOG_DIR = Path(__file__).resolve().parent / "logs"

# Names/markers the goTenna Mesh is known or likely to advertise under.
GOTENNA_NAME_HINTS = ("gotenna", "gtm", "gt mesh")
# Nordic UART Service — a very common transport on nRF52-based devices like the
# goTenna Mesh. Presence of this is a strong hint for where the data flows.
NORDIC_UART_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"


# --------------------------------------------------------------------------- #
# Logging / formatting helpers
# --------------------------------------------------------------------------- #
def _setup_logging(tag: str) -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    logfile = LOG_DIR / f"{tag}-{stamp}.log"

    logger = logging.getLogger("gotenna")
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()

    fmt = logging.Formatter("%(asctime)s %(message)s", datefmt="%H:%M:%S.%f"[:-3])

    fh = logging.FileHandler(logfile, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(ch)

    logger.info("log file: %s", logfile)
    return logger


def hexdump(data: bytes, indent: str = "    ") -> str:
    """Classic offset / hex / ASCII hexdump."""
    if not data:
        return indent + "(empty)"
    lines = []
    for off in range(0, len(data), 16):
        chunk = data[off : off + 16]
        hex_part = " ".join(f"{b:02x}" for b in chunk)
        hex_part = f"{hex_part:<47}"
        ascii_part = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        lines.append(f"{indent}{off:04x}  {hex_part}  {ascii_part}")
    return "\n".join(lines)


def _looks_like_gotenna(name: str | None, service_uuids: list[str]) -> bool:
    name_l = (name or "").lower()
    if any(h in name_l for h in GOTENNA_NAME_HINTS):
        return True
    return any(u.lower() == NORDIC_UART_SERVICE for u in service_uuids)


# --------------------------------------------------------------------------- #
# scan
# --------------------------------------------------------------------------- #
async def cmd_scan(args: argparse.Namespace, log: logging.Logger) -> None:
    log.info("Scanning for %.0f s ...", args.timeout)
    discovered = await BleakScanner.discover(timeout=args.timeout, return_adv=True)

    if not discovered:
        log.info("No BLE devices found. Is the goTenna powered on and in range?")
        return

    # Sort by RSSI (strongest first) so the device on your desk floats up.
    items = sorted(
        discovered.values(),
        key=lambda da: da[1].rssi if da[1].rssi is not None else -999,
        reverse=True,
    )

    log.info("Found %d device(s):\n", len(items))
    for device, adv in items:
        svc_uuids = list(adv.service_uuids or [])
        flag = "  <== LIKELY goTenna" if _looks_like_gotenna(adv.local_name or device.name, svc_uuids) else ""
        log.info("  %s  rssi=%4s  name=%r%s", device.address, adv.rssi, adv.local_name or device.name, flag)
        if svc_uuids:
            log.info("      service uuids: %s", ", ".join(svc_uuids))
        if adv.manufacturer_data:
            for cid, mdata in adv.manufacturer_data.items():
                log.info("      mfg 0x%04x: %s", cid, mdata.hex())
    log.info("\nTip: run  python probe.py enumerate <ADDRESS>  on the flagged device.")


# --------------------------------------------------------------------------- #
# enumerate
# --------------------------------------------------------------------------- #
def _props(char: BleakGATTCharacteristic) -> str:
    return ",".join(char.properties)


async def cmd_enumerate(args: argparse.Namespace, log: logging.Logger) -> None:
    log.info("Connecting to %s ...", args.address)
    async with BleakClient(args.address, timeout=args.timeout) as client:
        log.info("Connected: %s\n", client.is_connected)
        for service in client.services:
            log.info("[service] %s  (%s)", service.uuid, service.description)
            for char in service.characteristics:
                log.info("  [char] %s  props=[%s]  (%s)", char.uuid, _props(char), char.description)
                if "read" in char.properties:
                    try:
                        value = await client.read_gatt_char(char.uuid)
                        log.info("    value (%d bytes):", len(value))
                        log.info("%s", hexdump(value, indent="      "))
                    except Exception as exc:  # noqa: BLE001 - report, keep going
                        log.info("    read failed: %s", exc)
                for desc in char.descriptors:
                    log.info("    [desc] %s  handle=%s", desc.uuid, desc.handle)
        log.info("\nEnumeration complete. Next: python probe.py monitor %s", args.address)


# --------------------------------------------------------------------------- #
# monitor
# --------------------------------------------------------------------------- #
async def cmd_monitor(args: argparse.Namespace, log: logging.Logger) -> None:
    log.info("Connecting to %s ...", args.address)
    async with BleakClient(args.address, timeout=args.timeout) as client:
        log.info("Connected: %s", client.is_connected)

        def make_cb(uuid: str):
            def _cb(_char: BleakGATTCharacteristic, data: bytearray) -> None:
                log.info("<- notify %s (%d bytes):", uuid, len(data))
                log.info("%s", hexdump(bytes(data)))
            return _cb

        subscribed = 0
        for service in client.services:
            for char in service.characteristics:
                if "notify" in char.properties or "indicate" in char.properties:
                    try:
                        await client.start_notify(char.uuid, make_cb(char.uuid))
                        log.info("subscribed to %s [%s]", char.uuid, _props(char))
                        subscribed += 1
                    except Exception as exc:  # noqa: BLE001
                        log.info("could not subscribe %s: %s", char.uuid, exc)

        if subscribed == 0:
            log.info("No notify/indicate characteristics found to subscribe to.")
            return

        log.info("\nListening on %d characteristic(s). Interact with the device; Ctrl+C to stop.\n", subscribed)
        try:
            while client.is_connected:
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass
        log.info("Disconnected / stopped.")


# --------------------------------------------------------------------------- #
# send
# --------------------------------------------------------------------------- #
async def cmd_send(args: argparse.Namespace, log: logging.Logger) -> None:
    payload = bytes.fromhex(args.hex.replace(" ", ""))
    log.info("Connecting to %s ...", args.address)
    async with BleakClient(args.address, timeout=args.timeout) as client:
        log.info("Connected: %s", client.is_connected)
        log.info("-> write %s (%d bytes, response=%s):", args.char, len(payload), args.response)
        log.info("%s", hexdump(payload))
        await client.write_gatt_char(args.char, payload, response=args.response)
        log.info("write complete")
        if args.listen > 0:
            log.info("listening %.0f s for a reply ...", args.listen)

            def _cb(_c: BleakGATTCharacteristic, data: bytearray) -> None:
                log.info("<- %s", hexdump(bytes(data)))

            for service in client.services:
                for char in service.characteristics:
                    if "notify" in char.properties or "indicate" in char.properties:
                        try:
                            await client.start_notify(char.uuid, _cb)
                        except Exception:  # noqa: BLE001
                            pass
            await asyncio.sleep(args.listen)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #
async def cmd_op(args: argparse.Namespace, log: logging.Logger) -> None:
    name = args.opcode.lower()
    if name not in gt.OP_BY_NAME:
        log.info("Unknown opcode '%s'. Known: %s", name, ", ".join(sorted(gt.OP_BY_NAME)))
        return
    opcode = gt.OP_BY_NAME[name]
    data = bytes.fromhex(args.data.replace(" ", "")) if args.data else b""
    if opcode not in gt.SAFE_READ_OPS and opcode != gt.OP_FLASH and not args.i_understand_risk:
        log.info("REFUSED: %s is not a safe read; needs --i-understand-risk", gt.OP_NAMES.get(opcode))
        return

    frame = gt.build_frame(opcode, args.seq, data)
    assembler = gt.FrameAssembler()
    replies: list[bytes] = []

    log.info("Connecting to %s ...", args.address)
    async with BleakClient(args.address, timeout=args.timeout) as client:
        log.info("Connected: %s", client.is_connected)

        def on_rx(_c: BleakGATTCharacteristic, d: bytearray) -> None:
            log.info("<- RX notify (%d bytes): %s", len(d), bytes(d).hex(" "))
            for payload in assembler.feed(bytes(d)):
                replies.append(payload)

        await client.start_notify(GT_RX, on_rx)
        log.info("subscribed to RX %s", GT_RX)

        log.info("-> %s seq=0x%02x frame (%d bytes): %s",
                 gt.OP_NAMES.get(opcode, hex(opcode)), args.seq, len(frame), frame.hex(" "))
        for off in range(0, len(frame), 20):
            await client.write_gatt_char(GT_TX, frame[off:off + 20], response=False)

        end = asyncio.get_event_loop().time() + args.listen
        while asyncio.get_event_loop().time() < end and not replies:
            await asyncio.sleep(0.1)

        if not replies:
            log.info("<- no framed reply within %.0fs", args.listen)
            return
        payload = replies[0]
        rep = gt.ParsedReply(opcode, payload)
        log.info("<- payload (%d bytes): %s", len(payload), payload.hex(" "))
        log.info("   result_code=0x%02x (%s)  seq=0x%02x  crc_ok=%s",
                 rep.result_code, "SUCCESS" if rep.success else "non-success", rep.seq, rep.crc_ok)
        log.info("   data (%d bytes):", len(rep.data))
        log.info("%s", hexdump(rep.data, indent="     "))
        printable = "".join(chr(b) if 32 <= b < 127 else "." for b in rep.data)
        log.info("   data as text: %s", printable)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("scan", help="discover nearby BLE devices")
    s.add_argument("--timeout", type=float, default=10.0, help="scan seconds (default 10)")
    s.set_defaults(func=cmd_scan)

    e = sub.add_parser("enumerate", help="dump the full GATT table of a device")
    e.add_argument("address", help="BLE address (from scan)")
    e.add_argument("--timeout", type=float, default=20.0, help="connect timeout seconds")
    e.set_defaults(func=cmd_enumerate)

    m = sub.add_parser("monitor", help="subscribe to notifications and log frames")
    m.add_argument("address", help="BLE address (from scan)")
    m.add_argument("--timeout", type=float, default=20.0, help="connect timeout seconds")
    m.set_defaults(func=cmd_monitor)

    w = sub.add_parser("send", help="write raw hex bytes to a characteristic")
    w.add_argument("address", help="BLE address (from scan)")
    w.add_argument("char", help="characteristic UUID to write")
    w.add_argument("hex", help='bytes as hex, e.g. "01 02 ff" or "0102ff"')
    w.add_argument("--response", action="store_true", help="use write-with-response")
    w.add_argument("--listen", type=float, default=3.0, help="seconds to listen for a reply after writing")
    w.add_argument("--timeout", type=float, default=20.0, help="connect timeout seconds")
    w.set_defaults(func=cmd_send)

    o = sub.add_parser("op", help="send a goTenna command frame over BLE and parse the reply")
    o.add_argument("address", help="BLE address (from scan)")
    o.add_argument("opcode", help=f"opcode name: {', '.join(sorted(gt.OP_BY_NAME))}")
    o.add_argument("--data", default="", help="hex payload for the opcode")
    o.add_argument("--seq", type=lambda x: int(x, 0), default=0x01)
    o.add_argument("--listen", type=float, default=5.0, help="seconds to await the reply")
    o.add_argument("--timeout", type=float, default=20.0, help="connect timeout")
    o.add_argument("--i-understand-risk", action="store_true")
    o.set_defaults(func=cmd_op)

    return p


def main() -> None:
    args = build_parser().parse_args()
    log = _setup_logging(args.command)
    try:
        asyncio.run(args.func(args, log))
    except KeyboardInterrupt:
        log.info("\nInterrupted.")


if __name__ == "__main__":
    main()
