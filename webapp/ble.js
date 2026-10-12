// Web Bluetooth driver for goTenna Mesh — mirrors gotenna.py's GoTenna class.
import * as gt from "./gt.js";

const CMD_SERVICE = "1276aaee-df5e-11e6-bf01-fe55135034f3";
const ST_UUID = "12762b18-df5e-11e6-bf01-fe55135034f3";
const TX_UUID = "1276b20a-df5e-11e6-bf01-fe55135034f3";
const RX_UUID = "1276b20b-df5e-11e6-bf01-fe55135034f3";
const DIS_SERVICE = 0x180a;
const REDUNDANT_PASSES = 2; // transmissions per part for multi-part messages
const PART_GAP_MS = 2500;   // gap between radio messages
const ACK_WAIT_MS = 20000;  // direct messages: wait for receipts per round
const P2P_RETRIES = 2;      // direct messages: resend rounds for unconfirmed parts

export class GoTenna extends EventTarget {
  constructor() {
    super();
    this.seq = 0;
    this.asm = new gt.FrameAssembler();
    this.waiters = new Map();
    this.mwi = null;
    this.device = null;
    this.receipts = new Set(); // receipt ids seen in the inbox
  }

  get connected() { return !!(this.device && this.device.gatt && this.device.gatt.connected); }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [CMD_SERVICE] }],
      optionalServices: [CMD_SERVICE, DIS_SERVICE],
    });
    this.device.addEventListener("gattserverdisconnected", () =>
      this.dispatchEvent(new Event("disconnected")));
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(CMD_SERVICE);
    this.tx = await svc.getCharacteristic(TX_UUID);
    this.rx = await svc.getCharacteristic(RX_UUID);
    this.st = await svc.getCharacteristic(ST_UUID);

    await this.rx.startNotifications();
    this.rx.addEventListener("characteristicvaluechanged", (e) => {
      const bytes = new Uint8Array(e.target.value.buffer);
      for (const payload of this.asm.feed(bytes)) {
        if (payload.length >= 2) {
          const w = this.waiters.get(payload[1]);
          if (w) { this.waiters.delete(payload[1]); w(payload); }
        }
      }
    });
    try {
      await this.st.startNotifications();
      this.st.addEventListener("characteristicvaluechanged", (e) => {
        const v = new Uint8Array(e.target.value.buffer);
        if (v.length) {
          const n = v[0];
          if (this.mwi !== null && n !== this.mwi) this.dispatchEvent(new Event("mail"));
          this.mwi = n;
        }
      });
      // Seed the message-waiting value so the first change is detected.
      const seed = new Uint8Array((await this.st.readValue()).buffer);
      if (seed.length && this.mwi === null) this.mwi = seed[0];
    } catch { /* status notify optional; the app also polls */ }

    this.server = server;
    this.dispatchEvent(new Event("connected"));
    return await this.deviceInfo();
  }

  async disconnect() { if (this.connected) this.device.gatt.disconnect(); }

  nextSeq() {
    this.seq = (this.seq + 1) & 0xff;
    if (this.seq === 0x10) this.seq = 0x11;
    if (this.seq === 0x00) this.seq = 0x01;
    return this.seq;
  }

  async execute(opcode, data = [], timeout = 6000) {
    const seq = this.nextSeq();
    const frame = gt.buildFrame(opcode, seq, data);
    const reply = new Promise((resolve, reject) => {
      this.waiters.set(seq, resolve);
      setTimeout(() => { if (this.waiters.delete(seq)) reject(new Error("timeout")); }, timeout);
    });
    for (let i = 0; i < frame.length; i += 20) {
      await this.tx.writeValueWithoutResponse(frame.slice(i, i + 20));
    }
    return gt.parseReply(opcode, await reply);
  }

  async deviceInfo() {
    const info = {};
    try {
      const dis = await this.server.getPrimaryService(DIS_SERVICE);
      const reads = { manufacturer: 0x2a29, model: 0x2a24, hwRev: 0x2a27, fwRev: 0x2a26 };
      for (const [k, uuid] of Object.entries(reads)) {
        try { info[k] = new TextDecoder().decode((await (await dis.getCharacteristic(uuid)).readValue()).buffer); }
        catch { /* skip */ }
      }
    } catch { /* no DIS */ }
    try {
      const r = await this.execute(gt.OP.SYSINFO);
      const txt = new TextDecoder().decode(r.data);
      const m = txt.match(/[ -~]{4,}/);
      if (m) info.serial = m[0];
      info.battery = r.data.length > 5 ? r.data[5] : null; // best-effort
    } catch { /* skip */ }
    try { info.region = await this.getRegion(); } catch { /* skip */ }
    return info;
  }

  async getRegion() { return gt.regionFromReply((await this.execute(gt.OP.GET_GEO)).data); }
  async setRegion(id) { return (await this.execute(gt.OP.SET_GEO, gt.regionSetData(id))).success; }
  // Program the radio's address (class, app ID, GID, tag) so it receives direct
  // messages sent to `gid`. OP_SET_GID payload is 10 bytes.
  async setIdentity(gid, appId = gt.DEFAULT_APP_ID) {
    const g = BigInt(gid) & 0xffffffffffffn, data = [0x00, (appId >> 8) & 0xff, appId & 0xff];
    for (let s = 40n; s >= 0n; s -= 8n) data.push(Number((g >> s) & 0xffn));
    data.push(0x00);
    return (await this.execute(gt.OP.SET_GID, data)).success;
  }

  // Send text, encrypted if `key` is given, split into parts if long.
  // onProgress(done, total) is called after each radio transmission.
  // Returns { ok, sent, total, delivered }: delivered is null for shouts (no
  // receipts exist) and true/false for direct messages.
  // kind/loc ("sos" | "checkin" | "loc", {lat, lon, acc}) send a rich message;
  // an SOS shout uses TTL 3 so other goTennas relay it further.
  async send(text, fromGid, { nick = "", toGid = null, key = null, kind = null, loc = null, onProgress = null } = {}) {
    const { msgId, blobs } = await gt.buildParts(text, fromGid, { nick, key, kind, loc });
    const opts = toGid ? { msgClass: gt.MSG_CLASS.P2P, destGid: toGid }
      : { msgClass: gt.MSG_CLASS.SHOUT, ...(kind === "sos" ? { ttl: 3 } : {}) };
    // seq0/seq1 = msg id / part index make every part's HEAD (and receipt id) unique
    const pdus = blobs.map((b, i) => gt.buildMessageBlob(b, fromGid, { ...opts, seq0: msgId, seq1: i }));
    if (toGid) return this.sendWithReceipts(pdus, onProgress);
    // Shouts have no receipts. Over-the-air loss measured ~1 in 5, so encrypted/
    // multi-part shouts (which carry a msgId, making repeats safe) go out in
    // REDUNDANT_PASSES passes; legacy plain singles have no id and go once.
    const passes = blobs.length > 1 || key || kind ? REDUNDANT_PASSES : 1;
    const sends = [];
    for (let p = 0; p < passes; p++) pdus.forEach((d, i) => sends.push([i, d]));
    for (let n = 0; n < sends.length; n++) {
      const [i, d] = sends[n];
      const r = await this.execute(gt.OP.SENDMSG, d, 8000);
      if (!r.success) return { ok: false, sent: i, total: pdus.length, delivered: null };
      if (onProgress) onProgress(n + 1, sends.length);
      if (n < sends.length - 1) await sleep(PART_GAP_MS);
    }
    return { ok: true, sent: pdus.length, total: pdus.length, delivered: null };
  }

  // Direct messages: send each part, then resend only parts with no receipt.
  // Receipts are intercepted in drainInbox(); we fire "mail" so the app's
  // serialized inbox reader runs (no concurrent inbox access).
  async sendWithReceipts(pdus, onProgress) {
    const want = new Map(pdus.map((d, i) => [gt.messageHash(d), i]));
    let todo = pdus.map((_, i) => i);
    for (let attempt = 0; attempt <= P2P_RETRIES; attempt++) {
      for (let n = 0; n < todo.length; n++) {
        const r = await this.execute(gt.OP.SENDMSG, pdus[todo[n]], 8000);
        if (!r.success) return { ok: false, sent: todo[n], total: pdus.length, delivered: false };
        if (onProgress && attempt === 0) onProgress(n + 1, pdus.length);
        if (n < todo.length - 1) await sleep(PART_GAP_MS);
      }
      const until = Date.now() + ACK_WAIT_MS;
      while (want.size && Date.now() < until) {
        for (const id of [...want.keys()]) if (this.receipts.has(id)) { want.delete(id); this.receipts.delete(id); }
        if (!want.size) break;
        this.dispatchEvent(new Event("mail"));
        await sleep(2000);
      }
      if (!want.size) return { ok: true, sent: pdus.length, total: pdus.length, delivered: true };
      todo = [...want.values()].sort((a, b) => a - b);
    }
    return { ok: true, sent: pdus.length, total: pdus.length, delivered: false };
  }

  async readMessage() { return await this.execute(gt.OP.READMSG); }
  async nextMessage() { return await this.execute(gt.OP.NEXTMSG); }

  // Returns received messages; delivery receipts are recorded in this.receipts
  // (consumed by sendWithReceipts) rather than returned.
  async drainInbox() {
    const out = [];
    for (;;) {
      const r = await this.readMessage();
      if (!r.success || r.data.length === 0) break;
      try {
        const msg = gt.parseMessage(r.data);
        if (gt.isReceipt(msg)) this.receipts.add(msg.ackMsgId);
        else out.push(msg);
      } catch { out.push({ raw: gt.hex(r.data) }); }
      await this.nextMessage();
    }
    return out;
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
