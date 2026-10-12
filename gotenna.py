#!/usr/bin/env python3
"""goTenna Mesh control application (BLE).

A clean, dependency-light driver + CLI that keeps goTenna Mesh devices usable
after goTenna discontinued the consumer app. Talks the device's native BLE
command protocol (see gt_protocol.py / gt_message.py).

Commands:
  scan                         find goTenna devices
  info      [--address A]      device info (model/fw/serial + sysinfo)
  region    [get|us|eu|au|nz|jp]  show or set the RF region/band
  locate                       blink the device light to find it
  identity  --nick NAME [--gid HEX]   set/store your local identity
  send      "text" [--to GIDHEX] [--nick N]   shout (or P2P with --to)
  monitor                      watch for incoming messages (prints them)

Identity (your GID + nickname) is stored in gotenna_config.json next to this
file. Everything is local; there are no servers.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
from pathlib import Path

from bleak import BleakClient, BleakScanner

import gt_protocol as gt
import gt_message as gm

CMD_SERVICE = "1276aaee-df5e-11e6-bf01-fe55135034f3"
ST_UUID = "12762b18-df5e-11e6-bf01-fe55135034f3"   # status / message-waiting
TX_UUID = "1276b20a-df5e-11e6-bf01-fe55135034f3"   # command write
RX_UUID = "1276b20b-df5e-11e6-bf01-fe55135034f3"   # command reply (notify)
# Standard Device Information Service
DIS = {
    "manufacturer": "00002a29-0000-1000-8000-00805f9b34fb",
    "model": "00002a24-0000-1000-8000-00805f9b34fb",
    "hw_rev": "00002a27-0000-1000-8000-00805f9b34fb",
    "fw_rev": "00002a26-0000-1000-8000-00805f9b34fb",
}
CONFIG = Path(__file__).resolve().parent / "gotenna_config.json"
REDUNDANT_PASSES = 2   # transmissions per part for encrypted/multi-part shouts
ACK_WAIT_S = 20.0      # P2P: how long to wait for delivery receipts per round
P2P_RETRIES = 2        # P2P: resend rounds for parts with no receipt
PART_GAP_S = 2.5       # seconds between radio messages


# --------------------------------------------------------------------------- #
# Local identity config
# --------------------------------------------------------------------------- #
def load_config() -> dict:
    if CONFIG.exists():
        try:
            return json.loads(CONFIG.read_text())
        except Exception:
            pass
    cfg = {"gid": random.randint(1, 0xFFFFFFFFFFFF), "nick": ""}
    save_config(cfg)
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG.write_text(json.dumps(cfg, indent=2))


# --------------------------------------------------------------------------- #
# Device driver
# --------------------------------------------------------------------------- #
class GoTenna:
    def __init__(self, address: str):
        self.address = address
        self.client: BleakClient | None = None
        self.seq = 0
        self._asm = gt.FrameAssembler()
        self._waiters: dict[int, asyncio.Future] = {}
        self.mwi: int | None = None
        self.on_mwi_change = None  # optional callback(new_mwi)

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *exc):
        await self.disconnect()

    async def connect(self, timeout: float = 20.0) -> None:
        self.client = BleakClient(self.address, timeout=timeout)
        await self.client.connect()

        def on_rx(_c, data: bytearray):
            for payload in self._asm.feed(bytes(data)):
                if len(payload) >= 2:
                    seq = payload[1]
                    fut = self._waiters.pop(seq, None)
                    if fut and not fut.done():
                        fut.set_result(payload)

        def on_st(_c, data: bytearray):
            if data:
                new = data[0]
                if self.mwi is not None and new != self.mwi and self.on_mwi_change:
                    self.on_mwi_change(new)
                self.mwi = new

        await self.client.start_notify(RX_UUID, on_rx)
        try:
            await self.client.start_notify(ST_UUID, on_st)
            # Seed the message-waiting value so the first change is detected.
            seed = await self.client.read_gatt_char(ST_UUID)
            if seed and self.mwi is None:
                self.mwi = seed[0]
        except Exception:
            pass  # status notify is optional; monitor also polls

    async def disconnect(self) -> None:
        if self.client and self.client.is_connected:
            await self.client.disconnect()

    def _next_seq(self) -> int:
        self.seq = (self.seq + 1) & 0xFF
        if self.seq == 0x10:
            self.seq = 0x11
        if self.seq == 0x00:
            self.seq = 0x01
        return self.seq

    async def execute(self, opcode: int, data: bytes = b"", timeout: float = 6.0):
        """Send a command; return (result_code, data) or raise TimeoutError."""
        seq = self._next_seq()
        frame = gt.build_frame(opcode, seq, data)
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._waiters[seq] = fut
        for off in range(0, len(frame), 20):
            await self.client.write_gatt_char(TX_UUID, frame[off:off + 20], response=False)
        payload = await asyncio.wait_for(fut, timeout=timeout)
        rep = gt.ParsedReply(opcode, payload)
        return rep.result_code, rep.data

    # High-level helpers -----------------------------------------------------
    async def sysinfo(self):
        return await self.execute(gt.OP_SYSINFO)

    async def get_region(self):
        code, data = await self.execute(gt.OP_GET_GEO)
        return gt.region_from_reply(data)

    async def set_region(self, region_id: int):
        return await self.execute(gt.OP_SET_GEO, gt.region_set_data(region_id))

    async def locate(self):
        return await self.execute(gt.OP_FLASH)

    async def set_identity(self, gid: int, app_id: int = gm.DEFAULT_APP_ID) -> bool:
        """Program the radio's address (class, app ID, GID, tag) so it receives
        direct messages sent to `gid`. OP_SET_GID payload is 10 bytes."""
        data = bytes([0x00]) + app_id.to_bytes(2, "big") + (gid & 0xFFFFFFFFFFFF).to_bytes(6, "big") + b"\x00"
        code, _ = await self.execute(gt.OP_SET_GID, data)
        return code == gt.GT_OP_SUCCESS

    async def send(self, text: str, from_gid: int, nick: str = "", to_gid: int | None = None,
                   key: bytes | None = None, on_progress=None, on_incoming=None):
        """Send text (encrypted if key, split if long).

        Returns (ok, sent, total, delivered): delivered is None for shouts (no
        receipts exist) and True/False for direct messages."""
        msg_id, blobs = gm.build_parts(text, from_gid, nick=nick, key=key)
        kw = {"msg_class": gm.MSG_CLASS_P2P, "dest_gid": to_gid} if to_gid else {"msg_class": gm.MSG_CLASS_SHOUT}
        # seq0/seq1 = msg id / part index make every part's HEAD (and receipt id) unique
        pdus = [gm.build_message_blob(b, from_gid, seq0=msg_id, seq1=i, **kw) for i, b in enumerate(blobs)]
        if to_gid:
            return await self._send_with_receipts(pdus, on_progress, on_incoming)
        # Over-the-air loss measured ~1 in 5 (FINDINGS.md). Multi-part messages
        # need every part, so they go out in REDUNDANT_PASSES passes; the
        # receiver's Reassembler drops repeats. Single messages go once.
        # Encrypted/multi-part messages carry a msg_id, so repeats are safe to send;
        # legacy plain singles have no id (a repeat would show twice), so they go once.
        passes = REDUNDANT_PASSES if (len(blobs) > 1 or key is not None) else 1
        sends = [(p, i, pdu) for p in range(passes) for i, pdu in enumerate(pdus)]
        for n, (p, i, pdu) in enumerate(sends):
            code, _ = await self.execute(gt.OP_SENDMSG, pdu, timeout=8.0)
            if code != gt.GT_OP_SUCCESS:
                return False, i, len(pdus), None
            if on_progress and p == 0:
                on_progress(i + 1, len(pdus))
            if n < len(sends) - 1:
                await asyncio.sleep(PART_GAP_S)  # let the radio finish transmitting
        return True, len(pdus), len(pdus), None

    async def _send_with_receipts(self, pdus, on_progress=None, on_incoming=None):
        """P2P: send each part, then resend only parts with no delivery receipt."""
        want = {gm.message_hash(p): i for i, p in enumerate(pdus)}
        todo = list(range(len(pdus)))
        for attempt in range(1 + P2P_RETRIES):
            for n, i in enumerate(todo):
                code, _ = await self.execute(gt.OP_SENDMSG, pdus[i], timeout=8.0)
                if code != gt.GT_OP_SUCCESS:
                    return False, i, len(pdus), False
                if on_progress and attempt == 0:
                    on_progress(i + 1, len(pdus))
                if n < len(todo) - 1:
                    await asyncio.sleep(PART_GAP_S)
            deadline = asyncio.get_event_loop().time() + ACK_WAIT_S
            while want and asyncio.get_event_loop().time() < deadline:
                code, data = await self.read_message()
                if code == gt.GT_OP_SUCCESS and data:
                    msg = gm.parse_message(data)
                    await self.next_message()
                    if gm.is_receipt(msg):
                        want.pop(msg["ack_msg_id"], None)
                    elif on_incoming:
                        on_incoming(msg)       # don't lose traffic that arrives meanwhile
                else:
                    await asyncio.sleep(1.0)
            if not want:
                return True, len(pdus), len(pdus), True
            todo = sorted(want.values())
        return True, len(pdus), len(pdus), False

    async def read_message(self):
        code, data = await self.execute(gt.OP_READMSG)
        return code, data

    async def next_message(self):
        return await self.execute(gt.OP_NEXTMSG)


# --------------------------------------------------------------------------- #
# Discovery
# --------------------------------------------------------------------------- #
async def find_device(timeout: float = 12.0) -> str | None:
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    best = None
    for dev, adv in found.values():
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        name = (adv.local_name or dev.name or "")
        if any(u.startswith("1276") for u in uuids) or "tenna" in name.lower():
            rssi = adv.rssi if adv.rssi is not None else -999
            if best is None or rssi > best[1]:
                best = (dev.address, rssi)
    return best[0] if best else None


async def resolve_address(args) -> str | None:
    if getattr(args, "address", None):
        return args.address
    print("scanning for a goTenna ...")
    addr = await find_device()
    if addr:
        print(f"found goTenna at {addr}")
    else:
        print("no goTenna found (powered on and in range?)")
    return addr


def decode_sysinfo(data: bytes) -> dict:
    """Best-effort sysinfo decode. The serial is an ASCII run; the rest is
    reported raw until fully mapped."""
    out = {"raw": data.hex(" ")}
    # Longest printable-ASCII run = serial number (e.g. MX########)
    run, best = b"", b""
    for b in data + b"\x00":
        if 0x20 <= b < 0x7F:
            run += bytes([b])
        else:
            if len(run) > len(best):
                best = run
            run = b""
    if len(best) >= 4:
        out["serial"] = best.decode()
    return out


# --------------------------------------------------------------------------- #
# CLI commands
# --------------------------------------------------------------------------- #
async def cmd_scan(args):
    found = await BleakScanner.discover(timeout=args.timeout, return_adv=True)
    hits = []
    for dev, adv in found.values():
        uuids = [u.lower() for u in (adv.service_uuids or [])]
        name = adv.local_name or dev.name or ""
        if any(u.startswith("1276") for u in uuids) or "tenna" in name.lower() or name == "DfuTarg":
            hits.append((dev.address, adv.rssi, name, uuids))
    if not hits:
        print("No goTenna devices found.")
        return
    for addr, rssi, name, uuids in sorted(hits, key=lambda x: -(x[1] or -999)):
        tag = " (DFU/needs recovery!)" if name == "DfuTarg" else ""
        print(f"  {addr}  rssi={rssi}  {name or '(goTenna)'}{tag}")


async def cmd_info(args):
    addr = await resolve_address(args)
    if not addr:
        return
    async with GoTenna(addr) as gt_dev:
        print(f"connected to {addr}\n")
        # Device Information Service (human-readable strings)
        for label, uuid in DIS.items():
            try:
                v = (await gt_dev.client.read_gatt_char(uuid)).decode(errors="replace")
                print(f"  {label:12}: {v}")
            except Exception:
                pass
        # Live sysinfo
        try:
            code, data = await gt_dev.sysinfo()
            si = decode_sysinfo(data)
            print(f"  {'serial':12}: {si.get('serial', '(see raw)')}")
            print(f"  {'sysinfo ok':12}: {code == gt.GT_OP_SUCCESS}")
            print(f"  {'sysinfo raw':12}: {si['raw']}")
        except Exception as e:
            print(f"  sysinfo failed: {e}")
        # Region
        try:
            r = await gt_dev.get_region()
            print(f"  {'region':12}: {r} - {gt.REGION_NAME.get(r, 'unknown')}")
        except Exception as e:
            print(f"  region read failed: {e}")


async def cmd_region(args):
    addr = await resolve_address(args)
    if not addr:
        return
    async with GoTenna(addr) as gt_dev:
        if args.value in (None, "get"):
            r = await gt_dev.get_region()
            print(f"region: {r} - {gt.REGION_NAME.get(r, 'unknown')}")
            return
        rid = gt.REGIONS.get(args.value.lower())
        if rid is None:
            print(f"unknown region '{args.value}'. choose: {', '.join(gt.REGIONS)}")
            return
        code, _ = await gt_dev.set_region(rid)
        ok = code == gt.GT_OP_SUCCESS
        print(f"set region -> {args.value.upper()} ({gt.REGION_NAME[rid]}): {'OK' if ok else 'FAILED code=0x%02x' % code}")


async def cmd_locate(args):
    addr = await resolve_address(args)
    if not addr:
        return
    async with GoTenna(addr) as gt_dev:
        code, _ = await gt_dev.locate()
        print("light blinking on the device" if code == gt.GT_OP_SUCCESS else f"failed code=0x{code:02x}")


async def cmd_identity(args):
    cfg = load_config()
    if args.gid:
        cfg["gid"] = int(args.gid, 16)
    if args.nick:
        cfg["nick"] = args.nick
    if args.passphrase is not None:
        cfg["pass"] = args.passphrase
    save_config(cfg)
    print(f"identity: nick={cfg['nick']!r}  gid=0x{cfg['gid']:012x}")
    if cfg.get("pass"):
        print(f"channel key ID: {gm.key_hint(gm.derive_key(cfg['pass'])).hex()} (encryption on by default)")
    print(f"(stored in {CONFIG.name})")


def channel_key(args, cfg) -> bytes | None:
    if getattr(args, "plain", False):
        return None
    p = args.key if getattr(args, "key", None) is not None else cfg.get("pass")
    return gm.derive_key(p) if p else None


async def cmd_send(args):
    cfg = load_config()
    addr = await resolve_address(args)
    if not addr:
        return
    to_gid = int(args.to, 16) if args.to else None
    nick = args.nick or cfg.get("nick", "")
    key = channel_key(args, cfg)
    async with GoTenna(addr) as gt_dev:
        if not await gt_dev.set_identity(cfg["gid"]):
            print("warning: could not program this radio's ID (direct replies may not reach you)")
        if to_gid:
            print(f"sending direct message; waiting for delivery receipt (up to ~{int(ACK_WAIT_S)}s per try)...")
        ok, sent, total, delivered = await gt_dev.send(
            args.text, cfg["gid"], nick=nick, to_gid=to_gid, key=key,
            on_progress=lambda n, t: print(f"  part {n}/{t} sent") if t > 1 else None,
            on_incoming=lambda msg: print(f"  (message arrived meanwhile from 0x{msg.get('from_gid', 0):012x}; run monitor to read it)"))
        kind = f"P2P -> 0x{to_gid:012x}" if to_gid else "SHOUT (broadcast)"
        lock = "encrypted " if key else ""
        if not ok:
            print(f"send FAILED after {sent} of {total} parts for {kind}")
        elif delivered is True:
            print(f"DELIVERED ✓ {lock}{kind} in {total} part(s): {args.text!r}")
        elif delivered is False:
            print(f"sent {lock}{kind}, but NO delivery receipt after {1 + P2P_RETRIES} tries "
                  f"(recipient out of range, off, or wrong ID)")
        else:
            print(f"sent {lock}{kind} in {total} part(s): {args.text!r}")


async def cmd_monitor(args):
    addr = await resolve_address(args)
    if not addr:
        return
    cfg = load_config()
    key = channel_key(args, cfg)
    reasm = gm.Reassembler([key] if key else [])
    print("monitoring for incoming messages" + (" (channel key loaded)" if key else "") + " — Ctrl+C to stop\n")
    async with GoTenna(addr) as gt_dev:
        await gt_dev.set_identity(cfg["gid"])
        print(f"your ID: 0x{cfg['gid']:012x} (share it so others can message you directly)\n")

        async def drain_inbox():
            while True:
                code, data = await gt_dev.read_message()
                if code != gt.GT_OP_SUCCESS or not data:
                    break
                try:
                    parsed = gm.parse_message(data)
                    if gm.is_receipt(parsed):
                        print(f"  ✓ delivery receipt for message 0x{parsed['ack_msg_id']:04x}")
                        await gt_dev.next_message()
                        continue
                    msg = reasm.add(parsed)
                    if msg:
                        gid = "0x%012x" % msg.get("from_gid", 0)
                        lock = "🔒 " if msg.get("encrypted") else ""
                        parts = f" ({msg['parts']} parts)" if msg.get("parts", 1) > 1 else ""
                        if msg.get("locked"):
                            print(f"  {lock}[{msg.get('class_name','?')}] {gid}: <encrypted — wrong or missing passphrase>")
                        else:
                            who = msg.get("nick") or gid
                            print(f"  {lock}[{msg.get('class_name','?')}] {who}{parts}: {msg.get('text') or '(no text)'}")
                except Exception:
                    print(f"  [raw msg] {data.hex(' ')}")
                await gt_dev.next_message()  # pop it

        # drain anything already queued, then wait for MWI changes — with a
        # periodic poll as a backstop in case a status notification is missed
        await drain_inbox()
        got = asyncio.Event()
        gt_dev.on_mwi_change = lambda _n: got.set()
        while True:
            try:
                await asyncio.wait_for(got.wait(), timeout=args.poll)
            except asyncio.TimeoutError:
                pass
            got.clear()
            await drain_inbox()


# --------------------------------------------------------------------------- #
RANGE_TAG = "BT-RANGE #"


async def cmd_rangetest(args):
    """Field range/loss test. One radio sends numbered pings; the other logs
    which arrive (with signal strength) and reports the loss rate."""
    addr = await resolve_address(args)
    if not addr:
        return
    async with GoTenna(addr) as gt_dev:
        if args.role == "send":
            cfg = load_config()
            print(f"sending {args.count} pings, one every {args.interval:.0f}s (Ctrl+C to stop)")
            for n in range(1, args.count + 1):
                pdu = gm.build_message(f"{RANGE_TAG}{n}", cfg["gid"], nick="range")
                code, _ = await gt_dev.execute(gt.OP_SENDMSG, pdu, timeout=8.0)
                print(f"  ping {n}/{args.count} {'sent' if code == gt.GT_OP_SUCCESS else 'REJECTED'}", flush=True)
                if n < args.count:
                    await asyncio.sleep(args.interval)
            return

        print(f"listening for range pings for {args.duration:.0f}s; walk the sender away and back")
        got: dict[int, int | None] = {}
        end = asyncio.get_event_loop().time() + args.duration
        while asyncio.get_event_loop().time() < end:
            code, data = await gt_dev.read_message()
            if code == gt.GT_OP_SUCCESS and data:
                msg = gm.parse_message(data)
                await gt_dev.next_message()
                text = msg.get("text") or ""
                if text.startswith(RANGE_TAG):
                    n = int(text[len(RANGE_TAG):] or 0)
                    rssi = msg.get("rssi")
                    got[n] = rssi
                    sig = f"signal {rssi - 256} (raw {rssi})" if rssi is not None else "signal n/a"
                    print(f"  ping {n:3d} received  {sig}  [{len(got)} of {max(got)} so far]", flush=True)
            else:
                await asyncio.sleep(1.0)
        if not got:
            print("\nno pings received (out of range, sender not running, or different region)")
            return
        expected = max(got)
        missing = [n for n in range(1, expected + 1) if n not in got]
        print(f"\nreceived {len(got)} of {expected} pings: loss {100 * len(missing) / expected:.0f}%")
        if missing:
            print("missing:", ", ".join(map(str, missing)))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--address", help="BLE address (skip auto-scan)")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan"); s.add_argument("--timeout", type=float, default=10.0); s.set_defaults(func=cmd_scan)
    sub.add_parser("info").set_defaults(func=cmd_info)
    r = sub.add_parser("region"); r.add_argument("value", nargs="?", help="get|us|eu|au|nz|jp"); r.set_defaults(func=cmd_region)
    sub.add_parser("locate").set_defaults(func=cmd_locate)
    i = sub.add_parser("identity"); i.add_argument("--nick"); i.add_argument("--gid", help="48-bit GID in hex")
    i.add_argument("--passphrase", help="channel passphrase for encryption ('' to clear)"); i.set_defaults(func=cmd_identity)
    se = sub.add_parser("send"); se.add_argument("text"); se.add_argument("--to", help="recipient GID hex (P2P)"); se.add_argument("--nick")
    se.add_argument("--key", help="channel passphrase (overrides saved one)"); se.add_argument("--plain", action="store_true", help="send unencrypted")
    se.set_defaults(func=cmd_send)
    mo = sub.add_parser("monitor"); mo.add_argument("--key", help="channel passphrase (overrides saved one)")
    mo.add_argument("--poll", type=float, default=5.0, help="inbox poll interval, seconds"); mo.set_defaults(func=cmd_monitor)
    rt = sub.add_parser("rangetest", help="field range/loss test (run 'send' on one radio, 'listen' on the other)")
    rt.add_argument("role", choices=["send", "listen"])
    rt.add_argument("--count", type=int, default=30, help="pings to send")
    rt.add_argument("--interval", type=float, default=5.0, help="seconds between pings")
    rt.add_argument("--duration", type=float, default=180.0, help="seconds to listen")
    rt.set_defaults(func=cmd_rangetest)
    return p


def main() -> None:
    try:  # Windows consoles default to cp1252; message text and 🔒 need UTF-8
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
