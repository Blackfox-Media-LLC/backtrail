// Meshtastic adapter for Backtrail (Web Bluetooth / Web Serial / native shim),
// built on the official @meshtastic/core library (GPL-3.0), bundled in
// vendor/meshtastic.js together with the protobuf-es runtime.
//
// Events dispatched (CustomEvent .detail):
//   "connected" {info} | "disconnected" {} | "message" {net, from, fromName, to, direct,
//   channel, text, rxTime, snr, rssi, hops} | "nodes" {count} | "channels" {} |
//   "config" {} | "position" {num} | "telemetry" {num}
import {
  MeshDevice, TransportWebBluetooth, TransportWebSerial, Protobuf, create, toBinary, fromBinary,
} from "./vendor/meshtastic.js";

export const usbSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

const STATUS_CONFIGURED = 7;
const STATUS_DISCONNECTED = 2;
export const MAX_TEXT_BYTES = 200;  // Meshtastic text payloads top out a little above this
const DIRECT_ACK_MS = 60000;        // firmware retries a direct message for ~30-45 s
// Broadcasts get no ACK unless another node rebroadcasts them, so the library's
// send never resolves on a quiet mesh. The radio transmits immediately; wait
// briefly for an error and otherwise treat the message as sent.
const BROADCAST_WAIT_MS = 3000;
const ADMIN_WAIT_MS = 8000;         // config/owner writes to our own radio
const BROADCAST = 0xffffffff;

const PB = Protobuf;
const enumName = (en, v) => (en && en[v] !== undefined ? String(en[v]) : String(v));
export const nodeId = (num) => "!" + (num >>> 0).toString(16).padStart(8, "0");
export function parseNodeId(s) {
  const t = String(s || "").trim().toLowerCase().replace(/^!/, "");
  if (/^[0-9a-f]{1,8}$/.test(t)) return parseInt(t, 16) >>> 0;
  if (/^\d+$/.test(t)) return Number(t) >>> 0;
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const race = (p, ms, fallback = "timeout") =>
  Promise.race([p.then(() => "ok", (e) => e), sleep(ms).then(() => fallback)]);

// Split text into Meshtastic-sized chunks, prefixing "(i/n) " when split.
export function splitText(text, maxBytes = MAX_TEXT_BYTES) {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return [text];
  const room = maxBytes - 8;
  const chunks = [];
  let cur = "";
  for (const ch of text) {
    if (enc.encode(cur + ch).length > room) { chunks.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) chunks.push(cur);
  return chunks.map((c, i) => `(${i + 1}/${chunks.length}) ${c}`);
}

const posFrom = (p) => (p && (p.latitudeI || p.longitudeI))
  ? { lat: p.latitudeI * 1e-7, lon: p.longitudeI * 1e-7, alt: p.altitude || null, time: p.time || null }
  : null;

export class MeshtasticRadio extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.myNodeNum = null;
    this.nodes = new Map();     // num -> node record (see _node)
    this.channels = new Map();  // index -> {index, name, role, psk}
    this.config = {};           // { lora, device, position, ... } as received
    this.metadata = null;
    this.connected = false;
    this._rx = new Map();       // packet id -> {snr, rssi, hops}
    this._trace = new Map();    // node num -> resolve(route)
  }

  _node(num) {
    if (!this.nodes.has(num)) {
      this.nodes.set(num, { num, id: nodeId(num), longName: "", shortName: "", hwModel: "", role: "",
        lastHeard: null, snr: null, rssi: null, hops: null, position: null,
        battery: null, voltage: null, chUtil: null, airUtil: null, env: null });
    }
    return this.nodes.get(num);
  }
  nameOf(num) {
    const n = this.nodes.get(num);
    return (n && (n.shortName || n.longName)) || nodeId(num);
  }
  _emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // via: "bluetooth" | "usb". `transport` lets tests inject any Meshtastic transport.
  async connect({ via = "bluetooth", transport = null, timeoutMs = 45000 } = {}) {
    transport = transport || (via === "usb"
      ? await TransportWebSerial.create(115200)
      : await TransportWebBluetooth.create());
    this.via = via;
    const device = new MeshDevice(transport);
    // The library logs every packet at trace level; keep warnings and errors only.
    if (device.log && device.log.settings) device.log.settings.minLevel = 4;
    this.device = device;
    const ev = device.events;

    ev.onMyNodeInfo.subscribe((info) => { this.myNodeNum = info.myNodeNum; });
    ev.onNodeInfoPacket.subscribe((ni) => {
      const n = this._node(ni.num), u = ni.user || {};
      n.longName = u.longName || n.longName;
      n.shortName = u.shortName || n.shortName;
      if (u.hwModel !== undefined) n.hwModel = enumName(PB.Mesh.HardwareModel, u.hwModel);
      if (u.role !== undefined) n.role = enumName(PB.Config.Config_DeviceConfig_Role, u.role);
      if (ni.lastHeard) n.lastHeard = ni.lastHeard;
      if (ni.snr) n.snr = ni.snr;
      if (ni.hopsAway !== undefined) n.hops = ni.hopsAway;
      const pos = posFrom(ni.position); if (pos) n.position = pos;
      const dm = ni.deviceMetrics;
      if (dm) { n.battery = dm.batteryLevel ?? n.battery; n.voltage = dm.voltage ?? n.voltage; n.chUtil = dm.channelUtilization ?? n.chUtil; n.airUtil = dm.airUtilTx ?? n.airUtil; }
      this._emit("nodes", { count: this.nodes.size });
    });
    ev.onMeshPacket.subscribe((p) => {
      if (p.from === undefined) return;
      const n = this._node(p.from);
      n.lastHeard = p.rxTime || Math.floor(Date.now() / 1000);
      if (p.rxSnr) n.snr = p.rxSnr;
      if (p.rxRssi) n.rssi = p.rxRssi;
      if (p.hopStart) n.hops = p.hopStart - p.hopLimit;
      this._rx.set(p.id, { snr: p.rxSnr || null, rssi: p.rxRssi || null, hops: p.hopStart ? p.hopStart - p.hopLimit : null });
      if (this._rx.size > 300) this._rx.delete(this._rx.keys().next().value);
    });
    ev.onPositionPacket.subscribe((p) => {
      const pos = posFrom(p.data); if (!pos) return;
      this._node(p.from).position = pos;
      this._emit("position", { num: p.from });
      this._emit("nodes", { count: this.nodes.size });
    });
    ev.onTelemetryPacket.subscribe((p) => {
      const n = this._node(p.from), v = p.data && p.data.variant;
      if (!v) return;
      if (v.case === "deviceMetrics") {
        const d = v.value; n.battery = d.batteryLevel ?? n.battery; n.voltage = d.voltage ?? n.voltage;
        n.chUtil = d.channelUtilization ?? n.chUtil; n.airUtil = d.airUtilTx ?? n.airUtil;
      } else if (v.case === "environmentMetrics") {
        const e = v.value; n.env = { temp: e.temperature, humidity: e.relativeHumidity, pressure: e.barometricPressure };
      }
      this._emit("telemetry", { num: p.from });
      this._emit("nodes", { count: this.nodes.size });
    });
    ev.onChannelPacket.subscribe((c) => {
      const s = c.settings || {};
      this.channels.set(c.index, { index: c.index, role: c.role, psk: s.psk,
        name: s.name || (c.role === 1 ? "Primary" : "Channel " + c.index), settings: s });
      this._emit("channels");
    });
    ev.onConfigPacket.subscribe((cfg) => {
      const v = cfg.payloadVariant; if (v && v.case) { this.config[v.case] = v.value; this._emit("config"); }
    });
    ev.onDeviceMetadataPacket.subscribe((p) => { this.metadata = p.data; });
    ev.onTraceRoutePacket.subscribe((p) => {
      const w = this._trace.get(p.from);
      if (w) { this._trace.delete(p.from); w({ route: [...(p.data.route || [])], snrTowards: [...(p.data.snrTowards || [])].map((x) => x / 4) }); }
    });
    ev.onUserPacket.subscribe((p) => {
      const n = this._node(p.from), u = p.data || {};
      n.longName = u.longName || n.longName; n.shortName = u.shortName || n.shortName;
      this._emit("nodes", { count: this.nodes.size });
    });
    ev.onMessagePacket.subscribe((p) => {
      if (p.from === this.myNodeNum) return; // our own echo
      const rx = this._rx.get(p.id) || {};
      this._emit("message", {
        net: "meshtastic", from: p.from, fromName: this.nameOf(p.from), to: p.to,
        direct: p.type === "direct", channel: p.channel, text: p.data, rxTime: p.rxTime, ...rx,
      });
    });

    const configured = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Meshtastic radio did not finish configuring")), timeoutMs);
      ev.onDeviceStatus.subscribe((s) => {
        if (s === STATUS_CONFIGURED) { clearTimeout(t); resolve(); }
        if (s === STATUS_DISCONNECTED && this.connected) {
          clearInterval(device._heartbeatIntervalId); // radio went away on its own
          this.connected = false; this._emit("disconnected");
        }
      });
    });
    // configure() awaits an ACK the radio never sends (library times out at
    // ~60 s), so don't await it: the "configured" status is the signal.
    device.configure().catch(() => {});
    await configured;
    this.connected = true;
    // Keep-alive like the official Meshtastic apps, so a radio with "sleep when
    // idle" stays awake while Backtrail is connected; it sleeps after we leave.
    try { device.setHeartbeatInterval(60000); } catch { /* older library */ }
    const info = this.info();
    this._emit("connected", { info });
    return info;
  }

  info() {
    const me = this.nodes.get(this.myNodeNum) || {};
    const lora = this.config.lora || {}, dev = this.config.device || {};
    return {
      nodeNum: this.myNodeNum, nodeId: this.myNodeNum != null ? nodeId(this.myNodeNum) : "—",
      longName: me.longName || "—", shortName: me.shortName || "—", hwModel: me.hwModel || "",
      firmware: this.metadata ? this.metadata.firmwareVersion : "",
      region: enumName(PB.Config.Config_LoRaConfig_RegionCode, lora.region),
      preset: enumName(PB.Config.Config_LoRaConfig_ModemPreset, lora.modemPreset),
      role: enumName(PB.Config.Config_DeviceConfig_Role, dev.role),
      battery: me.battery, voltage: me.voltage, knownNodes: this.nodes.size,
    };
  }

  nodesList() {
    return [...this.nodes.values()].filter((n) => n.num !== this.myNodeNum)
      .sort((a, b) => (b.lastHeard || 0) - (a.lastHeard || 0));
  }
  channelsList() {
    return [...this.channels.values()].filter((c) => c.role !== 0).sort((a, b) => a.index - b.index);
  }

  // Broadcast on a channel, or send direct to a node number. Direct messages
  // request an ACK; delivered is true/false for direct, null for broadcast.
  async send(text, { to = null, channel = 0, onProgress = null } = {}) {
    if (!this.device) throw new Error("Meshtastic radio not connected");
    const parts = splitText(text);
    let delivered = to != null ? true : null;
    for (let i = 0; i < parts.length; i++) {
      const sent = this.device.sendText(parts[i], to != null ? to : "broadcast", to != null, channel);
      const outcome = await race(sent, to != null ? DIRECT_ACK_MS : BROADCAST_WAIT_MS);
      if (to != null && outcome !== "ok") delivered = false;
      else if (to == null && outcome instanceof Error) throw outcome;
      if (onProgress) onProgress(i + 1, parts.length);
    }
    return { ok: true, total: parts.length, delivered };
  }

  // Share a position with the mesh right now (broadcast POSITION_APP packet).
  async sharePosition(lat, lon, { alt = null, channel = 0 } = {}) {
    if (!this.device) throw new Error("Meshtastic radio not connected");
    const pos = create(PB.Mesh.PositionSchema, {
      latitudeI: Math.round(lat / 1e-7), longitudeI: Math.round(lon / 1e-7),
      altitude: alt != null ? Math.round(alt) : undefined, time: Math.floor(Date.now() / 1000),
    });
    const bin = toBinary(PB.Mesh.PositionSchema, pos);
    await race(this.device.sendPacket(bin, PB.Portnums.PortNum.POSITION_APP, "broadcast", channel, false, false), BROADCAST_WAIT_MS);
    // Also tell our own radio where it is (it rebroadcasts on its schedule).
    race(this.device.setPosition(pos), ADMIN_WAIT_MS).catch(() => {});
  }

  async requestPosition(num) {
    await race(this.device.requestPosition(num), BROADCAST_WAIT_MS);
  }

  // Traceroute: resolves {route:[nums], snrTowards:[dB]} or null on timeout.
  async traceroute(num, timeoutMs = 60000) {
    const reply = new Promise((resolve) => this._trace.set(num, resolve));
    race(this.device.traceRoute(num), 2000).catch(() => {});
    const r = await Promise.race([reply, sleep(timeoutMs).then(() => null)]);
    this._trace.delete(num);
    return r;
  }

  async setOwner(longName, shortName) {
    const u = create(PB.Mesh.UserSchema, { longName: longName.slice(0, 39), shortName: shortName.slice(0, 4) });
    await race(this.device.setOwner(u), ADMIN_WAIT_MS);
    const n = this._node(this.myNodeNum); n.longName = u.longName; n.shortName = u.shortName;
    this._emit("nodes", { count: this.nodes.size });
  }

  // Change LoRa config fields (region / modemPreset / hopLimit ...), keeping the rest.
  async updateLora(changes) { return this._writeConfig("lora", PB.Config.Config_LoRaConfigSchema, changes); }
  async updatePower(changes) { return this._writeConfig("power", PB.Config.Config_PowerConfigSchema, changes); }
  async updateDevice(changes) { return this._writeConfig("device", PB.Config.Config_DeviceConfigSchema, changes); }
  async _writeConfig(kind, schema, changes) {
    const current = this.config[kind];
    if (!current) throw new Error(`no ${kind} config received from the radio yet`);
    const value = create(schema, { ...current, ...changes });
    const cfg = create(PB.Config.ConfigSchema, { payloadVariant: { case: kind, value } });
    await race(this.device.setConfig(cfg), ADMIN_WAIT_MS);
    await race(this.device.commitEditSettings(), ADMIN_WAIT_MS);
    this.config[kind] = value;
    this._emit("config");
  }

  // Standard Meshtastic channel-share link (scannable by the Meshtastic app).
  channelUrl() {
    const settings = this.channelsList().map((c) => c.settings).filter(Boolean);
    const set = create(PB.AppOnly.ChannelSetSchema, { settings, loraConfig: this.config.lora });
    const bin = toBinary(PB.AppOnly.ChannelSetSchema, set);
    let b64 = btoa(String.fromCharCode(...bin));
    b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return "https://meshtastic.org/e/#" + b64;
  }

  // Apply a Meshtastic channel link (https://meshtastic.org/e/#...): replaces
  // the radio's channels and LoRa settings, exactly like the Meshtastic app.
  static decodeChannelUrl(url) {
    let b64 = String(url).split("#")[1] || "";
    b64 = b64.split("?")[0].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return fromBinary(PB.AppOnly.ChannelSetSchema, bin);
  }
  async importChannelUrl(url) {
    const set = MeshtasticRadio.decodeChannelUrl(url);
    if (!set.settings.length) throw new Error("that link has no channels");
    for (let i = 0; i < 8; i++) {
      const settings = set.settings[i];
      const ch = create(PB.Channel.ChannelSchema, settings
        ? { index: i, role: i === 0 ? 1 : 2, settings }
        : { index: i, role: 0 });
      await race(this.device.setChannel(ch), ADMIN_WAIT_MS);
      this.channels.set(i, { index: i, role: ch.role, psk: settings?.psk,
        name: settings?.name || (i === 0 ? "Primary" : "Channel " + i), settings });
    }
    if (set.loraConfig) {
      const value = create(PB.Config.Config_LoRaConfigSchema, { ...(this.config.lora || {}), ...set.loraConfig });
      await race(this.device.setConfig(create(PB.Config.ConfigSchema, { payloadVariant: { case: "lora", value } })), ADMIN_WAIT_MS);
      this.config.lora = value;
    }
    await race(this.device.commitEditSettings(), ADMIN_WAIT_MS);
    this._emit("channels"); this._emit("config");
    return set.settings.length;
  }

  async reboot(seconds = 2) { await race(this.device.reboot(seconds), ADMIN_WAIT_MS); }

  async disconnect() {
    // The transport's close can hang; never let it freeze the UI.
    try {
      await Promise.race([this.device?.disconnect(), sleep(3000)]);
    } catch { /* already gone */ } finally {
      this.connected = false;
      this._emit("disconnected");
    }
  }
}

export const meshEnums = {
  regions: PB.Config.Config_LoRaConfig_RegionCode,
  presets: PB.Config.Config_LoRaConfig_ModemPreset,
  roles: PB.Config.Config_DeviceConfig_Role,
};
