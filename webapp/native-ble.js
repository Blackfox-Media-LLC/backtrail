// Web Bluetooth shim for the Android/iOS app builds.
//
// Android and iOS WebViews have no navigator.bluetooth. In the native apps this
// module installs a small Web Bluetooth-compatible object backed by the
// @capacitor-community/bluetooth-le plugin, so the goTenna driver (ble.js) and
// Meshtastic's official TransportWebBluetooth run unchanged on every platform.
// In a regular browser it does nothing.
//
// Implements only what Backtrail uses: requestDevice(filters, optionalServices),
// gatt.connect/disconnect/connected, getPrimaryService, getCharacteristic,
// readValue, writeValue(+WithResponse/WithoutResponse), start/stopNotifications,
// and the "characteristicvaluechanged" / "gattserverdisconnected" events.

const cap = globalThis.Capacitor;
export const isNative = !!(cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform());

if (isNative && !navigator.bluetooth) {
  const { BleClient, numberToUUID } = await import("./vendor/native.js");
  const uuid = (u) => (typeof u === "number" ? numberToUUID(u) : String(u).toLowerCase());
  const toDataView = (d) =>
    d instanceof DataView ? d
      : ArrayBuffer.isView(d) ? new DataView(d.buffer, d.byteOffset, d.byteLength)
        : new DataView(d);

  let ready = null;
  const init = () => (ready ??= BleClient.initialize({ androidNeverForLocation: true }));

  class Characteristic extends EventTarget {
    constructor(device, serviceUuid, charUuid) {
      super();
      this._device = device;
      this._svc = serviceUuid;
      this.uuid = charUuid;
      this.value = null;
    }
    async readValue() {
      this.value = await BleClient.read(this._device.id, this._svc, this.uuid);
      return this.value;
    }
    async writeValue(data) {
      await BleClient.write(this._device.id, this._svc, this.uuid, toDataView(data));
    }
    writeValueWithResponse(data) { return this.writeValue(data); }
    async writeValueWithoutResponse(data) {
      await BleClient.writeWithoutResponse(this._device.id, this._svc, this.uuid, toDataView(data));
    }
    async startNotifications() {
      await BleClient.startNotifications(this._device.id, this._svc, this.uuid, (value) => {
        this.value = value;
        this.dispatchEvent(new Event("characteristicvaluechanged")); // event.target === this
      });
      return this;
    }
    async stopNotifications() {
      await BleClient.stopNotifications(this._device.id, this._svc, this.uuid).catch(() => {});
      return this;
    }
  }

  class Service {
    constructor(device, serviceUuid) { this.device = device; this.uuid = serviceUuid; }
    async getCharacteristic(c) { return new Characteristic(this.device, this.uuid, uuid(c)); }
  }

  class Server {
    constructor(device) { this.device = device; this.connected = false; }
    async connect() {
      await BleClient.connect(this.device.id, () => this._lost());
      this.connected = true;
      return this;
    }
    disconnect() {
      BleClient.disconnect(this.device.id).catch(() => {});
      this._lost();
    }
    _lost() {
      if (!this.connected) return; // fire once, whether we or the radio ended it
      this.connected = false;
      this.device.dispatchEvent(new Event("gattserverdisconnected"));
    }
    async getPrimaryService(s) { return new Service(this.device, uuid(s)); }
  }

  class Device extends EventTarget {
    constructor(id, name) { super(); this.id = id; this.name = name || ""; this.gatt = new Server(this); }
  }

  Object.defineProperty(navigator, "bluetooth", {
    configurable: true,
    value: {
      async requestDevice(options = {}) {
        await init();
        const services = [];
        for (const f of options.filters || []) for (const s of f.services || []) services.push(uuid(s));
        const optionalServices = (options.optionalServices || []).map(uuid);
        const d = await BleClient.requestDevice({ services, optionalServices });
        return new Device(d.deviceId, d.name);
      },
      async getAvailability() {
        await init();
        return BleClient.isEnabled();
      },
    },
  });
}
