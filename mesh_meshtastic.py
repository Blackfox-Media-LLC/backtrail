"""Meshtastic adapter for Backtrail (Python), built on the official `meshtastic`
library (GPL-3.0). Works over USB serial (COMx) or Bluetooth (address).

The library is thread-based (pubsub callbacks); this adapter hands incoming
text to an asyncio loop so it can sit beside the async goTenna driver.
"""

from __future__ import annotations

import asyncio
import re

MAX_TEXT_BYTES = 200  # Meshtastic text payloads top out a little above this


def node_id(num: int) -> str:
    return "!%08x" % (num & 0xFFFFFFFF)


def parse_node_id(s: str) -> int | None:
    t = (s or "").strip().lower().lstrip("!")
    if re.fullmatch(r"[0-9a-f]{1,8}", t):
        return int(t, 16)
    if re.fullmatch(r"\d+", t):
        return int(t) & 0xFFFFFFFF
    return None


def split_text(text: str, max_bytes: int = MAX_TEXT_BYTES) -> list[str]:
    """Split into Meshtastic-sized chunks, prefixing '(i/n) ' when split."""
    if len(text.encode("utf-8")) <= max_bytes:
        return [text]
    room, chunks, cur = max_bytes - 8, [], ""
    for ch in text:
        if len((cur + ch).encode("utf-8")) > room:
            chunks.append(cur)
            cur = ""
        cur += ch
    if cur:
        chunks.append(cur)
    return [f"({i + 1}/{len(chunks)}) {c}" for i, c in enumerate(chunks)]


class MeshtasticRadio:
    """Thin wrapper: open(), info(), send(), messages arrive via on_message."""

    def __init__(self, target: str):
        self.target = target          # "COM5" / "/dev/ttyUSB0" or a BLE address/name
        self.iface = None
        self.on_message = None        # callback(dict) — called on the asyncio loop
        self._loop: asyncio.AbstractEventLoop | None = None

    def is_serial(self) -> bool:
        return bool(re.match(r"(?i)^(com\d+|/dev/)", self.target))

    async def open(self) -> dict:
        self._loop = asyncio.get_running_loop()
        from pubsub import pub

        def on_text(packet, interface):  # runs on the library's thread
            if interface is not self.iface:
                return
            msg = self._normalize(packet)
            if msg and self.on_message:
                self._loop.call_soon_threadsafe(self.on_message, msg)

        self._handler = on_text
        pub.subscribe(self._handler, "meshtastic.receive.text")

        def _open():
            if self.is_serial():
                from meshtastic.serial_interface import SerialInterface
                return SerialInterface(devPath=self.target)
            from meshtastic.ble_interface import BLEInterface
            return BLEInterface(address=self.target)

        self.iface = await asyncio.to_thread(_open)  # blocks until the radio's config is loaded
        return self.info()

    def _name(self, num: int) -> str:
        node = (self.iface.nodesByNum or {}).get(num) if self.iface else None
        user = (node or {}).get("user", {})
        return user.get("shortName") or user.get("longName") or node_id(num)

    def _normalize(self, p: dict) -> dict | None:
        text = (p.get("decoded") or {}).get("text")
        if text is None:
            return None
        my = self.iface.myInfo.my_node_num if self.iface and self.iface.myInfo else None
        frm, to = p.get("from"), p.get("to")
        if frm == my:
            return None
        return {
            "net": "meshtastic", "from": frm, "from_name": self._name(frm), "to": to,
            "direct": to == my, "channel": p.get("channel", 0), "text": text,
            "rssi": p.get("rxRssi"), "snr": p.get("rxSnr"),
        }

    def info(self) -> dict:
        if not self.iface:
            return {}
        my = self.iface.myInfo.my_node_num
        node = (self.iface.nodesByNum or {}).get(my, {})
        user = node.get("user", {})
        md = getattr(self.iface, "metadata", None)
        region = None
        try:
            region = self.iface.localNode.localConfig.lora.region
            from meshtastic.protobuf import config_pb2
            region = config_pb2.Config.LoRaConfig.RegionCode.Name(region)
        except Exception:
            pass
        return {
            "node_num": my, "node_id": node_id(my),
            "long_name": user.get("longName"), "short_name": user.get("shortName"),
            "hw_model": user.get("hwModel"),
            "firmware": getattr(md, "firmware_version", None) if md else None,
            "region": region, "nodes_heard": len(self.iface.nodesByNum or {}),
        }

    async def send(self, text: str, to: int | None = None, channel: int = 0, ack_timeout: float = 60.0):
        """Broadcast on a channel, or send direct (with ACK). Returns
        (ok, parts, delivered): delivered is None for broadcasts."""
        parts = split_text(text)
        delivered = True if to is not None else None
        for part in parts:
            if to is None:
                await asyncio.to_thread(self.iface.sendText, part, channelIndex=channel)
                continue
            got = asyncio.Event()
            ok = {"v": False}

            def on_ack(packet):  # routing response for this message
                err = ((packet.get("decoded") or {}).get("routing") or {}).get("errorReason", "NONE")
                ok["v"] = err == "NONE"
                self._loop.call_soon_threadsafe(got.set)

            await asyncio.to_thread(self.iface.sendText, part, destinationId=to, wantAck=True,
                                    channelIndex=channel, onResponse=on_ack)
            try:
                await asyncio.wait_for(got.wait(), timeout=ack_timeout)
            except asyncio.TimeoutError:
                pass
            if not ok["v"]:
                delivered = False
        return True, len(parts), delivered

    async def close(self):
        try:
            from pubsub import pub
            pub.unsubscribe(self._handler, "meshtastic.receive.text")
        except Exception:
            pass
        if self.iface:
            await asyncio.to_thread(self.iface.close)
