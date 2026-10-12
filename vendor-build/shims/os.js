// Browser stand-in for node:os (used only by @meshtastic/core's logger).
export const hostname = () => "browser";
export default { hostname };
