// Map view. Default is an offline "radar": you at the center, people and
// Meshtastic nodes plotted by distance and bearing, your breadcrumb trail, and
// distance rings. It needs no internet. The optional street map (Leaflet +
// OpenStreetMap tiles) downloads map images, so it is off unless the user
// turns it on in Settings.
import { distance, bearing, formatDistance, cardinal } from "./geo.js";

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
const NICE = [30, 60, 150, 300, 600, 1500, 3000, 6000, 15000, 30000, 60000, 150000, 300000];

// points: [{id, lat, lon, label, type: "contact"|"node"|"sos"|"start", ts}]
export class RadarView {
  constructor(canvas, onPick) {
    this.c = canvas; this.onPick = onPick;
    this.me = null; this.points = []; this.track = []; this.heading = null; this.selected = null;
    this._hits = [];
    canvas.addEventListener("click", (e) => this._click(e));
    new ResizeObserver(() => this.draw()).observe(canvas);
  }
  set(data) { Object.assign(this, data); this.draw(); }

  _project(center, scale, w, h) {
    // Equirectangular projection around the center: good to a few hundred km.
    const kx = Math.cos((center.lat * Math.PI) / 180) * 111320, ky = 110540;
    return (p) => ({ x: w / 2 + (p.lon - center.lon) * kx * scale, y: h / 2 - (p.lat - center.lat) * ky * scale });
  }

  draw() {
    const c = this.c, dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const muted = css("--muted"), border = css("--border"), accent = css("--accent"), sun = css("--sun"), danger = css("--danger"), text = css("--text");
    const all = [...this.points, ...this.track];
    const center = this.me || (all.length ? all[all.length - 1] : null);
    this._hits = [];
    const R = Math.min(w, h) / 2 - 18;
    if (!center) {
      g.fillStyle = muted; g.font = "14px system-ui, sans-serif"; g.textAlign = "center";
      g.fillText("Waiting for a location fix…", w / 2, h / 2);
      return;
    }
    // Pick a ring radius that fits the farthest point.
    let far = 0;
    for (const p of all) far = Math.max(far, distance(center, p));
    const ring = NICE.find((n) => n * 3 >= far * 1.1) || NICE[NICE.length - 1];
    const scale = R / (ring * 3);
    const P = this._project(center, scale, w, h);

    // rings
    g.strokeStyle = border; g.lineWidth = 1; g.fillStyle = muted; g.font = "11px system-ui, sans-serif"; g.textAlign = "left";
    for (let i = 1; i <= 3; i++) {
      g.beginPath(); g.arc(w / 2, h / 2, R * i / 3, 0, Math.PI * 2); g.stroke();
      g.fillText(formatDistance(ring * i), w / 2 + 4, h / 2 - R * i / 3 + 13);
    }
    g.beginPath(); g.moveTo(w / 2 - R, h / 2); g.lineTo(w / 2 + R, h / 2); g.moveTo(w / 2, h / 2 - R); g.lineTo(w / 2, h / 2 + R);
    g.setLineDash([3, 5]); g.stroke(); g.setLineDash([]);
    g.fillStyle = text; g.font = "bold 13px system-ui, sans-serif"; g.textAlign = "center";
    g.fillText("N", w / 2, h / 2 - R - 4);

    // breadcrumb trail
    if (this.track.length > 1) {
      g.strokeStyle = sun; g.lineWidth = 3; g.lineJoin = g.lineCap = "round"; g.globalAlpha = .85;
      g.beginPath();
      this.track.forEach((p, i) => { const q = P(p); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
      g.stroke(); g.globalAlpha = 1;
    }
    // points
    const now = Date.now();
    for (const p of this.points) {
      const q = P(p);
      const color = p.type === "sos" ? danger : p.type === "start" ? sun : p.type === "node" ? "#6fb3e0" : accent;
      const stale = p.ts && now - p.ts > 3600e3;
      g.globalAlpha = stale ? .5 : 1;
      g.fillStyle = color;
      if (p.type === "start") {
        g.fillRect(q.x - 1, q.y - 14, 2, 14); g.beginPath(); g.moveTo(q.x + 1, q.y - 14); g.lineTo(q.x + 11, q.y - 10); g.lineTo(q.x + 1, q.y - 6); g.fill();
      } else {
        g.beginPath(); g.arc(q.x, q.y, p === this.selected ? 9 : 7, 0, Math.PI * 2); g.fill();
        g.strokeStyle = css("--bg"); g.lineWidth = 2; g.stroke();
        if (p.type === "sos") { g.strokeStyle = danger; g.lineWidth = 2; g.beginPath(); g.arc(q.x, q.y, 14, 0, Math.PI * 2); g.stroke(); }
      }
      g.fillStyle = text; g.font = "12px system-ui, sans-serif"; g.textAlign = "center";
      if (p.label) g.fillText(p.label, q.x, q.y + 20);
      g.globalAlpha = 1;
      this._hits.push({ p, x: q.x, y: q.y });
    }
    // you
    if (this.me) {
      g.save(); g.translate(w / 2, h / 2);
      if (this.heading != null) {
        g.rotate((this.heading * Math.PI) / 180);
        g.fillStyle = accent; g.beginPath(); g.moveTo(0, -14); g.lineTo(8, 9); g.lineTo(0, 4); g.lineTo(-8, 9); g.closePath(); g.fill();
      } else {
        g.fillStyle = "#fff"; g.beginPath(); g.arc(0, 0, 8, 0, Math.PI * 2); g.fill();
        g.fillStyle = accent; g.beginPath(); g.arc(0, 0, 5, 0, Math.PI * 2); g.fill();
      }
      g.restore();
    }
  }

  _click(e) {
    const r = this.c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = 30 * 30;
    for (const h of this._hits) { const d = (h.x - x) ** 2 + (h.y - y) ** 2; if (d < bd) { bd = d; best = h.p; } }
    this.selected = best; this.draw();
    if (this.onPick) this.onPick(best);
  }
}

// Optional street map. Leaflet is loaded lazily; tiles come from OpenStreetMap.
export class StreetView {
  constructor(el, onPick) { this.el = el; this.onPick = onPick; this.map = null; this.layer = null; this.fitted = false; }
  async set({ me, points, track }) {
    if (!this.map) {
      const { L } = await import("./vendor/libs.js");
      this.L = L;
      this.map = L.map(this.el, { zoomControl: true, attributionControl: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(this.map);
      this.layer = L.layerGroup().addTo(this.map);
    }
    const L = this.L, layer = this.layer;
    layer.clearLayers();
    const bounds = [];
    if (track.length > 1) { L.polyline(track.map((p) => [p.lat, p.lon]), { color: css("--sun"), weight: 4 }).addTo(layer); track.forEach((p) => bounds.push([p.lat, p.lon])); }
    for (const p of points) {
      const color = p.type === "sos" ? css("--danger") : p.type === "start" ? css("--sun") : p.type === "node" ? "#6fb3e0" : css("--accent");
      const m = L.circleMarker([p.lat, p.lon], { radius: 8, color: "#0b120e", weight: 2, fillColor: color, fillOpacity: 1 }).addTo(layer);
      m.bindTooltip(p.label || "", { permanent: !!p.label, direction: "bottom", offset: [0, 8], className: "map-label" });
      m.on("click", () => this.onPick && this.onPick(p));
      bounds.push([p.lat, p.lon]);
    }
    if (me) { L.circleMarker([me.lat, me.lon], { radius: 9, color: "#fff", weight: 3, fillColor: css("--accent"), fillOpacity: 1 }).addTo(layer); bounds.push([me.lat, me.lon]); }
    setTimeout(() => this.map.invalidateSize(), 0);
    if (!this.fitted && bounds.length) {
      this.fitted = true;
      if (bounds.length === 1) this.map.setView(bounds[0], 15); else this.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    }
  }
  recenter() { this.fitted = false; }
}

export function describe(from, to) {
  if (!from || !to) return "";
  const b = bearing(from, to);
  return `${formatDistance(distance(from, to))} ${cardinal(b)} (${Math.round(b)}°)`;
}
