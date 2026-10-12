"""goTenna binary command protocol — framing, CRC, and opcodes.

Clean-room implementation of the DLE-escaped command framing the goTenna Mesh
uses on both its BLE and USB-serial links. The wire format and opcode constants
were reverse-engineered by the pyGT project (https://github.com/sybip/pyGT,
MIT); this is an independent implementation for interoperability.

Frame layout:
    STX(0x10 0x02) | opcode | seq | data... | CRC16-BE | ETX(0x10 0x03)
with every literal 0x10 inside the opcode/seq/data/CRC region doubled (DLE
escaping). CRC16 is XMODEM (poly 0x1021, init 0x0000) over opcode+seq+data.
"""

from __future__ import annotations

import time

STX = b"\x10\x02"
ETX = b"\x10\x03"
DLE = 0x10

# Opcodes (from pyGT's gtdefs). Grouped by how safe they are to send.
OP_FLASH = 0x00     # blink the locate light 3x (harmless)
OP_SET_GID = 0x01   # write: set GID
OP_SET_PUB = 0x02   # write: upload public key
OP_SENDMSG = 0x03   # write: transmit a message over the air
OP_SYSINFO = 0x04   # READ: serial, firmware version, battery
OP_READMSG = 0x06   # READ: first message in RX queue
OP_NEXTMSG = 0x07   # write: delete first message from queue
OP_RST_GID = 0x0B   # destructive: reset GID
OP_DEL_GID = 0x0D   # destructive: delete GID
OP_SET_APP = 0x10   # write: set App ID
OP_SET_GEO = 0x21   # write: set region
OP_GET_GEO = 0x22   # READ: get region
OP_GETPROP = 0x25   # READ: get property
OP_GET_FLT = 0x26   # READ
OP_GET_DDI = 0x27   # READ

GT_OP_SUCCESS = 0x40

# Opcodes safe to send with no side effects (pure reads / locate blink).
SAFE_READ_OPS = {OP_SYSINFO, OP_GET_GEO, OP_GETPROP, OP_GET_FLT, OP_GET_DDI, OP_READMSG}
# Opcodes that must never be sent without an explicit danger override.
DESTRUCTIVE_OPS = {OP_SET_GID, OP_SET_PUB, OP_RST_GID, OP_DEL_GID, OP_SET_APP, OP_SET_GEO, OP_NEXTMSG}

OP_NAMES = {
    OP_FLASH: "OP_FLASH", OP_SET_GID: "OP_SET_GID", OP_SET_PUB: "OP_SET_PUB",
    OP_SENDMSG: "OP_SENDMSG", OP_SYSINFO: "OP_SYSINFO", OP_READMSG: "OP_READMSG",
    OP_NEXTMSG: "OP_NEXTMSG", OP_RST_GID: "OP_RST_GID", OP_DEL_GID: "OP_DEL_GID",
    OP_SET_APP: "OP_SET_APP", OP_SET_GEO: "OP_SET_GEO", OP_GET_GEO: "OP_GET_GEO",
    OP_GETPROP: "OP_GETPROP", OP_GET_FLT: "OP_GET_FLT", OP_GET_DDI: "OP_GET_DDI",
}

# Friendly name -> opcode, for the CLI.
OP_BY_NAME = {
    "sysinfo": OP_SYSINFO, "getgeo": OP_GET_GEO, "getprop": OP_GETPROP,
    "getflt": OP_GET_FLT, "getddi": OP_GET_DDI, "readmsg": OP_READMSG,
    "nextmsg": OP_NEXTMSG, "flash": OP_FLASH, "sendmsg": OP_SENDMSG,
    "setgeo": OP_SET_GEO, "setgid": OP_SET_GID,
}

# Geopolitical regions (which RF band/plan the radio uses). Same goTenna
# protocol on each — this only retunes the band, it does not let the device
# receive other systems (LoRa/Meshtastic/FRS/ham are different modulation).
API_TLV_REGION = 0x1F
REGIONS = {"us": 1, "eu": 2, "au": 4, "nz": 5, "jp": 8}
REGION_NAME = {1: "North America (902-928 MHz)", 2: "European Union (868 MHz)",
               4: "Australia", 5: "New Zealand", 8: "Japan"}


def region_set_data(region_id: int) -> bytes:
    """Payload for OP_SET_GEO: a region TLV."""
    return bytes([API_TLV_REGION, 0x01, region_id & 0xFF])


def region_from_reply(data: bytes) -> int | None:
    """Extract region id from an OP_GET_GEO reply (region TLV)."""
    i = 0
    while i + 2 <= len(data):
        t, length = data[i], data[i + 1]
        value = data[i + 2:i + 2 + length]
        if t == API_TLV_REGION and value:
            return value[0]
        i += 2 + length
    return None


def crc16_xmodem(data: bytes) -> int:
    """CRC16/XMODEM (poly 0x1021, init 0). Matches pyGT's pycrc16.crc()."""
    crc = 0
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if (crc & 0x8000) else (crc << 1) & 0xFFFF
    return crc & 0xFFFF


def build_frame(opcode: int, seq: int, data: bytes = b"") -> bytes:
    """Build a complete STX..ETX command frame."""
    pdu = bytes([opcode & 0xFF, seq & 0xFF]) + data
    crc = crc16_xmodem(pdu)
    pdu += bytes([(crc >> 8) & 0xFF, crc & 0xFF])  # big-endian
    escaped = pdu.replace(b"\x10", b"\x10\x10")
    return STX + escaped + ETX


class ParsedReply:
    def __init__(self, opcode: int, payload: bytes):
        self.raw = payload
        self.result_byte = payload[0] if payload else None
        # pyGT: result code = opcode XOR reply byte0
        self.result_code = (opcode ^ payload[0]) if payload else None
        self.seq = payload[1] if len(payload) > 1 else None
        self.data = payload[2:-2] if len(payload) >= 4 else b""
        self.crc_ok = None
        if len(payload) >= 4:
            got = (payload[-2] << 8) | payload[-1]
            self.crc_ok = (crc16_xmodem(payload[:-2]) == got)

    @property
    def success(self) -> bool:
        return self.result_code == GT_OP_SUCCESS


class FrameAssembler:
    """Feed arbitrary byte chunks (e.g. BLE notifications); get complete,
    unescaped opcode..CRC payloads out as full STX..ETX frames arrive."""

    def __init__(self):
        self.state = "idle"
        self.payload = bytearray()

    def feed(self, data: bytes) -> list[bytes]:
        done: list[bytes] = []
        for b in data:
            if self.state == "idle":
                if b == DLE:
                    self.state = "dle_start"
            elif self.state == "dle_start":
                if b == 0x02:
                    self.state = "in_frame"
                    self.payload = bytearray()
                else:
                    self.state = "idle"
            elif self.state == "in_frame":
                if b == DLE:
                    self.state = "dle"
                else:
                    self.payload.append(b)
            elif self.state == "dle":
                if b == DLE:
                    self.payload.append(DLE); self.state = "in_frame"
                elif b == 0x03:
                    done.append(bytes(self.payload)); self.state = "idle"
                elif b == 0x02:
                    self.payload = bytearray(); self.state = "in_frame"
                else:
                    self.payload.append(b); self.state = "in_frame"
        return done


def read_frame(ser, timeout: float = 3.0) -> bytes | None:
    """Read one DLE-framed reply (unescaped opcode..CRC region) or None."""
    end = time.time() + timeout
    state = "idle"
    payload = bytearray()
    while time.time() < end:
        chunk = ser.read(64)
        if not chunk:
            continue
        for b in chunk:
            if state == "idle":
                if b == DLE:
                    state = "dle_start"
            elif state == "dle_start":
                state = "in_frame" if b == 0x02 else "idle"
                if state == "in_frame":
                    payload = bytearray()
            elif state == "in_frame":
                if b == DLE:
                    state = "dle"
                else:
                    payload.append(b)
            elif state == "dle":
                if b == DLE:
                    payload.append(DLE); state = "in_frame"
                elif b == 0x03:
                    return bytes(payload)            # ETX -> done
                elif b == 0x02:
                    payload = bytearray(); state = "in_frame"  # restart on STX
                else:
                    payload.append(b); state = "in_frame"
    return None
