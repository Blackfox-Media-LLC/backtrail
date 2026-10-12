"""goTenna message objects — TLV + API message build/parse.

Clean-room reimplementation of goTenna's message envelope (the payload carried
by OP_SENDMSG / OP_READMSG). Structure reverse-engineered by pyGT (sybip, MIT);
this is an independent implementation.

A sent message PDU (top-level TLVs):
    DEST(0x06) | [0x04 only for P2P] | DATA(0x05 = HEAD(0xfb) + app-blob) | TTL(0x22)
HEAD is a fixed struct: crypt(B) fromGID(Q) timestamp(L) seqNo0(H) seqNo1(B).
The app-blob is our own content TLVs (type/nick/text).
"""

from __future__ import annotations

import struct
import time

from gt_protocol import crc16_xmodem

# Message classes
MSG_CLASS_P2P = 0
MSG_CLASS_GROUP = 1
MSG_CLASS_SHOUT = 2
MSG_CLASS_EMERG = 3
MSG_CLASS_NAME = {0: "P2P", 1: "GROUP", 2: "SHOUT", 3: "EMERGENCY"}

# Envelope TLVs
TLV_X04 = 0x04
TLV_DATA = 0x05
TLV_DEST = 0x06
TLV_HOPS = 0x20
TLV_DLR = 0x21
TLV_TTL = 0x22
TLV_HEAD = 0xFB

# App content (blob) TLVs
BLOB_TYPE = 0x01
BLOB_NICK = 0x03
BLOB_TEXT = 0x04

DEFAULT_APP_ID = 0x3FFF  # goTenna app's app ID: devices filter received messages by app ID,
                         # so this is what stock-configured devices deliver (verified OTA)


def tlv_pack(dtype: int, data: bytes) -> bytes:
    if isinstance(data, str):
        data = data.encode("utf-8")
    if len(data) > 255:
        raise ValueError("TLV value too long (>255)")
    return bytes([dtype & 0xFF, len(data)]) + data


def tlv_read(data: bytes):
    """Yield (type, length, value) over a TLV byte string."""
    while data:
        if len(data) < 2:
            raise ValueError("truncated TLV")
        t, length = data[0], data[1]
        value = data[2:2 + length]
        if len(value) != length:
            raise ValueError("truncated TLV value")
        yield t, length, value
        data = data[2 + length:]


def build_blob(text: str, nick: str = "") -> bytes:
    """goTenna-app-compatible text blob: TYPE/NICK/TEXT TLVs + CRC16 (XMODEM)."""
    blob = tlv_pack(BLOB_TYPE, b"0")
    if nick:
        blob += tlv_pack(BLOB_NICK, nick)
    blob += tlv_pack(BLOB_TEXT, text)
    return blob + struct.pack("!H", crc16_xmodem(blob))


def build_message(text: str, from_gid: int, *, msg_class: int = MSG_CLASS_SHOUT,
                  nick: str = "", app_id: int = DEFAULT_APP_ID, dest_gid: int = 0,
                  dest_tag: int = 0, ttl: int | None = None, seq0: int = 0, seq1: int = 0) -> bytes:
    """Build the OP_SENDMSG payload for a shout or P2P text message."""
    return build_message_blob(build_blob(text, nick), from_gid, msg_class=msg_class,
                              app_id=app_id, dest_gid=dest_gid, dest_tag=dest_tag,
                              ttl=ttl, seq0=seq0, seq1=seq1)


def build_message_blob(blob: bytes, from_gid: int, *, msg_class: int = MSG_CLASS_SHOUT,
                       app_id: int = DEFAULT_APP_ID, dest_gid: int = 0, dest_tag: int = 0,
                       ttl: int | None = None, seq0: int = 0, seq1: int = 0) -> bytes:
    """Build the OP_SENDMSG payload around an already-built content blob.

    TTL defaults to 1 for shouts (matches the goTenna app; relayed shouts made
    receivers miss traffic while rebroadcasting) and 3 for addressed messages."""
    if ttl is None:
        ttl = 1 if msg_class in (MSG_CLASS_SHOUT,) else 3
    msg_dest = struct.pack("!BH", msg_class, app_id & 0xFFFF)
    if msg_class in (MSG_CLASS_P2P, MSG_CLASS_GROUP):
        msg_dest += bytes.fromhex("%012x%02x" % (dest_gid & 0xFFFFFFFFFFFF, dest_tag & 0xFF))

    msg_head = struct.pack("!BQLHB", 0, from_gid & 0xFFFFFFFFFFFF,
                           int(time.time()), seq0 & 0xFFFF, seq1 & 0xFF)
    head_tlv = tlv_pack(TLV_HEAD, msg_head)

    pdu = tlv_pack(TLV_DEST, msg_dest)
    if msg_class == MSG_CLASS_P2P:
        pdu += tlv_pack(TLV_X04, b"\xff\x00\x00")
    pdu += tlv_pack(TLV_DATA, head_tlv + blob)
    pdu += tlv_pack(TLV_TTL, bytes([ttl & 0xFF]))
    return pdu


def parse_message(pdu: bytes) -> dict:
    """Parse a received message PDU (OP_READMSG payload) into a dict."""
    msg: dict = {"raw": pdu}
    for t, length, value in tlv_read(pdu):
        if t == TLV_DEST:
            msg["class_id"], msg["app_id"] = struct.unpack("!BH", value[:3])
            msg["class_name"] = MSG_CLASS_NAME.get(msg["class_id"], "?")
            if msg["class_id"] in (MSG_CLASS_P2P, MSG_CLASS_GROUP) and len(value) >= 9:
                msg["dest_gid"] = struct.unpack("!Q", value[1:9])[0] & 0xFFFFFFFFFFFF
                msg["dest_tag"] = value[9] if len(value) > 9 else 0
        elif t == TLV_DATA:
            if length >= 18 and value[0] == TLV_HEAD:
                (msg["crypt"], msg["from_gid"], msg["tstamp"],
                 msg["seq0"], msg["seq1"]) = struct.unpack("!BQLHB", value[2:18])
                blob = value[18:]
                msg.update(parse_blob(blob))
        elif t == TLV_HOPS and len(value) >= 2:
            msg["hops"], msg["rssi"] = value[0], value[1]
        elif t == TLV_DLR and len(value) >= 3:
            msg["ack_status"], msg["ack_msg_id"] = struct.unpack("!BH", value[:3])
    return msg


def parse_blob(blob: bytes) -> dict:
    out: dict = {}
    # goTenna-app blobs end in a CRC16. Strip it only if it checks out AND the
    # remainder parses cleanly (a part blob would fail that second test).
    if len(blob) >= 2 and crc16_xmodem(blob[:-2]) == struct.unpack("!H", blob[-2:])[0]:
        try:
            list(tlv_read(blob[:-2]))
            blob = blob[:-2]
        except ValueError:
            pass
    try:
        for t, _length, value in tlv_read(blob):
            if t == BLOB_TEXT:
                out["text"] = value.decode("utf-8", errors="replace")
            elif t == BLOB_NICK:
                out["nick"] = value.decode("utf-8", errors="replace")
            elif t == BLOB_TYPE:
                out["msg_type"] = value.decode("utf-8", errors="replace")
            elif t == TLV_BT_FRAG and len(value) >= 4:
                out["frag"] = struct.unpack("!HBB", value[:4])  # (msg_id, idx, total)
            elif t == TLV_BT_PART:
                out["part"] = bytes(value)
    except ValueError:
        out["blob_raw"] = blob.hex()
    return out


# --------------------------------------------------------------------------- #
# Backtrail envelope v1: encryption + long messages
#
# Short unencrypted messages keep the legacy TYPE/NICK/TEXT blob (readable by
# any goTenna-protocol client). Encrypted or long messages carry a "logical
# payload" split into parts, each sent as its own radio message:
#     blob = TYPE("0") | FRAG(msg_id u16, idx u8, total u8) | PART(chunk)
# Logical payload:
#     plain:     0x01 | nick_len u8 | nick | text (utf-8, any length)
#     encrypted: 0x02 | key_hint(2) | nonce(12) | AES-256-GCM(plain form)+tag
# GCM associated data binds a ciphertext to its sender and message id:
#     "BT1" | from_gid (6 bytes) | msg_id (2 bytes)
# Keys come from a shared channel passphrase (PBKDF2-HMAC-SHA256).
# --------------------------------------------------------------------------- #
import hashlib
import json
import os
import secrets

TLV_BT_FRAG = 0xB0
TLV_BT_PART = 0xB1
ENV_PLAIN = 0x01
ENV_ENC = 0x02
KDF_SALT = b"backtrail-v1-channel"
KDF_ITERS = 200_000
MAX_BLOB = 225                 # 237 TLV ceiling minus 12 B P2P addressing (P2P part at 237 was rejected)
PART_OVERHEAD = 3 + 6 + 2      # TYPE tlv + FRAG tlv + PART tlv header
MAX_PART = MAX_BLOB - PART_OVERHEAD
MAX_PARTS = 32


def derive_key(passphrase: str) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), KDF_SALT, KDF_ITERS, 32)


def key_hint(key: bytes) -> bytes:
    return hashlib.sha256(key).digest()[:2]


def _aad(from_gid: int, msg_id: int) -> bytes:
    return b"BT1" + (from_gid & 0xFFFFFFFFFFFF).to_bytes(6, "big") + (msg_id & 0xFFFF).to_bytes(2, "big")


def encode_plain(text: str, nick: str = "") -> bytes:
    nb = nick.encode("utf-8")[:64]
    return bytes([ENV_PLAIN, len(nb)]) + nb + text.encode("utf-8")


def decode_plain(data: bytes) -> dict:
    """Decode an inner (unencrypted) envelope: plain text (0x01) or rich JSON (0x03)."""
    if data and data[0] == ENV_RICH:
        return decode_rich(data)
    if not data or data[0] != ENV_PLAIN or len(data) < 2:
        raise ValueError("not a plain envelope")
    n = data[1]
    return {"nick": data[2:2 + n].decode("utf-8", errors="replace"),
            "text": data[2 + n:].decode("utf-8", errors="replace")}


# Rich envelope (0x03): compact JSON for messages that carry more than text.
#   {"t": text, "n": nick, "k": kind, "l": [lat, lon, accuracy_m]}
# kind: "sos" | "checkin" | "loc" (location share). All keys optional.
ENV_RICH = 0x03
KINDS = ("sos", "checkin", "loc")


def encode_rich(text: str = "", nick: str = "", kind: str | None = None, loc=None) -> bytes:
    d = {}
    if text:
        d["t"] = text
    if nick:
        d["n"] = nick[:64]
    if kind:
        if kind not in KINDS:
            raise ValueError(f"unknown kind {kind!r}")
        d["k"] = kind
    if loc is not None:
        lat, lon = float(loc[0]), float(loc[1])
        acc = int(round(float(loc[2]))) if len(loc) > 2 and loc[2] is not None else None
        d["l"] = [round(lat, 5), round(lon, 5)] + ([acc] if acc is not None else [])
    return bytes([ENV_RICH]) + json.dumps(d, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def decode_rich(data: bytes) -> dict:
    d = json.loads(data[1:].decode("utf-8"))
    out = {"text": d.get("t", ""), "nick": d.get("n", "")}
    if d.get("k") in KINDS:
        out["kind"] = d["k"]
    loc = d.get("l")
    if isinstance(loc, list) and len(loc) >= 2:
        out["loc"] = {"lat": float(loc[0]), "lon": float(loc[1]),
                      "acc": float(loc[2]) if len(loc) > 2 else None}
    return out


def seal(plain: bytes, key: bytes, from_gid: int, msg_id: int) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plain, _aad(from_gid, msg_id))
    return bytes([ENV_ENC]) + key_hint(key) + nonce + ct


def unseal(env: bytes, key: bytes, from_gid: int, msg_id: int) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if len(env) < 1 + 2 + 12 + 16 or env[0] != ENV_ENC:
        raise ValueError("not an encrypted envelope")
    return AESGCM(key).decrypt(env[3:15], env[15:], _aad(from_gid, msg_id))


def build_parts(text: str, from_gid: int, nick: str = "", key: bytes | None = None,
                max_part: int = MAX_PART, kind: str | None = None, loc=None) -> tuple[int, list[bytes]]:
    """Return (msg_id, [content blobs]) — one radio message per blob.
    `kind`/`loc` (SOS, check-in, location) use the rich envelope."""
    msg_id = secrets.randbits(16)
    rich = kind is not None or loc is not None
    if key is None and not rich:
        legacy = build_blob(text, nick) if len(text.encode()) <= 255 else None
        if legacy is not None and len(legacy) <= MAX_BLOB:
            return msg_id, [legacy]
    logical = encode_rich(text, nick, kind, loc) if rich else encode_plain(text, nick)
    if key is not None:
        logical = seal(logical, key, from_gid, msg_id)
    chunks = [logical[i:i + max_part] for i in range(0, len(logical), max_part)]
    if len(chunks) > MAX_PARTS:
        raise ValueError(f"message too long ({len(chunks)} parts, max {MAX_PARTS})")
    total = len(chunks)
    blobs = [tlv_pack(BLOB_TYPE, b"0") + tlv_pack(TLV_BT_FRAG, struct.pack("!HBB", msg_id, i, total))
             + tlv_pack(TLV_BT_PART, c) for i, c in enumerate(chunks)]
    return msg_id, blobs


def decode_logical(logical: bytes, from_gid: int, msg_id: int, keys: list[bytes]) -> dict:
    if logical and logical[0] in (ENV_PLAIN, ENV_RICH):
        return {**decode_plain(logical), "encrypted": False}
    if logical and logical[0] == ENV_ENC:
        hint = logical[1:3]
        for k in keys:
            if key_hint(k) != hint:
                continue
            try:
                return {**decode_plain(unseal(logical, k, from_gid, msg_id)), "encrypted": True}
            except Exception:
                break
        return {"encrypted": True, "locked": True, "text": None, "nick": ""}
    raise ValueError("unknown envelope")


class Reassembler:
    """Collect message parts; emit complete, decoded messages."""

    def __init__(self, keys: list[bytes] | None = None, ttl: float = 600.0):
        self.keys = list(keys or [])
        self.ttl = ttl
        self.pending: dict = {}  # (from_gid, msg_id) -> {"t": ts, "total": n, "parts": {idx: bytes}}
        self.done: dict = {}     # (from_gid, msg_id) -> completion time; drops repeat passes

    def add(self, msg: dict) -> dict | None:
        now = time.time()
        for k in [k for k, v in self.pending.items() if now - v["t"] > self.ttl]:
            del self.pending[k]
        for k in [k for k, t in self.done.items() if now - t > self.ttl]:
            del self.done[k]
        if "frag" not in msg:
            return {**msg, "encrypted": False}          # legacy single message
        msg_id, idx, total = msg["frag"]
        key = (msg.get("from_gid", 0), msg_id)
        if key in self.done:
            return None                                  # redundant pass of a finished message
        slot = self.pending.setdefault(key, {"t": now, "total": total, "parts": {}})
        slot["parts"][idx] = msg.get("part", b"")
        if len(slot["parts"]) < slot["total"]:
            return None
        del self.pending[key]
        self.done[key] = now
        logical = b"".join(slot["parts"][i] for i in range(slot["total"]))
        out = {k: v for k, v in msg.items() if k not in ("frag", "part")}
        try:
            out.update(decode_logical(logical, msg.get("from_gid", 0), msg_id, self.keys))
        except ValueError:
            out.update({"text": None, "corrupt": True})
        out["parts"] = total
        return out


# --------------------------------------------------------------------------- #
# Delivery receipts (P2P). The receiving radio returns a DLR TLV (0x21) whose
# msg id is GTH16 over the 16-byte HEAD struct of the delivered message
# (goTenna's hash, documented by pyGT; independent implementation here).
# --------------------------------------------------------------------------- #
def gt_h16(data: bytes) -> int:
    """goTenna GTH16: Park-Miller LCG (seed 0xAA, mult 48271), XOR-folded."""
    x, h = 0xAA, 0
    for c in data:
        x = (((x + c) * 48271 + 1) & 0xFFFFFFFF) % 0x7FFFFFFF
        h ^= x
    return ((h >> 16) ^ h) & 0xFFFF


def message_hash(pdu: bytes) -> int | None:
    """GTH16 of a message PDU's HEAD struct — the id a delivery receipt carries."""
    for t, length, value in tlv_read(pdu):
        if t == TLV_DATA and length >= 18 and value[0] == TLV_HEAD:
            return gt_h16(value[2:18])
    return None


def is_receipt(msg: dict) -> bool:
    """A delivery receipt has a DLR TLV and no message body."""
    return "ack_msg_id" in msg and "text" not in msg and "frag" not in msg
