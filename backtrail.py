#!/usr/bin/env python3
"""Backtrail multi-network CLI: goTenna Mesh + Meshtastic, one inbox, and a
bridge that relays broadcasts between the two networks.

  nets                                   find goTenna and Meshtastic radios
  mesh-info  --mesh COM5                 Meshtastic radio info
  mesh-send  "text" --mesh COM5 [--to !a1b2c3d4] [--channel 0]
  monitor    [--gotenna ADDR] [--mesh COM5] [--key PASS]   unified inbox
  bridge     --gotenna ADDR --mesh COM5 [--key PASS]       relay broadcasts both ways

--mesh accepts a serial port (COM5, /dev/ttyUSB0) or a Bluetooth address.
Backtrail is GPL-3.0; see LICENSE.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys

import gt_message as gm
import gt_protocol as gt
from gotenna import GoTenna, find_device, load_config, channel_key
from mesh_meshtastic import MeshtasticRadio, parse_node_id

RELAY_TAG = re.compile(r"^\[(gT|MT) ")


# --------------------------------------------------------------------------- #
# Bridge rules (pure logic, unit-testable with fake senders)
# --------------------------------------------------------------------------- #
class Bridge:
    """Relays BROADCAST text between networks. Direct messages are never
    relayed. Relayed text is tagged "[gT name] " / "[MT name] "; tagged text is
    never relayed again, so two bridges can't ping-pong a message."""

    def __init__(self, send_to_meshtastic, send_to_gotenna, log=print):
        self.to_mt = send_to_meshtastic   # async (text) -> None
        self.to_gt = send_to_gotenna      # async (text) -> None
        self.log = log
        self.queue: asyncio.Queue = asyncio.Queue()
        self.relayed = 0

    @staticmethod
    def should_relay(text: str | None, direct: bool) -> bool:
        return bool(text) and not direct and not RELAY_TAG.match(text)

    def from_gotenna(self, name: str, text: str | None, direct: bool) -> bool:
        if not self.should_relay(text, direct):
            return False
        self.queue.put_nowait(("Meshtastic", self.to_mt, f"[gT {name}] {text}"))
        return True

    def from_meshtastic(self, name: str, text: str | None, direct: bool) -> bool:
        if not self.should_relay(text, direct):
            return False
        self.queue.put_nowait(("goTenna", self.to_gt, f"[MT {name}] {text}"))
        return True

    async def run(self):
        """Send queued relays one at a time (goTenna sends take seconds)."""
        while True:
            label, send, text = await self.queue.get()
            try:
                await send(text)
                self.relayed += 1
                self.log(f"  ↪ relayed to {label}: {text[:70]}")
            except Exception as e:  # keep bridging even if one relay fails
                self.log(f"  ✗ relay to {label} failed: {e}")


# --------------------------------------------------------------------------- #
# Commands
# --------------------------------------------------------------------------- #
async def cmd_nets(_args):
    from bleak import BleakScanner
    from serial.tools import list_ports
    print("Serial (USB) radios:")
    usb = {0x10C4: "CP210x", 0x1A86: "CH340/CH9102", 0x303A: "ESP32-S3 native", 0x239A: "nRF52 (Adafruit/RAK)",
           0x1FC9: "goTenna (NXP)"}
    any_serial = False
    for p in list_ports.comports():
        if p.vid in usb:
            any_serial = True
            kind = "goTenna" if p.vid == 0x1FC9 else "likely Meshtastic"
            print(f"  {p.device}  {usb[p.vid]}  ({kind})")
    if not any_serial:
        print("  none (a Meshtastic board with a CP210x/CH340 chip needs its USB driver installed)")
    print("Bluetooth radios:")
    found = await BleakScanner.discover(timeout=10, return_adv=True)
    for dev, adv in found.values():
        uu = [u.lower() for u in (adv.service_uuids or [])]
        if any(u.startswith("1276") for u in uu):
            print(f"  {dev.address}  goTenna  rssi={adv.rssi}")
        elif "6ba1b218-15a8-461f-9fa8-5dcae273eafd" in uu:
            print(f"  {dev.address}  Meshtastic {adv.local_name or ''}  rssi={adv.rssi}")


async def cmd_mesh_info(args):
    r = MeshtasticRadio(args.mesh)
    info = await r.open()
    try:
        for k, v in info.items():
            print(f"  {k:12}: {v}")
    finally:
        await r.close()


async def cmd_mesh_send(args):
    r = MeshtasticRadio(args.mesh)
    await r.open()
    try:
        to = parse_node_id(args.to) if args.to else None
        if args.to and to is None:
            print("invalid node ID (use !a1b2c3d4)")
            return
        ok, parts, delivered = await r.send(args.text, to=to, channel=args.channel)
        status = {True: "DELIVERED ✓", False: "sent, NOT confirmed", None: "sent (broadcast)"}[delivered]
        print(f"{status} in {parts} part(s): {args.text!r}")
    finally:
        await r.close()


async def _gotenna_loop(gdev: GoTenna, reasm, handle_text, stop: asyncio.Event, poll: float = 3.0):
    """Drain the goTenna inbox, decode, and hand finished messages to handle_text."""
    while not stop.is_set():
        code, data = await gdev.read_message()
        if code == gt.GT_OP_SUCCESS and data:
            parsed = gm.parse_message(data)
            await gdev.next_message()
            if gm.is_receipt(parsed):
                continue
            msg = reasm.add(parsed)
            if msg:
                handle_text(msg)
        else:
            await asyncio.sleep(poll)


def _gotenna_line(msg: dict) -> tuple[str, str | None, bool]:
    gid = "0x%012x" % msg.get("from_gid", 0)
    name = msg.get("nick") or gid
    direct = msg.get("class_name") == "P2P"
    if msg.get("locked"):
        return name, None, direct
    return name, msg.get("text"), direct


async def cmd_monitor(args, bridge_mode: bool = False):
    if not args.gotenna and not args.mesh:
        print("give --gotenna ADDR and/or --mesh PORT")
        return
    cfg = load_config()
    key = channel_key(args, cfg)
    reasm = gm.Reassembler([key] if key else [])
    stop = asyncio.Event()
    gdev = mesh = None
    tasks = []
    try:
        if args.gotenna:
            gdev = GoTenna(args.gotenna)
            await gdev.connect()
            await gdev.set_identity(cfg["gid"])
            print(f"goTenna connected ({args.gotenna}); your ID 0x{cfg['gid']:012x}")
        if args.mesh:
            mesh = MeshtasticRadio(args.mesh)
            i = await mesh.open()
            print(f"Meshtastic connected ({args.mesh}): {i.get('long_name')} {i.get('node_id')}, "
                  f"fw {i.get('firmware')}, region {i.get('region')}")

        bridge = None
        if bridge_mode:
            async def to_mt(text):
                await mesh.send(text)

            async def to_gt(text):
                ok, sent, total, _ = await gdev.send(text, cfg["gid"], nick=cfg.get("nick", ""), key=key)
                if not ok:
                    raise RuntimeError(f"goTenna rejected part {sent + 1} of {total}")
            bridge = Bridge(to_mt, to_gt)
            tasks.append(asyncio.create_task(bridge.run()))
            print("BRIDGE ACTIVE: relaying broadcasts goTenna ⇄ Meshtastic (direct messages are not relayed)")

        def on_gotenna(msg):
            name, text, direct = _gotenna_line(msg)
            lock = "🔒 " if msg.get("encrypted") else ""
            shown = text if text is not None else "<encrypted — wrong or missing passphrase>"
            print(f"[goTenna{' · direct' if direct else ''}] {lock}{name}: {shown}")
            if bridge:
                bridge.from_gotenna(name, text, direct)

        def on_mesh(msg):
            print(f"[Meshtastic{' · direct' if msg['direct'] else ' · ch ' + str(msg['channel'])}] "
                  f"{msg['from_name']}: {msg['text']}")
            if bridge:
                bridge.from_meshtastic(msg["from_name"], msg["text"], msg["direct"])

        if mesh:
            mesh.on_message = on_mesh
        if gdev:
            tasks.append(asyncio.create_task(_gotenna_loop(gdev, reasm, on_gotenna, stop)))
        print("listening — Ctrl+C to stop\n")
        await asyncio.sleep(args.duration if args.duration else 10 ** 9)
    finally:
        stop.set()
        for t in tasks:
            t.cancel()
        if mesh:
            await mesh.close()
        if gdev:
            await gdev.disconnect()


async def cmd_bridge(args):
    if not (args.gotenna and args.mesh):
        print("bridge needs both --gotenna ADDR and --mesh PORT")
        return
    await cmd_monitor(args, bridge_mode=True)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("nets").set_defaults(func=cmd_nets)
    mi = sub.add_parser("mesh-info"); mi.add_argument("--mesh", required=True); mi.set_defaults(func=cmd_mesh_info)
    ms = sub.add_parser("mesh-send"); ms.add_argument("text"); ms.add_argument("--mesh", required=True)
    ms.add_argument("--to"); ms.add_argument("--channel", type=int, default=0); ms.set_defaults(func=cmd_mesh_send)
    for name, fn in (("monitor", cmd_monitor), ("bridge", cmd_bridge)):
        sp = sub.add_parser(name)
        sp.add_argument("--gotenna", help="goTenna BLE address")
        sp.add_argument("--mesh", help="Meshtastic serial port or BLE address")
        sp.add_argument("--key", help="goTenna channel passphrase (overrides saved one)")
        sp.add_argument("--duration", type=float, default=0, help="seconds to run (0 = until Ctrl+C)")
        sp.set_defaults(func=fn)
    return p


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    args = build_parser().parse_args()
    try:
        asyncio.run(args.func(args))
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
