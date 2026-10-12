// goTenna protocol — framing, CRC, opcodes, and message build/parse.
// JS port of gt_protocol.py / gt_message.py (both verified against a device).
// Protocol constants reverse-engineered by pyGT (sybip, MIT); independent impl.
// Usable as an ES module in the browser and in Node (for parity tests).

export const STX = [0x10, 0x02];
export const ETX = [0x10, 0x03];
const DLE = 0x10;

// Opcodes
export const OP = {
  FLASH: 0x00, SET_GID: 0x01, SET_PUB: 0x02, SENDMSG: 0x03, SYSINFO: 0x04,
  READMSG: 0x06, NEXTMSG: 0x07, RST_GID: 0x0b, DEL_GID: 0x0d, SET_APP: 0x10,
  SET_GEO: 0x21, GET_GEO: 0x22,
};
export const OP_SUCCESS = 0x40;

// Regions (RF band selection — same protocol, different band)
export const REGIONS = { us: 1, eu: 2, au: 4, nz: 5, jp: 8 };
export const REGION_NAME = {
  1: "North America (902–928 MHz)", 2: "European Union (868 MHz)",
  4: "Australia", 5: "New Zealand", 8: "Japan",
};
const API_TLV_REGION = 0x1f;

// Message classes / TLVs
export const MSG_CLASS = { P2P: 0, GROUP: 1, SHOUT: 2, EMERG: 3 };
export const MSG_CLASS_NAME = { 0: "P2P", 1: "GROUP", 2: "SHOUT", 3: "EMERGENCY" };
const TLV_X04 = 0x04, TLV_DATA = 0x05, TLV_DEST = 0x06, TLV_HOPS = 0x20,
      TLV_DLR = 0x21, TLV_TTL = 0x22, TLV_HEAD = 0xfb;
const BLOB_TYPE = 0x01, BLOB_NICK = 0x03, BLOB_TEXT = 0x04;
// goTenna app's app ID. Devices filter received messages by app ID, so this is
// what stock-configured devices deliver (verified over the air).
export const DEFAULT_APP_ID = 0x3fff;

export function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= (b << 8);
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export function buildFrame(opcode, seq, data = []) {
  const pdu = [opcode & 0xff, seq & 0xff, ...data];
  const c = crc16(pdu);
  pdu.push((c >> 8) & 0xff, c & 0xff);
  const esc = [];
  for (const b of pdu) { esc.push(b); if (b === DLE) esc.push(DLE); }
  return new Uint8Array([...STX, ...esc, ...ETX]);
}

export class FrameAssembler {
  constructor() { this.state = "idle"; this.payload = []; }
  feed(bytes) {
    const done = [];
    for (const b of bytes) {
      if (this.state === "idle") { if (b === DLE) this.state = "dle_start"; }
      else if (this.state === "dle_start") {
        if (b === 0x02) { this.state = "in"; this.payload = []; }
        else this.state = "idle";
      } else if (this.state === "in") {
        if (b === DLE) this.state = "dle"; else this.payload.push(b);
      } else if (this.state === "dle") {
        if (b === DLE) { this.payload.push(DLE); this.state = "in"; }
        else if (b === 0x03) { done.push(Uint8Array.from(this.payload)); this.state = "idle"; }
        else if (b === 0x02) { this.payload = []; this.state = "in"; }
        else { this.payload.push(b); this.state = "in"; }
      }
    }
    return done;
  }
}

export function parseReply(opcode, payload) {
  const out = { raw: payload };
  if (payload.length >= 1) { out.resultCode = (opcode ^ payload[0]) & 0xff; out.success = out.resultCode === OP_SUCCESS; }
  if (payload.length >= 2) out.seq = payload[1];
  out.data = payload.length >= 4 ? payload.slice(2, -2) : new Uint8Array();
  if (payload.length >= 4) {
    const got = (payload[payload.length - 2] << 8) | payload[payload.length - 1];
    out.crcOk = crc16(payload.slice(0, -2)) === got;
  }
  return out;
}

// --- regions ---
export function regionSetData(id) { return [API_TLV_REGION, 0x01, id & 0xff]; }
export function regionFromReply(data) {
  let i = 0;
  while (i + 2 <= data.length) {
    const t = data[i], len = data[i + 1];
    if (t === API_TLV_REGION && len >= 1) return data[i + 2];
    i += 2 + len;
  }
  return null;
}

// --- messages ---
function tlv(type, data) {
  const d = typeof data === "string" ? new TextEncoder().encode(data) : Uint8Array.from(data);
  return [type & 0xff, d.length & 0xff, ...d];
}
// goTenna-app-compatible text blob: TYPE/NICK/TEXT TLVs + CRC16 (XMODEM).
function buildBlob(text, nick) {
  let blob = tlv(BLOB_TYPE, "0");
  if (nick) blob = blob.concat(tlv(BLOB_NICK, nick));
  blob = blob.concat(tlv(BLOB_TEXT, text));
  const c = crc16(blob);
  return blob.concat([(c >> 8) & 0xff, c & 0xff]);
}
function tlvValid(d) {
  let i = 0;
  while (i < d.length) { if (i + 2 > d.length || i + 2 + d[i + 1] > d.length) return false; i += 2 + d[i + 1]; }
  return i === d.length;
}
export function buildMessage(text, fromGid, opts = {}) {
  return buildMessageBlob(buildBlob(text, opts.nick || ""), fromGid, opts);
}

export function buildMessageBlob(blob, fromGid, { msgClass = MSG_CLASS.SHOUT,
    appId = DEFAULT_APP_ID, destGid = 0, destTag = 0, ttl = null, seq0 = 0, seq1 = 0 } = {}) {
  // TTL 1 for shouts (goTenna app behavior; relayed shouts caused missed traffic), 3 otherwise.
  if (ttl == null) ttl = msgClass === MSG_CLASS.SHOUT ? 1 : 3;
  const dest = [msgClass & 0xff, (appId >> 8) & 0xff, appId & 0xff];
  if (msgClass === MSG_CLASS.P2P || msgClass === MSG_CLASS.GROUP) {
    const g = BigInt(destGid) & 0xffffffffffffn;
    for (let s = 40n; s >= 0n; s -= 8n) dest.push(Number((g >> s) & 0xffn));
    dest.push(destTag & 0xff);
  }
  // HEAD: crypt(B) fromGID(Q) timestamp(L) seq0(H) seq1(B)
  const head = new Uint8Array(16);
  const dv = new DataView(head.buffer);
  dv.setUint8(0, 0);
  dv.setBigUint64(1, BigInt(fromGid) & 0xffffffffffffn, false);
  dv.setUint32(9, Math.floor(Date.now() / 1000) >>> 0, false);
  dv.setUint16(13, seq0 & 0xffff, false);
  dv.setUint8(15, seq1 & 0xff);
  const headTlv = tlv(TLV_HEAD, head);
  let pdu = tlv(TLV_DEST, dest);
  if (msgClass === MSG_CLASS.P2P) pdu = pdu.concat(tlv(TLV_X04, [0xff, 0x00, 0x00]));
  pdu = pdu.concat(tlv(TLV_DATA, headTlv.concat(Array.from(blob))));
  pdu = pdu.concat(tlv(TLV_TTL, [ttl & 0xff]));
  return pdu;
}

function* tlvRead(data) {
  let i = 0;
  while (i < data.length) {
    if (i + 2 > data.length) break;
    const t = data[i], len = data[i + 1];
    yield [t, data.slice(i + 2, i + 2 + len)];
    i += 2 + len;
  }
}
export function parseMessage(pdu) {
  pdu = pdu instanceof Uint8Array ? pdu : Uint8Array.from(pdu);
  const msg = {};
  for (const [t, value] of tlvRead(pdu)) {
    if (t === TLV_DEST) {
      msg.classId = value[0]; msg.appId = (value[1] << 8) | value[2];
      msg.className = MSG_CLASS_NAME[msg.classId] || "?";
      if ((msg.classId === 0 || msg.classId === 1) && value.length >= 9) {
        let g = 0n; for (let k = 1; k <= 6; k++) g = (g << 8n) | BigInt(value[k]);
        msg.destGid = g;
      }
    } else if (t === TLV_DATA) {
      if (value.length >= 18 && value[0] === TLV_HEAD) {
        const dv = new DataView(value.buffer, value.byteOffset + 2, 16);
        msg.crypt = dv.getUint8(0);
        msg.fromGid = dv.getBigUint64(1, false);
        msg.tstamp = dv.getUint32(9, false);
        let blob = value.slice(18);
        // goTenna-app blobs end in a CRC16; strip only if it checks out AND
        // the remainder is well-formed (a part blob fails the second test).
        if (blob.length >= 2 && crc16(blob.slice(0, -2)) === ((blob[blob.length - 2] << 8) | blob[blob.length - 1])
            && tlvValid(blob.slice(0, -2))) blob = blob.slice(0, -2);
        for (const [bt, bv] of tlvRead(blob)) {
          if (bt === BLOB_TEXT) msg.text = new TextDecoder().decode(bv);
          else if (bt === BLOB_NICK) msg.nick = new TextDecoder().decode(bv);
          else if (bt === BLOB_TYPE) msg.msgType = new TextDecoder().decode(bv);
          else if (bt === TLV_BT_FRAG && bv.length >= 4) msg.frag = [(bv[0] << 8) | bv[1], bv[2], bv[3]];
          else if (bt === TLV_BT_PART) msg.part = Uint8Array.from(bv);
        }
      }
    } else if (t === TLV_HOPS && value.length >= 2) { msg.hops = value[0]; msg.rssi = value[1]; }
    else if (t === TLV_DLR && value.length >= 3) { msg.ackStatus = value[0]; msg.ackMsgId = (value[1] << 8) | value[2]; }
  }
  return msg;
}

export const hex = (bytes) => Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(" ");

// ---------------------------------------------------------------------------
// Backtrail envelope v1 — encryption + long messages (mirrors gt_message.py).
// Short unencrypted messages keep the legacy TYPE/NICK/TEXT blob. Encrypted or
// long messages are split into parts: TYPE("0") | FRAG(id,idx,total) | PART.
// Logical payload: plain 0x01|nickLen|nick|text, or
//                  enc   0x02|keyHint(2)|nonce(12)|AES-256-GCM(plain)+tag
// GCM AAD = "BT1" | fromGid (6 bytes) | msgId (2 bytes).
// ---------------------------------------------------------------------------
const TLV_BT_FRAG = 0xb0, TLV_BT_PART = 0xb1, ENV_PLAIN = 0x01, ENV_ENC = 0x02;
const KDF_SALT = new TextEncoder().encode("backtrail-v1-channel");
const KDF_ITERS = 200000;
export const MAX_BLOB = 225; // 237 TLV ceiling minus 12 B P2P addressing (P2P part at 237 was rejected)
const PART_OVERHEAD = 3 + 6 + 2;
export const MAX_PART = MAX_BLOB - PART_OVERHEAD;
export const MAX_PARTS = 32;
const subtle = () => globalThis.crypto.subtle;

export async function deriveKey(passphrase) {
  const base = await subtle().importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: KDF_SALT, iterations: KDF_ITERS }, base, 256);
  return new Uint8Array(bits);
}
export async function keyHint(raw) {
  return new Uint8Array(await subtle().digest("SHA-256", raw)).slice(0, 2);
}
function aad(fromGid, msgId) {
  const g = BigInt(fromGid) & 0xffffffffffffn, out = [0x42, 0x54, 0x31];
  for (let s = 40n; s >= 0n; s -= 8n) out.push(Number((g >> s) & 0xffn));
  out.push((msgId >> 8) & 0xff, msgId & 0xff);
  return Uint8Array.from(out);
}
export function encodePlain(text, nick = "") {
  const nb = new TextEncoder().encode(nick).slice(0, 64);
  return Uint8Array.from([ENV_PLAIN, nb.length, ...nb, ...new TextEncoder().encode(text)]);
}
// Decode an inner (unencrypted) envelope: plain text (0x01) or rich JSON (0x03).
export function decodePlain(d) {
  if (d.length && d[0] === ENV_RICH) return decodeRich(d);
  if (!d.length || d[0] !== ENV_PLAIN || d.length < 2) throw new Error("not a plain envelope");
  const n = d[1], td = new TextDecoder();
  return { nick: td.decode(d.slice(2, 2 + n)), text: td.decode(d.slice(2 + n)) };
}

// Rich envelope (0x03): compact JSON for messages that carry more than text.
//   {"t": text, "n": nick, "k": kind, "l": [lat, lon, accuracy_m]}  (mirrors gt_message.py)
export const ENV_RICH = 0x03;
export const KINDS = ["sos", "checkin", "loc"];
export function encodeRich(text = "", nick = "", kind = null, loc = null) {
  const d = {};
  if (text) d.t = text;
  if (nick) d.n = nick.slice(0, 64);
  if (kind) { if (!KINDS.includes(kind)) throw new Error("unknown kind " + kind); d.k = kind; }
  if (loc) {
    const l = [Math.round(loc.lat * 1e5) / 1e5, Math.round(loc.lon * 1e5) / 1e5];
    if (loc.acc != null) l.push(Math.round(loc.acc));
    d.l = l;
  }
  return Uint8Array.from([ENV_RICH, ...new TextEncoder().encode(JSON.stringify(d))]);
}
export function decodeRich(data) {
  const d = JSON.parse(new TextDecoder().decode(data.slice(1)));
  const out = { text: d.t || "", nick: d.n || "" };
  if (KINDS.includes(d.k)) out.kind = d.k;
  if (Array.isArray(d.l) && d.l.length >= 2) out.loc = { lat: +d.l[0], lon: +d.l[1], acc: d.l.length > 2 ? +d.l[2] : null };
  return out;
}
async function aesKey(raw, use) { return subtle().importKey("raw", raw, "AES-GCM", false, [use]); }
export async function seal(plain, raw, fromGid, msgId) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(fromGid, msgId) }, await aesKey(raw, "encrypt"), plain));
  return Uint8Array.from([ENV_ENC, ...(await keyHint(raw)), ...nonce, ...ct]);
}
export async function unseal(env, raw, fromGid, msgId) {
  if (env.length < 31 || env[0] !== ENV_ENC) throw new Error("not an encrypted envelope");
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: env.slice(3, 15), additionalData: aad(fromGid, msgId) }, await aesKey(raw, "decrypt"), env.slice(15));
  return new Uint8Array(pt);
}

// Returns { msgId, blobs: [Uint8Array] } — one radio message per blob.
// kind/loc (SOS, check-in, location share) use the rich envelope.
export async function buildParts(text, fromGid, { nick = "", key = null, maxPart = MAX_PART, kind = null, loc = null } = {}) {
  const msgId = globalThis.crypto.getRandomValues(new Uint16Array(1))[0];
  const rich = !!(kind || loc);
  if (!key && !rich && new TextEncoder().encode(text).length <= 255) {
    const legacy = buildBlob(text, nick);
    if (legacy.length <= MAX_BLOB) return { msgId, blobs: [Uint8Array.from(legacy)] };
  }
  let logical = rich ? encodeRich(text, nick, kind, loc) : encodePlain(text, nick);
  if (key) logical = await seal(logical, key, fromGid, msgId);
  const chunks = [];
  for (let i = 0; i < logical.length; i += maxPart) chunks.push(logical.slice(i, i + maxPart));
  if (chunks.length > MAX_PARTS) throw new Error(`message too long (${chunks.length} parts, max ${MAX_PARTS})`);
  const blobs = chunks.map((c, i) => Uint8Array.from([
    ...tlv(BLOB_TYPE, "0"),
    ...tlv(TLV_BT_FRAG, [(msgId >> 8) & 0xff, msgId & 0xff, i, chunks.length]),
    ...tlv(TLV_BT_PART, c),
  ]));
  return { msgId, blobs };
}

export async function decodeLogical(logical, fromGid, msgId, keys) {
  if (logical[0] === ENV_PLAIN || logical[0] === ENV_RICH) return { ...decodePlain(logical), encrypted: false };
  if (logical[0] === ENV_ENC) {
    const hint = logical.slice(1, 3);
    for (const k of keys) {
      const h = await keyHint(k);
      if (h[0] !== hint[0] || h[1] !== hint[1]) continue;
      try { return { ...decodePlain(await unseal(logical, k, fromGid, msgId)), encrypted: true }; }
      catch { break; }
    }
    return { encrypted: true, locked: true, text: null, nick: "" };
  }
  throw new Error("unknown envelope");
}

export class Reassembler {
  constructor(keys = [], ttlMs = 600000) { this.keys = keys; this.ttl = ttlMs; this.pending = new Map(); this.done = new Map(); }
  async add(msg) {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.t > this.ttl) this.pending.delete(k);
    for (const [k, t] of this.done) if (now - t > this.ttl) this.done.delete(k);
    if (!msg.frag) return { ...msg, encrypted: false };
    const [msgId, idx, total] = msg.frag;
    const id = `${msg.fromGid ?? 0}:${msgId}`;
    if (this.done.has(id)) return null; // redundant pass of a finished message
    if (!this.pending.has(id)) this.pending.set(id, { t: now, total, parts: new Map() });
    const slot = this.pending.get(id);
    slot.parts.set(idx, msg.part || new Uint8Array());
    if (slot.parts.size < slot.total) return null;
    this.pending.delete(id);
    this.done.set(id, now);
    const logical = Uint8Array.from([...Array(slot.total).keys()].flatMap((i) => [...slot.parts.get(i)]));
    const { frag, part, ...rest } = msg;
    try { return { ...rest, ...(await decodeLogical(logical, msg.fromGid ?? 0, msgId, this.keys)), parts: total }; }
    catch { return { ...rest, text: null, corrupt: true, parts: total }; }
  }
}

// ---------------------------------------------------------------------------
// Delivery receipts (P2P): the receiving radio returns a DLR TLV whose id is
// GTH16 over the delivered message's 16-byte HEAD struct (mirrors gt_message.py).
// ---------------------------------------------------------------------------
export function gtH16(bytes) {
  let x = 0xaa, h = 0;
  for (const c of bytes) {
    x = Number(((BigInt(x + c) * 48271n + 1n) & 0xffffffffn) % 0x7fffffffn);
    h = (h ^ x) >>> 0;
  }
  return ((h >>> 16) ^ h) & 0xffff;
}
export function messageHash(pdu) {
  const d = pdu instanceof Uint8Array ? pdu : Uint8Array.from(pdu);
  for (const [t, value] of tlvRead(d)) {
    if (t === TLV_DATA && value.length >= 18 && value[0] === TLV_HEAD) return gtH16(value.slice(2, 18));
  }
  return null;
}
export function isReceipt(msg) {
  return msg.ackMsgId != null && msg.text == null && !msg.frag;
}
