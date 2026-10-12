// Browser stand-in for Node's global `process` (read by @meshtastic/core's
// logger and protobuf runtime). Injected by esbuild wherever `process` is used.
export const process = globalThis.process || { env: {}, cwd: () => "/" };
