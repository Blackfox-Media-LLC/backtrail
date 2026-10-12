// Browser stand-in for node:util (used only by @meshtastic/core's logger).
export const formatWithOptions = (_opts, ...args) =>
  args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
export const types = { isNativeError: (e) => e instanceof Error };
export default { formatWithOptions, types };
