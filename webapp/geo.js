// Location: current position, breadcrumb recording, distance/bearing math,
// compass heading, and GPX export. Foreground only: Backtrail never tracks
// location in the background, and nothing leaves the device unless the user
// sends it (a location share, SOS, or check-in).
import { isNative } from "./native-ble.js";

// Resolve the module, not the plugin: a Capacitor plugin proxy must never be
// the resolved value of a promise (awaiting it calls a native "then" method).
let mod = null;
async function plugin() {
  if (!isNative) return null;
  mod ??= await import("./vendor/native.js");
  return { get: () => mod.Geolocation };
}

export async function ensurePermission() {
  const p = await plugin();
  if (!p) return true;
  const g = p.get();
  const st = await g.checkPermissions();
  if (st.location === "granted" || st.coarseLocation === "granted") return true;
  const r = await g.requestPermissions({ permissions: ["location"] });
  return r.location === "granted" || r.coarseLocation === "granted";
}

const shape = (c) => ({ lat: c.latitude, lon: c.longitude, acc: c.accuracy ?? null, alt: c.altitude ?? null, ts: Date.now() });

// One position fix. Throws if permission is denied or no fix arrives in time.
export async function currentPosition({ timeout = 20000 } = {}) {
  const p = await plugin(), g = p && p.get();
  if (g) {
    if (!(await ensurePermission())) throw new Error("Location permission denied");
    const p = await g.getCurrentPosition({ enableHighAccuracy: true, timeout, maximumAge: 10000 });
    return shape(p.coords);
  }
  if (!navigator.geolocation) throw new Error("Location is not available on this device");
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    (p) => resolve(shape(p.coords)), (e) => reject(new Error(e.message || "No location fix")),
    { enableHighAccuracy: true, timeout, maximumAge: 10000 }));
}

// Continuous updates (breadcrumbs). Returns a stop() function.
export async function watch(onPoint, onError = () => {}) {
  const p = await plugin(), g = p && p.get();
  if (g) {
    if (!(await ensurePermission())) throw new Error("Location permission denied");
    const id = await g.watchPosition({ enableHighAccuracy: true, timeout: 30000, maximumAge: 5000 },
      (p, err) => { if (err) onError(err); else if (p) onPoint(shape(p.coords)); });
    return () => g.clearWatch({ id });
  }
  if (!navigator.geolocation) throw new Error("Location is not available on this device");
  const id = navigator.geolocation.watchPosition((p) => onPoint(shape(p.coords)),
    (e) => onError(e), { enableHighAccuracy: true, maximumAge: 5000 });
  return () => navigator.geolocation.clearWatch(id);
}

// ---- math ----
const R = 6371008.8, rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
export function cardinal(b) { return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(b / 45) % 8]; }
// US customary units (miles/feet), matching the app's US English audience.
export function formatDistance(m) {
  if (m == null || !isFinite(m)) return "—";
  const ft = m * 3.28084;
  if (ft < 1000) return Math.round(ft) + " ft";
  return (m / 1609.344).toFixed(m < 16093 ? 2 : 1) + " mi";
}
export function trackLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += distance(points[i - 1], points[i]);
  return d;
}

// ---- compass (device heading in degrees, clockwise from north) ----
export function watchHeading(onHeading) {
  const handler = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;          // iOS
    else if (e.absolute && typeof e.alpha === "number") h = (360 - e.alpha) % 360;       // Android
    if (h != null) onHeading(h);
  };
  const ev = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
  window.addEventListener(ev, handler);
  return () => window.removeEventListener(ev, handler);
}

// ---- GPX export ----
export function toGpx(points, name = "Backtrail") {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const pts = points.map((p) => `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">` +
    (p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : "") + `<time>${new Date(p.ts).toISOString()}</time></trkpt>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Backtrail" xmlns="http://www.topografix.com/GPX/1/1">` +
    `<trk><name>${esc(name)}</name><trkseg>${pts}</trkseg></trk></gpx>\n`;
}
