// Local persistence: message history (IndexedDB), contacts, settings, and the
// breadcrumb track (localStorage). Everything stays on this device.
//
// Message record:
// { id, ts, net: "gotenna"|"meshtastic"|"system", dir: "in"|"out"|"sys",
//   kind: "text"|"sos"|"checkin"|"loc", text, fromName, fromId, toId, channel,
//   direct, encrypted, parts, delivered (null|true|false), loc {lat,lon,acc},
//   snr, rssi, hops, relayed, locked }

const DB_NAME = "backtrail", DB_VER = 1, MSGS = "messages";
const MAX_MESSAGES = 2000;
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const s = req.result.createObjectStore(MSGS, { keyPath: "id", autoIncrement: true });
        s.createIndex("ts", "ts");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(MSGS, mode);
    const out = fn(t.objectStore(MSGS));
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

export async function addMessage(m) {
  const rec = { ts: Date.now(), ...m };
  const id = await tx("readwrite", (s) => s.add(rec));
  rec.id = id;
  trimMessages().catch(() => {});
  return rec;
}
export async function updateMessage(id, patch) {
  return tx("readwrite", (s) => {
    const g = s.get(id);
    g.onsuccess = () => { if (g.result) s.put({ ...g.result, ...patch }); };
    return g;
  });
}
export async function listMessages(limit = 500) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = d.transaction(MSGS).objectStore(MSGS).index("ts").openCursor(null, "prev");
    req.onsuccess = () => {
      const c = req.result;
      if (c && out.length < limit) { out.push(c.value); c.continue(); } else resolve(out.reverse());
    };
    req.onerror = () => reject(req.error);
  });
}
export async function clearMessages() { return tx("readwrite", (s) => s.clear()); }
async function trimMessages() {
  const d = await db();
  const count = await new Promise((r) => { const q = d.transaction(MSGS).objectStore(MSGS).count(); q.onsuccess = () => r(q.result); });
  if (count <= MAX_MESSAGES) return;
  let drop = count - MAX_MESSAGES;
  await tx("readwrite", (s) => {
    const req = s.index("ts").openCursor();
    req.onsuccess = () => { const c = req.result; if (c && drop-- > 0) { c.delete(); c.continue(); } };
    return req;
  });
}

// ---- small JSON-in-localStorage helpers (safe if storage is unavailable) ----
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }

// ---- contacts: { id, name, gid (12-hex), node (number), lastSeen, loc {lat,lon,acc,ts} } ----
const C_KEY = "backtrail.contacts";
export const contacts = () => load(C_KEY, []);
export function saveContact(c) {
  const all = contacts();
  if (!c.id) c.id = crypto.getRandomValues(new Uint32Array(2)).join("");
  const i = all.findIndex((x) => x.id === c.id);
  if (i >= 0) all[i] = { ...all[i], ...c }; else all.push(c);
  save(C_KEY, all);
  return c;
}
export function deleteContact(id) { save(C_KEY, contacts().filter((c) => c.id !== id)); }
const normGid = (g) => (g == null ? "" : String(typeof g === "bigint" || typeof g === "number" ? g.toString(16) : g)
  .replace(/^0x/i, "").toLowerCase().padStart(12, "0"));
export const gidHex = normGid;
export function findContact({ gid = null, node = null } = {}) {
  const g = gid != null ? normGid(gid) : null;
  return contacts().find((c) => (g && c.gid && normGid(c.gid) === g) || (node != null && c.node === node)) || null;
}
// Remember where and when a contact was last heard from.
export function touchContact(match, { loc = null } = {}) {
  const c = findContact(match);
  if (!c) return null;
  c.lastSeen = Date.now();
  if (loc) c.loc = { ...loc, ts: Date.now() };
  saveContact(c);
  return c;
}

// ---- settings ----
const S_KEY = "backtrail.settings";
const DEFAULTS = { notify: true, background: false, shareLocCheckin: false, mapTiles: false, rangeTest: false };
export const settings = () => ({ ...DEFAULTS, ...load(S_KEY, {}) });
export function setSetting(k, v) { const s = settings(); s[k] = v; save(S_KEY, s); return s; }

// ---- breadcrumb track: [{lat, lon, acc, ts}] ----
const T_KEY = "backtrail.track";
const MAX_POINTS = 5000;
export const track = () => load(T_KEY, []);
export function addTrackPoint(p) {
  const t = track();
  t.push(p);
  if (t.length > MAX_POINTS) t.splice(0, t.length - MAX_POINTS);
  save(T_KEY, t);
  return t;
}
export function clearTrack() { save(T_KEY, []); }
