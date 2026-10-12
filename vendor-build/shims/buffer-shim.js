// Browser stand-in for Node's global `Buffer`. Only the tslog logger inside
// @meshtastic/core touches it (Buffer.isBuffer while formatting log objects);
// browsers have no Buffers, so the answer is always false.
export const Buffer = globalThis.Buffer || { isBuffer: () => false };
