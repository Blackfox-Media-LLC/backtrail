#!/usr/bin/env python3
"""goTenna Mesh USB-serial prober.

The goTenna Mesh enumerates as a USB CDC serial port (NXP Kinetis MCU,
VID 1FC9). Reverse-engineering notes report an undocumented plain-text CLI at
9600 baud with log tags like PRNT / TRX.

SAFETY
------
A community RE source warns that talking to the goTenna outside the official
app can, in the worst case, brick it, and that the CLI includes destructive
commands (flash / data-reset / read_eflash). Therefore:

  * `info`   and `listen` are READ-ONLY. `listen` opens the port and only
    reads; it sends nothing. Worst realistic case: the device reboots when the
    port opens (recoverable).
  * `send`   writes to the device and is gated behind an explicit
    --i-understand-risk flag. It refuses the known-dangerous command words
    unless you also pass --allow-dangerous.

Subcommands:
  info     List serial ports and show details for the goTenna if present.
  listen   Open the port read-only and log everything the device emits.
  send     (gated) Write one text command and capture the reply.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import sys
import time
from pathlib import Path

import serial
from serial.tools import list_ports

import gt_protocol as gt

LOG_DIR = Path(__file__).resolve().parent / "logs"
GOTENNA_VID = 0x1FC9  # NXP Semiconductors (goTenna Kinetis MCU)
DEFAULT_BAUD = 9600

# CLI words known to be destructive / state-changing per RE notes.
DANGEROUS = {"flash", "read_eflash", "erase", "reset", "format", "bootloader", "dfu"}


def _ts() -> str:
    return _dt.datetime.now().strftime("%H:%M:%S.%f")[:-3]


def _logfile(tag: str) -> Path:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    return LOG_DIR / f"serial-{tag}-{stamp}.log"


class Tee:
    """Write to stdout and a logfile at once."""

    def __init__(self, path: Path):
        self.fh = open(path, "w", encoding="utf-8")
        print(f"log file: {path}")

    def line(self, msg: str) -> None:
        print(msg)
        self.fh.write(msg + "\n")
        self.fh.flush()

    def close(self) -> None:
        self.fh.close()


def hexdump(data: bytes, indent: str = "    ") -> str:
    if not data:
        return indent + "(empty)"
    out = []
    for off in range(0, len(data), 16):
        chunk = data[off : off + 16]
        hexp = " ".join(f"{b:02x}" for b in chunk)
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        out.append(f"{indent}{off:04x}  {hexp:<47}  {asc}")
    return "\n".join(out)


# --------------------------------------------------------------------------- #
def cmd_info(args: argparse.Namespace) -> None:
    ports = list(list_ports.comports())
    if not ports:
        print("No serial ports found.")
        return
    print(f"Found {len(ports)} serial port(s):\n")
    for p in ports:
        flag = "  <== goTenna (NXP VID)" if (p.vid == GOTENNA_VID) else ""
        print(f"  {p.device}  {p.description}{flag}")
        print(f"      hwid: {p.hwid}")
        if p.vid is not None:
            print(f"      VID:PID = {p.vid:04x}:{p.pid:04x}   serial={p.serial_number}")
        print()


def _open_readonly(port: str, baud: int, assert_lines: bool = False) -> serial.Serial:
    """Open a port read-only. By default keep DTR/RTS low (avoid reset pulses);
    with assert_lines=True raise DTR+RTS so a CDC device that gates TX on a
    present host will start transmitting. Either way we write no data bytes."""
    ser = serial.Serial()
    ser.port = port
    ser.baudrate = baud
    ser.timeout = 0.2
    ser.dsrdtr = False
    ser.rtscts = False
    try:
        ser.dtr = assert_lines
        ser.rts = assert_lines
    except Exception:
        pass
    ser.open()
    if assert_lines:
        # Re-assert after open in case the pre-open hint was ignored.
        try:
            ser.dtr = True
            ser.rts = True
        except Exception:
            pass
    return ser


def cmd_listen(args: argparse.Namespace) -> None:
    tee = Tee(_logfile("listen"))
    tee.line(f"{_ts()}  opening {args.port} @ {args.baud} baud, READ-ONLY (sending nothing)")
    if args.seconds:
        tee.line(f"{_ts()}  will listen for {args.seconds:.0f}s (Ctrl+C to stop early)")
    else:
        tee.line(f"{_ts()}  listening until Ctrl+C")
    if args.assert_dtr:
        tee.line(f"{_ts()}  raising DTR+RTS (control lines only, no data)")
    try:
        ser = _open_readonly(args.port, args.baud, assert_lines=args.assert_dtr)
    except Exception as exc:  # noqa: BLE001
        tee.line(f"{_ts()}  OPEN FAILED: {exc}")
        tee.close()
        sys.exit(1)

    tee.line(f"{_ts()}  port open. Interact with the device (press its button, etc.) and watch below.\n")
    end = time.time() + args.seconds if args.seconds else None
    total = 0
    try:
        while True:
            if end and time.time() > end:
                break
            data = ser.read(256)
            if data:
                total += len(data)
                tee.line(f"{_ts()}  <- {len(data)} bytes:")
                tee.line(hexdump(data))
                # Also show a best-effort text decode, since the CLI is text.
                text = data.decode("utf-8", errors="replace").replace("\r", "")
                if text.strip():
                    tee.line(f"      text: {text.strip()!r}")
    except KeyboardInterrupt:
        tee.line(f"\n{_ts()}  stopped by user")
    finally:
        ser.close()
        tee.line(f"{_ts()}  closed. {total} bytes received total.")
        tee.close()


def cmd_send(args: argparse.Namespace) -> None:
    if not args.i_understand_risk:
        print("REFUSED: `send` writes to the device, which carries brick risk.")
        print("Re-run with --i-understand-risk once you've decided to proceed.")
        sys.exit(2)
    parts = args.command.strip().split(None, 1)
    word = parts[0].rstrip(";").lower() if parts else ""
    if word in DANGEROUS and not args.allow_dangerous:
        print(f"REFUSED: '{word}' is on the known-dangerous list ({', '.join(sorted(DANGEROUS))}).")
        print("If you really mean it, add --allow-dangerous. This can brick the unit.")
        sys.exit(2)

    tee = Tee(_logfile("send"))
    payload = (args.command + args.terminator).encode("utf-8")
    tee.line(f"{_ts()}  opening {args.port} @ {args.baud}")
    ser = serial.Serial(args.port, args.baud, timeout=0.2)
    tee.line(f"{_ts()}  -> {payload!r}")
    ser.write(payload)
    ser.flush()
    end = time.time() + args.listen
    tee.line(f"{_ts()}  listening {args.listen:.0f}s for reply ...\n")
    try:
        while time.time() < end:
            data = ser.read(256)
            if data:
                tee.line(f"{_ts()}  <- {len(data)} bytes:")
                tee.line(hexdump(data))
                text = data.decode("utf-8", errors="replace").replace("\r", "")
                if text.strip():
                    tee.line(f"      text: {text.strip()!r}")
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()
        tee.line(f"{_ts()}  closed.")
        tee.close()


def cmd_op(args: argparse.Namespace) -> None:
    name = args.opcode.lower()
    if name not in gt.OP_BY_NAME:
        print(f"Unknown opcode name '{name}'. Known: {', '.join(sorted(gt.OP_BY_NAME))}")
        sys.exit(2)
    opcode = gt.OP_BY_NAME[name]
    data = bytes.fromhex(args.data.replace(" ", "")) if args.data else b""

    # Safety gating by opcode class.
    if opcode in gt.DESTRUCTIVE_OPS:
        if not (args.i_understand_risk and args.allow_dangerous):
            print(f"REFUSED: {gt.OP_NAMES.get(opcode)} is destructive; needs --i-understand-risk --allow-dangerous")
            sys.exit(2)
    elif opcode not in gt.SAFE_READ_OPS and opcode != gt.OP_FLASH:
        if not args.i_understand_risk:
            print(f"REFUSED: {gt.OP_NAMES.get(opcode)} writes to the device; needs --i-understand-risk")
            sys.exit(2)

    tee = Tee(_logfile(f"op-{name}"))
    frame = gt.build_frame(opcode, args.seq, data)
    tee.line(f"{_ts()}  {gt.OP_NAMES.get(opcode, hex(opcode))} seq=0x{args.seq:02x}")
    tee.line(f"{_ts()}  -> frame ({len(frame)} bytes): {frame.hex(' ')}")
    ser = serial.Serial(args.port, args.baud, timeout=0.2)
    ser.write(frame)
    ser.flush()
    payload = gt.read_frame(ser, timeout=args.listen)
    ser.close()

    if payload is None:
        tee.line(f"{_ts()}  <- no framed reply within {args.listen:.0f}s")
        tee.line(f"{_ts()}  closed.")
        tee.close()
        return
    rep = gt.ParsedReply(opcode, payload)
    tee.line(f"{_ts()}  <- payload ({len(payload)} bytes): {payload.hex(' ')}")
    tee.line(f"      result_code=0x{rep.result_code:02x} ({'SUCCESS' if rep.success else 'non-success'})"
             f"  seq=0x{rep.seq:02x}  crc_ok={rep.crc_ok}")
    tee.line(f"      data ({len(rep.data)} bytes):")
    tee.line(hexdump(rep.data, indent="        "))
    text = rep.data.decode("utf-8", errors="replace")
    if any(c.isprintable() and not c.isspace() for c in text):
        tee.line(f"      data as text: {text!r}")
    tee.line(f"{_ts()}  closed.")
    tee.close()


def cmd_kboot_ping(args: argparse.Namespace) -> None:
    """Send the NXP KBOOT ping (5A A6). Non-destructive by spec: it only asks a
    live bootloader to identify itself. A reply starting 5A A7 confirms the
    device is in the Kinetis ROM bootloader rather than app firmware."""
    tee = Tee(_logfile("kboot-ping"))
    ping = bytes([0x5A, 0xA6])
    tee.line(f"{_ts()}  opening {args.port} @ {args.baud}")
    ser = serial.Serial(args.port, args.baud, timeout=0.2)
    tee.line(f"{_ts()}  -> KBOOT ping: {ping.hex(' ')}")
    ser.write(ping)
    ser.flush()
    end = time.time() + args.listen
    got = bytearray()
    while time.time() < end:
        chunk = ser.read(32)
        if chunk:
            got += chunk
    ser.close()
    if not got:
        tee.line(f"{_ts()}  <- no response (not a KBOOT bootloader, or wrong mode)")
    else:
        tee.line(f"{_ts()}  <- {len(got)} bytes: {got.hex(' ')}")
        if len(got) >= 2 and got[0] == 0x5A and got[1] == 0xA7:
            tee.line("      *** KBOOT PING RESPONSE (5A A7) — device IS in the NXP bootloader ***")
            # Ping response: 5A A7 | bugfix minor major name | options(2) | crc16(2)
            if len(got) >= 10:
                body = got[2:]
                tee.line(f"      protocol version: {body[2]}.{body[1]}.{body[0]} (name byte 0x{body[3]:02x})")
                opts = body[4] | (body[5] << 8)
                tee.line(f"      options: 0x{opts:04x}")
        else:
            tee.line("      (response does not match a KBOOT ping ack)")
    tee.line(f"{_ts()}  closed.")
    tee.close()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    i = sub.add_parser("info", help="list serial ports; flag the goTenna")
    i.set_defaults(func=cmd_info)

    l = sub.add_parser("listen", help="READ-ONLY: log everything the device emits")
    l.add_argument("port", help="e.g. COM5")
    l.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    l.add_argument("--seconds", type=float, default=0.0, help="0 = until Ctrl+C")
    l.add_argument("--assert-dtr", action="store_true", help="raise DTR+RTS (no data) to wake a host-gated CDC port")
    l.set_defaults(func=cmd_listen)

    s = sub.add_parser("send", help="GATED: write one text command and capture reply")
    s.add_argument("port", help="e.g. COM5")
    s.add_argument("command", help='e.g. "version"')
    s.add_argument("--terminator", default=";", help="appended to the command (default ';')")
    s.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    s.add_argument("--listen", type=float, default=3.0, help="seconds to read a reply")
    s.add_argument("--i-understand-risk", action="store_true", help="required to send anything")
    s.add_argument("--allow-dangerous", action="store_true", help="also required for destructive commands")
    s.set_defaults(func=cmd_send)

    o = sub.add_parser("op", help="send a binary opcode frame and parse the reply")
    o.add_argument("port", help="e.g. COM5")
    o.add_argument("opcode", help=f"opcode name: {', '.join(sorted(gt.OP_BY_NAME))}")
    o.add_argument("--data", default="", help="hex payload for the opcode")
    o.add_argument("--seq", type=lambda x: int(x, 0), default=0x01, help="sequence byte (default 1)")
    o.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    o.add_argument("--listen", type=float, default=3.0, help="seconds to read the reply")
    o.add_argument("--i-understand-risk", action="store_true")
    o.add_argument("--allow-dangerous", action="store_true")
    o.set_defaults(func=cmd_op)

    k = sub.add_parser("kboot-ping", help="probe for an NXP KBOOT bootloader (non-destructive)")
    k.add_argument("port", help="e.g. COM5")
    k.add_argument("--baud", type=int, default=DEFAULT_BAUD)
    k.add_argument("--listen", type=float, default=2.0)
    k.set_defaults(func=cmd_kboot_ping)
    return p


def main() -> None:
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
