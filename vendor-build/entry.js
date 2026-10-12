// Bundle entry for Backtrail's Meshtastic support (GPL-3.0, like Meshtastic).
// Rebuild: cd vendor-build && npm install && npm run build
export { MeshDevice, Types, Protobuf } from "@meshtastic/core";
export { TransportWebBluetooth } from "@meshtastic/transport-web-bluetooth";
export { TransportWebSerial } from "@meshtastic/transport-web-serial";
// protobuf-es runtime (Apache-2.0): build messages for setOwner/setConfig/channel URLs.
export { create, toBinary, fromBinary } from "@bufbuild/protobuf";
