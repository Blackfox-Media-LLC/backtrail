// Backtrail UI: goTenna + Meshtastic messaging, history, contacts & QR, SOS,
// check-ins, location sharing, radar map & breadcrumbs, Meshtastic nodes,
// channels and radio settings.
// native-ble.js must load first: it gives the Android/iOS WebView a Web Bluetooth API.
import { isNative } from "./native-ble.js";
import { GoTenna } from "./ble.js";
import { MeshtasticRadio, parseNodeId, nodeId, usbSupported, meshEnums } from "./mesh.js";
import * as gt from "./gt.js";
import * as store from "./store.js";
import * as geo from "./geo.js";
import * as notify from "./notify.js";
import * as qr from "./qr.js";
import { RadarView, StreetView, describe } from "./map.js";

const $ = (id) => document.getElementById(id);
const dev = new GoTenna();          // goTenna radio
const mt = new MeshtasticRadio();   // Meshtastic radio
const reasm = new gt.Reassembler([]);
let channelKey = null;              // Uint8Array(32) derived from the group passphrase
let myPos = null;                   // last location fix {lat, lon, acc, ts}
let demoPos = false;                // store-screenshot demo: fixed position, no GPS

// Tiny DOM builder. Strings become text nodes, so radio text is never parsed as HTML.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(9)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
const ago = (ts) => {
  if (!ts) return "never";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
};
const stamp = (ts) => {
  const d = new Date(ts), t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
};
const fmtLL = (l) => `${l.lat.toFixed(5)}, ${l.lon.toFixed(5)}`;
const gidLabel = (g) => "0x" + store.gidHex(g).replace(/^0+(?=.)/, "");

// ---------------------------------------------------------------- identity
function randGid() {
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function loadId() {
  let id = { nick: "", gid: "", pass: "" };
  try { id = { ...id, ...(JSON.parse(localStorage.getItem("backtrail.id")) || {}) }; } catch { /* storage unavailable */ }
  if (!id.gid) id.gid = randGid();
  return id;
}
function saveId(id) { try { localStorage.setItem("backtrail.id", JSON.stringify(id)); } catch { /* storage unavailable */ } }
const identity = loadId();
saveId(identity);
$("nick").value = identity.nick;
$("gid").value = identity.gid;
$("passphrase").value = identity.pass || "";
const myGid = () => parseInt(identity.gid, 16);

async function applyPassphrase(pass) {
  if (!pass) {
    channelKey = null; reasm.keys = [];
    $("keyStatus").textContent = "No passphrase set. goTenna messages are sent unencrypted.";
    $("encrypt").checked = false;
    updateComposer();
    return;
  }
  $("keyStatus").textContent = "Deriving key…";
  channelKey = await gt.deriveKey(pass);
  reasm.keys = [channelKey];
  const hint = gt.hex(await gt.keyHint(channelKey)).replace(" ", "");
  $("keyStatus").textContent = `🔒 Encryption ready (group ID ${hint}). Everyone in your group should see the same ID.`;
  $("encrypt").checked = true;
  updateComposer();
}

// ---------------------------------------------------------------- theme
try { const t = localStorage.getItem("backtrail.theme"); if (t) document.documentElement.setAttribute("data-theme", t); } catch { /* default */ }
$("themeBtn").onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("backtrail.theme", next); } catch { /* not saved */ }
  radar.draw();
};

// ---------------------------------------------------------------- sheet (modal)
function openSheet(title, ...content) {
  $("sheetTitle").textContent = title;
  $("sheetBody").replaceChildren(...content.flat());
  if (!$("sheet").open) $("sheet").showModal();
}
const closeSheet = () => $("sheet").open && $("sheet").close();
$("sheetClose").onclick = closeSheet;
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
function confirmSheet(title, message, okLabel = "OK", { danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; closeSheet(); resolve(v); } };
    openSheet(title, h("p", {}, message), h("div", { class: "row" },
      h("button", { class: "ghost", onclick: () => finish(false) }, "Cancel"),
      h("button", { class: danger ? "danger" : "primary", onclick: () => finish(true) }, okLabel)));
    $("sheet").addEventListener("close", () => finish(false), { once: true });
  });
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Couldn't copy on this device"); }
}
let toastTimer = null;
function toast(text) {
  let t = $("toast");
  if (!t) { t = h("div", { id: "toast", class: "toast", role: "status" }); document.body.append(t); }
  t.textContent = text; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------------------------------------------------------------- messages
const msgEls = new Map(); // record id -> element
let unread = 0;

function sys(text) {
  const el = h("div", { class: "msg sys" }, text);
  $("history").append(el); scrollDown();
}
function scrollDown() { const box = $("messages"); box.scrollTop = box.scrollHeight; }
// When the keyboard opens (the message list shrinks), keep the newest message in view.
let lastBoxH = 0;
new ResizeObserver(() => {
  const box = $("messages"), hgt = box.clientHeight;
  if (hgt < lastBoxH && box.scrollHeight - box.scrollTop - lastBoxH < 80) scrollDown();
  lastBoxH = hgt;
}).observe($("messages"));

const NET = { gotenna: "goTenna", meshtastic: "Meshtastic", system: "" };
function signalText(m) {
  const bits = [];
  if (m.snr != null) bits.push(`SNR ${(+m.snr).toFixed(1)} dB`);
  if (m.rssi != null && m.net === "meshtastic") bits.push(`RSSI ${m.rssi}`);
  if (m.hops != null && m.hops > 0) bits.push(`${m.hops} hop${m.hops > 1 ? "s" : ""}`);
  return bits.join(" · ");
}
function renderMsg(m) {
  const mine = m.dir === "out";
  const cls = ["msg", mine ? "me" : "them"];
  if (m.kind === "sos") cls.push("sos");
  if (m.locked || m.corrupt) cls.push("locked");
  const where = m.direct ? (mine ? "→ " + (m.toName || m.toId) : "direct") : (m.channelName ? "#" + m.channelName : "group");
  const meta = [NET[m.net], (m.encrypted ? "🔒 " : "") + (mine ? "You" : m.fromName), where, stamp(m.ts)];
  if (m.parts > 1) meta.push(`${m.parts} parts`);
  const sig = signalText(m); if (sig) meta.push(sig);
  if (m.relayed) meta.push("↪ relayed");
  let status = null;
  if (mine) {
    if (m.pending) status = "Sending…";
    else if (m.delivered === true) status = "✓ Delivered";
    else if (m.delivered === false) status = "⚠ Not confirmed";
    else if (m.failed) status = "✕ Not sent";
    else status = "✓ Sent";
  }
  const head = m.kind === "sos" ? h("div", { class: "kind sos-k" }, "🆘 SOS")
    : m.kind === "checkin" ? h("div", { class: "kind" }, "✅ Check-in")
    : m.kind === "loc" ? h("div", { class: "kind" }, "📍 Location") : null;
  const body = m.text ? h("div", { class: "body" }, m.text) : null;
  let locLine = null;
  if (m.loc) {
    locLine = h("div", { class: "loc" },
      h("span", { class: "mono" }, fmtLL(m.loc)),
      myPos && !mine ? h("span", {}, " · " + describe(myPos, m.loc)) : null,
      h("button", { class: "link", onclick: (e) => { e.stopPropagation(); showOnMap(m.loc, m.fromName); } }, "Map"));
  }
  const el = h("div", {
    class: cls.join(" "), "data-direct": m.direct ? "1" : "0",
    "data-place": m.kind === "sos" || m.loc ? "1" : "0",
    title: mine ? null : "Tap to reply",
    onclick: mine ? null : () => replyTo(m),
  }, h("div", { class: "meta" }, meta.filter(Boolean).join(" · ")), head, body, locLine,
  status ? h("div", { class: "status-line" + (m.delivered === false || m.failed ? " warn-t" : "") }, status) : null);
  return el;
}
function showRecord(m) {
  const el = renderMsg(m);
  const old = msgEls.get(m.id);
  if (old) old.replaceWith(el); else $("history").append(el);
  msgEls.set(m.id, el);
}
async function record(m) {
  const rec = await store.addMessage(m);
  showRecord(rec); scrollDown(); refreshHero();
  if (rec.dir === "in" && document.body.dataset.tab !== "messages") { unread++; showUnread(); }
  return rec;
}
async function patchRecord(rec, patch) {
  Object.assign(rec, patch);
  await store.updateMessage(rec.id, patch).catch(() => {});
  showRecord(rec);
}
function showUnread() {
  $("unread").textContent = unread > 99 ? "99+" : String(unread);
  $("unread").classList.toggle("hidden", !unread);
}
async function loadHistory() {
  const list = await store.listMessages(500).catch(() => []);
  for (const m of list) { showRecord(m); learnPlace(m); }
  refreshHero(); scrollDown();
}
function refreshHero() {
  const any = dev.connected || mt.connected, hasHistory = msgEls.size > 0;
  $("hero").classList.toggle("hidden", any || hasHistory);
  $("connectStrip").classList.toggle("hidden", any || !hasHistory);
}
document.querySelectorAll("#msgFilter button").forEach((b) => {
  b.onclick = () => {
    $("messages").dataset.filter = b.dataset.filter;
    document.querySelectorAll("#msgFilter button").forEach((x) => x.classList.toggle("active", x === b));
    scrollDown();
  };
});

// Meshtastic carries Backtrail's SOS / check-in / location as readable text, so
// the official Meshtastic apps show them too. Parse them back on receipt.
const RELAY_TAG = /^\[(gT|MT) [^\]]*\]\s*/;
function meshText({ text = "", kind = null, loc = null }) {
  const at = loc ? ` 📍 ${fmtLL(loc)}` + (loc.acc != null ? ` ±${Math.round(loc.acc * 3.28084)} ft` : "") : "";
  if (kind === "sos") return `🆘 SOS${identity.nick ? " from " + identity.nick : ""}${text ? ": " + text : ""}${at}`;
  if (kind === "checkin") return `✅ ${text || "Check-in"}${at}`;
  if (kind === "loc") return `📍 ${text || "My location"}:${at.replace(" 📍", "")}`;
  return text;
}
function parseMeshText(raw) {
  const t = String(raw || "").replace(RELAY_TAG, "");
  let kind = null;
  if (/^🆘\s*SOS/i.test(t)) kind = "sos";
  else if (/^✅/.test(t)) kind = "checkin";
  else if (/^📍/.test(t)) kind = "loc";
  const m = t.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
  let loc = null;
  if (m) {
    const lat = +m[1], lon = +m[2];
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) loc = { lat, lon, acc: null };
  }
  // Display text without the markers and coordinates we render separately.
  let clean = t;
  if (kind) {
    clean = clean.replace(/^🆘\s*SOS(\s+from\s+[^:]*)?:?\s*/i, "").replace(/^(✅|📍)\s*/u, "")
      .replace(/\s*📍?\s*-?\d{1,2}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}(\s*±\s*\d+\s*ft)?/u, "").replace(/:\s*$/, "").trim();
    if (kind === "loc" && clean === "My location") clean = "";
  }
  return { kind, loc, clean };
}

// ---------------------------------------------------------------- composer
function updateComposer() {
  const g = dev.connected, m = mt.connected, any = g || m;
  $("dot").classList.toggle("on", any);
  $("statusText").textContent = !any ? "No radio" : [g && "goTenna", m && "Meshtastic"].filter(Boolean).join(" + ");
  $("text").disabled = !any; $("sendBtn").disabled = !any;
  document.body.classList.toggle("offline", !any);
  document.querySelectorAll("#quick button").forEach((b) => { b.disabled = !any; });
  $("netSel").classList.toggle("hidden", !(g && m));
  if (!(g && m)) $("netSel").value = "both";
  const net = currentNet();
  $("encrypt").disabled = !channelKey || !g || net === "meshtastic";
  $("bridge").disabled = !(g && m);
  if (!(g && m)) $("bridge").checked = false;
  $("rangeTest").disabled = !any;
  if (!any && $("rangeTest").checked) { $("rangeTest").checked = false; stopRangeTest(); }
  buildToOptions();
  refreshHero();
  syncBackground();
}
// Foreground service runs only while a radio is connected and the setting is on.
let bgState = null;
async function syncBackground() {
  const any = dev.connected || mt.connected;
  const want = store.settings().background && any ? "Connected: " + $("statusText").textContent : null;
  if (want === bgState) return;
  bgState = want;
  const ok = await notify.setBackground(!!want, want || undefined);
  if (want && !ok) { bgState = null; toast("Couldn't stay connected in the background. Allow notifications and try again."); }
}
const currentNet = () => (dev.connected && mt.connected ? $("netSel").value : dev.connected ? "gotenna" : mt.connected ? "meshtastic" : "none");
$("netSel").onchange = updateComposer;

function buildToOptions() {
  const sel = $("toSel"), prev = sel.value || "all";
  const net = currentNet(), useGt = net === "gotenna" || net === "both", useMt = net === "meshtastic" || net === "both";
  const opts = [h("option", { value: "all" }, net === "meshtastic" ? "Everyone (primary channel)" : "Everyone")];
  if (useMt) for (const c of mt.channelsList()) if (c.index > 0) opts.push(h("option", { value: "ch:" + c.index }, "# " + c.name));
  const people = store.contacts().filter((c) => (useGt && c.gid) || (useMt && c.node != null));
  if (people.length) opts.push(h("optgroup", { label: "Contacts" }, people.map((c) => h("option", { value: "c:" + c.id }, c.name))));
  if (useMt) {
    const nodes = mt.nodesList().filter((n) => !store.findContact({ node: n.num })).slice(0, 40);
    if (nodes.length) opts.push(h("optgroup", { label: "Meshtastic nodes" }, nodes.map((n) => h("option", { value: "n:" + n.num }, (n.longName || n.id) + (n.shortName ? ` (${n.shortName})` : "")))));
  }
  opts.push(h("option", { value: "custom" }, "Enter an ID…"));
  sel.replaceChildren(...opts);
  sel.value = [...sel.querySelectorAll("option")].some((o) => o.value === prev) ? prev : "all";
  $("toCustom").classList.toggle("hidden", sel.value !== "custom");
  $("toCustom").placeholder = net === "meshtastic" ? "!node ID" : net === "gotenna" ? "goTenna ID" : "goTenna ID or !node";
}
$("toSel").onchange = () => { $("toCustom").classList.toggle("hidden", $("toSel").value !== "custom"); if ($("toSel").value === "custom") $("toCustom").focus(); };

// Where a message goes: {gt: null | {toGid}, mt: null | {to, channel}, toName}
function resolveTargets({ everyone = false } = {}) {
  const net = currentNet();
  const gtOk = dev.connected && (net === "gotenna" || net === "both" || everyone);
  const mtOk = mt.connected && (net === "meshtastic" || net === "both" || everyone);
  const v = everyone ? "all" : $("toSel").value;
  if (v === "all") return { gt: gtOk ? { toGid: null } : null, mt: mtOk ? { to: null, channel: 0 } : null };
  if (v.startsWith("ch:")) return { gt: null, mt: { to: null, channel: +v.slice(3) } };
  if (v.startsWith("n:")) { const num = +v.slice(2); return { gt: null, mt: { to: num, channel: 0 }, toName: mt.nameOf(num) }; }
  if (v.startsWith("c:")) {
    const c = store.contacts().find((x) => x.id === v.slice(2));
    if (!c) throw new Error("That contact no longer exists.");
    const t = { gt: gtOk && c.gid ? { toGid: parseInt(c.gid, 16) } : null, mt: mtOk && c.node != null ? { to: c.node, channel: 0 } : null, toName: c.name };
    if (!t.gt && !t.mt) throw new Error(`${c.name} has no ID for the connected radio.`);
    return t;
  }
  const raw = $("toCustom").value.trim();
  if (!raw) throw new Error("Enter who to send to.");
  if (raw.startsWith("!") || (net === "meshtastic")) {
    const num = parseNodeId(raw);
    if (num == null || !mt.connected) throw new Error("Enter a Meshtastic node ID, like !a1b2c3d4.");
    return { gt: null, mt: { to: num, channel: 0 }, toName: nodeId(num) };
  }
  const gid = parseInt(raw.replace(/[^0-9a-f]/gi, "") || "0", 16);
  if (!gid || !dev.connected) throw new Error("Enter a goTenna ID (hex), or a Meshtastic ID starting with !");
  return { gt: { toGid: gid }, mt: null, toName: gidLabel(gid) };
}

function replyTo(m) {
  showTab("messages");
  if (m.net === "meshtastic" && m.fromId != null) {
    const c = store.findContact({ node: +m.fromId });
    if (m.direct || c) {
      if (dev.connected && mt.connected) $("netSel").value = "meshtastic";
      buildToOptions();
      $("toSel").value = c ? "c:" + c.id : "n:" + m.fromId;
      if ($("toSel").value === "" ) { $("toSel").value = "custom"; $("toCustom").value = nodeId(+m.fromId); }
    } else if (m.channel) { $("toSel").value = "ch:" + m.channel; }
  } else if (m.net === "gotenna" && m.fromId) {
    const c = store.findContact({ gid: m.fromId });
    if (dev.connected && mt.connected) $("netSel").value = "gotenna";
    buildToOptions();
    if (c) $("toSel").value = "c:" + c.id;
    else { $("toSel").value = "custom"; $("toCustom").value = store.gidHex(m.fromId); }
  }
  if (!$("toSel").value) $("toSel").value = "all";
  $("toCustom").classList.toggle("hidden", $("toSel").value !== "custom");
  $("text").focus();
}

// ---------------------------------------------------------------- sending
let sending = false;
async function sendOut({ text = "", kind = null, loc = null, everyone = false } = {}) {
  if (sending) { toast("Still sending the last message…"); return false; }
  if (!(dev.connected || mt.connected)) { toast("Connect a radio first."); return false; }
  let t;
  try { t = resolveTargets({ everyone }); } catch (e) { toast(e.message); return false; }
  if (!t.gt && !t.mt) { toast("No connected radio for that recipient."); return false; }
  sending = true; $("sendBtn").disabled = true;
  let ok = true, notConfirmed = false;
  try {
    if (t.gt) {
      const key = $("encrypt").checked && channelKey ? channelKey : null;
      const toGid = t.gt.toGid;
      const rec = await record({ net: "gotenna", dir: "out", kind: kind || "text", text, loc, direct: !!toGid,
        toId: toGid ? store.gidHex(toGid) : null, toName: t.toName, encrypted: !!key, pending: true });
      try {
        const r = await dev.send(text, myGid(), {
          nick: identity.nick, toGid, key, kind, loc,
          onProgress: (n, total) => {
            $("sendStatus").textContent = total > 1 ? `goTenna: sending ${n} of ${total}…` : "goTenna: sending…";
            if (toGid && n === total) $("sendStatus").textContent = "goTenna: waiting for delivery receipt…";
          },
        });
        if (!r.ok) throw new Error(`goTenna send failed after ${r.sent} of ${r.total} parts`);
        await patchRecord(rec, { pending: false, parts: r.total, delivered: r.delivered });
        if (r.delivered === false) notConfirmed = true;
      } catch (e) { ok = false; await patchRecord(rec, { pending: false, failed: true }); sys("goTenna: " + e.message); }
    }
    if (t.mt) {
      const body = meshText({ text, kind, loc });
      const rec = await record({ net: "meshtastic", dir: "out", kind: kind || "text", text, loc, direct: t.mt.to != null,
        toId: t.mt.to, toName: t.toName, channel: t.mt.channel, channelName: chanName(t.mt.channel), pending: true });
      try {
        const r = await mt.send(body, {
          to: t.mt.to, channel: t.mt.channel,
          onProgress: (n, total) => { $("sendStatus").textContent = total > 1 ? `Meshtastic: sending ${n} of ${total}…` : "Meshtastic: sending…"; },
        });
        if (loc && t.mt.to == null) await mt.sharePosition(loc.lat, loc.lon, { alt: loc.alt, channel: t.mt.channel }).catch(() => {});
        await patchRecord(rec, { pending: false, parts: r.total, delivered: r.delivered });
        if (r.delivered === false) notConfirmed = true;
      } catch (e) { ok = false; await patchRecord(rec, { pending: false, failed: true }); sys("Meshtastic: " + e.message); }
    }
    $("sendStatus").textContent = notConfirmed
      ? "No delivery confirmation: the recipient may be out of range, off, or using a different ID." : "";
    return ok;
  } finally { sending = false; $("sendBtn").disabled = !(dev.connected || mt.connected); }
}
const chanName = (i) => { const c = mt.channels.get(i); return c ? c.name : i ? "Channel " + i : "Primary"; };

async function doSend() {
  const text = $("text").value.trim();
  if (!text) return;
  $("text").value = "";
  const ok = await sendOut({ text });
  if (!ok && !$("text").value) $("text").value = text;
}
$("sendBtn").onclick = doSend;
$("text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); } });

async function fix({ required = false } = {}) {
  if (demoPos) return myPos;
  try { myPos = await geo.currentPosition({ timeout: 15000 }); updateMyPos(); return myPos; }
  catch (e) { if (required) toast("No location: " + e.message); return null; }
}
document.querySelectorAll("#quick [data-checkin]").forEach((b) => {
  b.onclick = async () => {
    const loc = store.settings().shareLocCheckin ? await fix() : null;
    sendOut({ text: b.dataset.checkin, kind: "checkin", loc });
  };
});
$("locBtn").onclick = shareLocation;
$("shareLocBtn").onclick = shareLocation;
async function shareLocation() {
  if (!(dev.connected || mt.connected)) { toast("Connect a radio first."); return; }
  toast("Getting your location…");
  const loc = await fix({ required: true });
  if (!loc) return;
  showTab("messages");
  sendOut({ kind: "loc", loc });
}
$("sosBtn").onclick = async () => {
  if (!(dev.connected || mt.connected)) { toast("Connect a radio first."); return; }
  const note = h("input", { placeholder: "Optional: what's wrong? (e.g. injured ankle)", maxlength: "120" });
  let go = false;
  await new Promise((resolve) => {
    openSheet("Send SOS?",
      h("div", { class: "warn" }, "This sends an SOS with your location to everyone in range on every connected radio. It does NOT contact 911 or any emergency service. If you can, call 911."),
      note,
      h("div", { class: "row" },
        h("button", { class: "ghost", onclick: () => { closeSheet(); } }, "Cancel"),
        h("button", { class: "danger", onclick: () => { go = true; closeSheet(); } }, "Send SOS")));
    $("sheet").addEventListener("close", resolve, { once: true });
  });
  if (!go) return;
  showTab("messages");
  toast("Getting your location…");
  const loc = await fix({ required: false });
  await sendOut({ text: note.value.trim(), kind: "sos", loc, everyone: true });
  if (!loc) sys("SOS sent without a location (no GPS fix).");
};

// ---------------------------------------------------------------- relay
// Group messages only; relayed text is tagged "[gT name]" / "[MT name]" and
// tagged text is never relayed again, so two bridges can't ping-pong.
const isRelayed = (text) => RELAY_TAG.test(text || "");
let relayChain = Promise.resolve();
function relay(fn, label) {
  relayChain = relayChain.then(fn).then(() => sys(`↪ relayed to ${label}`), (e) => sys(`Relay to ${label} failed: ${e.message}`));
}
function relayToMeshtastic(name, m) {
  if (!$("bridge").checked || !mt.connected || isRelayed(m.text)) return;
  relay(() => mt.send(`[gT ${name}] ${meshText({ text: m.text, kind: m.kind, loc: m.loc })}`), "Meshtastic");
}
function relayToGotenna(name, text, parsed) {
  if (!$("bridge").checked || !dev.connected || isRelayed(text)) return;
  const key = $("encrypt").checked && channelKey ? channelKey : null;
  relay(() => dev.send(`[MT ${name}] ${text}`, myGid(), { nick: identity.nick, key, kind: parsed.kind, loc: parsed.loc }), "goTenna");
}

// ---------------------------------------------------------------- incoming
async function incoming(rec) {
  const saved = await record(rec);
  learnPlace(saved);
  const title = (rec.kind === "sos" ? "🆘 SOS from " : "") + rec.fromName;
  const body = rec.text || (rec.loc ? "📍 " + fmtLL(rec.loc) : rec.kind === "checkin" ? "Check-in" : "New message");
  if (rec.kind === "sos") {
    showSos(saved);
    try { navigator.vibrate?.([600, 200, 600, 200, 600]); } catch { /* no vibration */ }
  }
  if (store.settings().notify) notify.notify(title, body, { sos: rec.kind === "sos" });
  renderPeople(); if (document.body.dataset.tab === "map") refreshMap();
}
function showSos(m) {
  const b = $("sosBanner");
  b.replaceChildren(
    h("strong", {}, "🆘 SOS from " + m.fromName), " ", stamp(m.ts),
    m.text ? h("div", {}, m.text) : null,
    m.loc ? h("div", {}, fmtLL(m.loc), myPos ? " · " + describe(myPos, m.loc) : "") : h("div", {}, "No location included."),
    h("div", { class: "row" },
      m.loc ? h("button", { onclick: () => showOnMap(m.loc, m.fromName) }, "Show on map") : null,
      h("button", { class: "ghost", onclick: () => b.classList.add("hidden") }, "Dismiss")));
  b.classList.remove("hidden");
}

// goTenna
async function handleInbox() {
  for (const raw of await dev.drainInbox()) {
    const m = await reasm.add(raw);
    if (m) await onGotenna(m);
  }
}
async function onGotenna(m) {
  const gid = m.fromGid != null ? store.gidHex(m.fromGid) : null;
  const c = gid ? store.findContact({ gid }) : null;
  const name = (c && c.name) || m.nick || (gid ? gidLabel(gid) : "unknown");
  const rec = {
    net: "gotenna", dir: "in", kind: m.kind || "text", fromName: name, fromId: gid,
    direct: m.className === "P2P", encrypted: !!m.encrypted, parts: m.parts || 1, loc: m.loc || null,
    hops: m.hops ?? null, relayed: isRelayed(m.text),
  };
  if (m.locked) Object.assign(rec, { text: "Encrypted message. Set your group's passphrase to read it.", locked: true });
  else if (m.corrupt || m.text == null) Object.assign(rec, { text: "(message could not be decoded)", corrupt: true });
  else rec.text = m.text;
  if (gid) store.touchContact({ gid }, { loc: rec.loc });
  await incoming(rec);
  if (!rec.locked && !rec.corrupt && m.className === "SHOUT") relayToMeshtastic(name, { text: m.text, kind: m.kind, loc: m.loc });
}

// Meshtastic
mt.addEventListener("message", async (e) => {
  const m = e.detail;
  const c = store.findContact({ node: m.from });
  const parsed = parseMeshText(m.text);
  const rec = {
    net: "meshtastic", dir: "in", kind: parsed.kind || "text", text: parsed.kind ? parsed.clean : m.text, fromName: (c && c.name) || m.fromName,
    fromId: m.from, direct: m.direct, channel: m.channel, channelName: chanName(m.channel), loc: parsed.loc,
    snr: m.snr, rssi: m.rssi, hops: m.hops, relayed: isRelayed(m.text),
  };
  store.touchContact({ node: m.from }, { loc: parsed.loc });
  await incoming(rec);
  if (!m.direct) relayToGotenna(rec.fromName, m.text, parsed);
});

// ---------------------------------------------------------------- goTenna connection
function showGotennaInfo(info) {
  $("dModel").textContent = info.model || "goTenna Mesh";
  $("dFw").textContent = info.fwRev || "—";
  $("dSerial").textContent = info.serial || "—";
  if (info.battery != null) {
    const pct = Math.max(0, Math.min(100, info.battery));
    $("dBattPct").textContent = pct + "%"; $("dBatt").style.width = pct + "%";
  }
  if (info.region) $("regionSel").value = String(info.region);
}
function setGotennaUi(on) {
  $("gtConnectBtn").textContent = on ? "Disconnect goTenna" : "Connect goTenna";
  $("gtConnectBtn").className = on ? "ghost" : "primary";
  $("noDevice").classList.toggle("hidden", on);
  $("deviceInfo").classList.toggle("hidden", !on);
  updateComposer();
}
async function connectGotenna() {
  if (dev.connected) { await dev.disconnect(); return; }
  if (!navigator.bluetooth) { sys("This browser has no Web Bluetooth. Use Chrome or Edge on a computer or Android."); return; }
  $("gtConnectBtn").disabled = true;
  try {
    sys(isNative ? "Searching… choose your goTenna in the list (it shows by its address)."
      : "Scanning… choose your goTenna in the browser list (it shows as “Unknown or unsupported device”).");
    const info = await dev.connect();
    setGotennaUi(true); showGotennaInfo(info);
    showTab("messages");
    if (!(await dev.setIdentity(myGid()))) sys("Couldn't program your ID into the radio; direct messages to you may not arrive.");
    sys("Connected to " + (info.model || "goTenna") + " (fw " + (info.fwRev || "?") + ").");
    askNotifications();
    await checkInbox();
  } catch (e) {
    sys(/cancel/i.test(e.message || "") ? "Connection cancelled." : "goTenna connection failed: " + e.message);
  } finally { $("gtConnectBtn").disabled = false; }
}
$("gtConnectBtn").onclick = connectGotenna;
let inboxBusy = false;
async function checkInbox() {
  if (inboxBusy || !dev.connected) return;
  inboxBusy = true;
  try { await handleInbox(); } catch { /* transient BLE error; next poll retries */ } finally { inboxBusy = false; }
}
let pollTimer = null;
dev.addEventListener("connected", () => { setGotennaUi(true); clearInterval(pollTimer); pollTimer = setInterval(checkInbox, 10000); });
dev.addEventListener("disconnected", () => { clearInterval(pollTimer); setGotennaUi(false); sys("goTenna disconnected."); });
dev.addEventListener("mail", checkInbox);
$("regionBtn").onclick = async () => {
  if (!dev.connected) return;
  try { toast((await dev.setRegion(parseInt($("regionSel").value, 10))) ? "Region updated." : "Region change failed."); }
  catch (e) { toast("Region error: " + e.message); }
};

// ---------------------------------------------------------------- Meshtastic connection
function fillEnum(sel, en, current) {
  const entries = Object.entries(en).filter(([, v]) => typeof v === "number");
  sel.replaceChildren(...entries.map(([k, v]) => h("option", { value: String(v) }, k.replace(/_/g, " "))));
  if (current != null) sel.value = String(current);
}
function showMeshtastic() {
  const on = mt.connected;
  $("mtConnectBtn").textContent = on ? "Disconnect Meshtastic" : "Connect via Bluetooth";
  $("mtConnectBtn").className = on ? "ghost" : "primary";
  $("mtUsbBtn").classList.toggle("hidden", on || !usbSupported());
  $("mtNone").classList.toggle("hidden", on);
  $("mtInfo").classList.toggle("hidden", !on);
  if (on) {
    const i = mt.info(), me = mt.nodes.get(mt.myNodeNum) || {};
    $("mtName").textContent = i.longName !== "—" ? `${i.longName} (${i.shortName})` : "—";
    $("mtId").textContent = i.nodeId;
    $("mtHw").textContent = (i.hwModel || "—").replace(/_/g, " ");
    $("mtFw").textContent = i.firmware || "—";
    $("mtRadio").textContent = `${i.region} · ${(i.preset || "").replace(/_/g, " ")}`;
    $("mtRole").textContent = (i.role || "—").replace(/_/g, " ");
    $("mtBatt").textContent = i.battery != null ? (i.battery > 100 ? "Plugged in" : i.battery + "%") + (i.voltage ? ` · ${(+i.voltage).toFixed(2)} V` : "") : "—";
    $("mtUtil").textContent = me.chUtil != null ? `${me.chUtil.toFixed(1)}% · ${(me.airUtil || 0).toFixed(1)}%` : "—";
    $("mtNodes").textContent = String(mt.nodesList().length);
    $("chanList").replaceChildren(...mt.channelsList().map((c) => h("div", { class: "item" },
      h("div", { class: "item-main" }, h("strong", {}, `#${c.index} ${c.name}`),
        h("span", { class: "sub" }, c.index === 0 ? "primary" : "secondary", " · ", c.psk && c.psk.length > 1 ? "🔒 private key" : c.psk && c.psk.length === 1 ? "default key (public)" : "no encryption")))));
    if (!$("mtInfo").dataset.filled) {
      $("mtInfo").dataset.filled = "1";
      $("mtLong").value = me.longName || ""; $("mtShort").value = me.shortName || "";
      fillEnum($("mtRegionSel"), meshEnums.regions, mt.config.lora?.region);
      fillEnum($("mtPresetSel"), meshEnums.presets, mt.config.lora?.modemPreset);
      fillEnum($("mtRoleSel"), meshEnums.roles, mt.config.device?.role);
      const pw = mt.config.power || {};
      const sleepVal = pw.isPowerSaving ? String(pw.waitBluetoothSecs || 60) : "0";
      if (![...$("mtSleepSel").options].some((o) => o.value === sleepVal)) $("mtSleepSel").append(h("option", { value: sleepVal }, `After ${Math.round(+sleepVal / 60) || 1} min`));
      $("mtSleepSel").value = sleepVal;
    }
  } else delete $("mtInfo").dataset.filled;
  updateComposer();
}
async function connectMeshtastic(via) {
  if (via === "bluetooth" && !navigator.bluetooth) { sys("This browser has no Web Bluetooth. Use Chrome or Edge on a computer or Android."); return; }
  $("mtConnectBtn").disabled = true; $("mtUsbBtn").disabled = true;
  try {
    sys(via === "usb"
      ? "Choose your Meshtastic radio's serial port in the browser list (often “CP210x” or “USB Serial”)."
      : (isNative ? "Searching… choose your Meshtastic radio in the list." : "Scanning… choose your Meshtastic radio in the browser list.")
        + " Close the Meshtastic phone app first if it's connected.");
    const info = await mt.connect({ via });
    showMeshtastic(); renderPeople();
    showTab("messages");
    sys(`Connected to Meshtastic ${info.longName} (${info.nodeId}) via ${via === "usb" ? "USB" : "Bluetooth"}.`);
    askNotifications();
  } catch (e) {
    sys(/cancel/i.test(e.message || "") ? "Connection cancelled." : "Meshtastic connection failed: " + e.message);
  } finally { $("mtConnectBtn").disabled = false; $("mtUsbBtn").disabled = false; }
}
$("mtConnectBtn").onclick = async () => { if (mt.connected) { await mt.disconnect(); return; } await connectMeshtastic("bluetooth"); };
$("mtUsbBtn").onclick = () => connectMeshtastic("usb");
$("mtUsbBtn").classList.toggle("hidden", !usbSupported());
mt.addEventListener("disconnected", () => { showMeshtastic(); renderPeople(); sys("Meshtastic disconnected."); });
let nodesTimer = null;
const nodesChanged = () => {
  clearTimeout(nodesTimer);
  nodesTimer = setTimeout(() => {
    if (mt.connected) showMeshtastic();
    renderPeople();
    if (document.body.dataset.tab === "map") refreshMap();
  }, 400);
};
mt.addEventListener("nodes", nodesChanged);
mt.addEventListener("channels", nodesChanged);
mt.addEventListener("position", (e) => {
  const n = mt.nodes.get(e.detail.num);
  if (n && n.position) store.touchContact({ node: n.num }, { loc: { lat: n.position.lat, lon: n.position.lon, acc: null } });
  nodesChanged();
});

$("mtSaveBtn").onclick = async () => {
  const lora = mt.config.lora || {}, devc = mt.config.device || {};
  const region = +$("mtRegionSel").value, preset = +$("mtPresetSel").value, role = +$("mtRoleSel").value;
  const long = $("mtLong").value.trim(), short = $("mtShort").value.trim();
  const me = mt.nodes.get(mt.myNodeNum) || {};
  const changes = [];
  if (long && short && (long !== me.longName || short !== me.shortName)) changes.push("name");
  if (region !== lora.region || preset !== lora.modemPreset) changes.push("radio");
  if (role !== devc.role) changes.push("role");
  const pw = mt.config.power || {}, sleep = +$("mtSleepSel").value;
  if ((sleep === 0) !== !pw.isPowerSaving || (sleep && sleep !== pw.waitBluetoothSecs)) changes.push("power");
  if (!changes.length) { toast("Nothing changed."); return; }
  if (!(await confirmSheet("Save to radio?", "Backtrail will write these settings to your Meshtastic radio. Radio and role changes restart it, and Bluetooth will reconnect.", "Save"))) return;
  try {
    if (changes.includes("name")) await mt.setOwner(long, short);
    if (changes.includes("radio")) await mt.updateLora({ region, modemPreset: preset, usePreset: true });
    if (changes.includes("role")) await mt.updateDevice({ role });
    if (changes.includes("power")) await mt.updatePower(sleep ? { isPowerSaving: true, waitBluetoothSecs: sleep } : { isPowerSaving: false });
    toast("Saved to radio.");
    showMeshtastic();
  } catch (e) { toast("Couldn't save: " + e.message); }
};
$("mtRebootBtn").onclick = async () => {
  if (!(await confirmSheet("Reboot radio?", "Your Meshtastic radio will restart. Reconnect when it comes back.", "Reboot"))) return;
  try { await mt.reboot(); toast("Rebooting…"); } catch (e) { toast(e.message); }
};
$("chanQrBtn").onclick = () => {
  const url = mt.channelUrl();
  openSheet("Share Meshtastic channels",
    h("div", { class: "qr", html: null }),
    h("p", { class: "note" }, "Scan with the Meshtastic app or Backtrail to join these channels. Anyone with this code can read messages on them."),
    h("div", { class: "mono linkbox" }, url),
    h("button", { onclick: () => copy(url) }, "Copy link"));
  $("sheetBody").querySelector(".qr").innerHTML = qr.qrSvg(url);
};
$("chanImportBtn").onclick = () => askForLink("Import channel link", "Paste a Meshtastic channel link (https://meshtastic.org/e/#…).");

// ---------------------------------------------------------------- notifications & background
let askedNotify = false;
async function askNotifications() {
  if (askedNotify || !store.settings().notify) return;
  askedNotify = true;
  await notify.permission(true).catch(() => false);
}
const S = store.settings();
$("setNotify").checked = S.notify;
$("setBackground").checked = S.background && notify.backgroundSupported();
$("setLocCheckin").checked = S.shareLocCheckin;
$("setTiles").checked = S.mapTiles;
$("bgRow").classList.toggle("hidden", !notify.backgroundSupported());
$("bgNote").classList.toggle("hidden", !notify.backgroundSupported());
$("setNotify").onchange = async (e) => {
  store.setSetting("notify", e.target.checked);
  if (e.target.checked && !(await notify.permission(true))) toast("Allow notifications for Backtrail in your device settings.");
};
$("setBackground").onchange = (e) => { store.setSetting("background", e.target.checked); syncBackground(); };
$("setLocCheckin").onchange = (e) => store.setSetting("shareLocCheckin", e.target.checked);
$("setTiles").onchange = (e) => { store.setSetting("mapTiles", e.target.checked); if (!e.target.checked) setStreet(false); };

// ---------------------------------------------------------------- range test
let rangeTimer = null, rangeN = 0;
function stopRangeTest() { clearInterval(rangeTimer); rangeTimer = null; }
$("rangeTest").onchange = (e) => {
  stopRangeTest();
  if (!e.target.checked) { sys("Range test stopped."); return; }
  rangeN = 0;
  const ping = async () => {
    if (sending) return;
    rangeN++;
    const loc = myPos && Date.now() - myPos.ts < 120000 ? myPos : null;
    await sendOut({ text: `Range test #${rangeN}${identity.nick ? " from " + identity.nick : ""}${loc ? " @ " + fmtLL(loc) : ""}`, everyone: true });
  };
  sys("Range test started: a numbered ping every 60 seconds on every connected radio.");
  ping(); rangeTimer = setInterval(ping, 60000);
};

// ---------------------------------------------------------------- people
function contactSub(c) {
  const ids = [];
  if (c.gid) ids.push("goTenna " + gidLabel(c.gid));
  if (c.node != null) ids.push("Meshtastic " + nodeId(c.node));
  return ids.join(" · ") || "no radio ID";
}
function renderPeople() {
  const list = store.contacts().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  $("contactList").replaceChildren(...(list.length ? list.map((c) => {
    const dist = c.loc && myPos ? describe(myPos, c.loc) : null;
    return h("div", { class: "item" },
      h("div", { class: "avatar" }, (c.name || "?").slice(0, 2).toUpperCase()),
      h("div", { class: "item-main" },
        h("strong", {}, c.name),
        h("span", { class: "sub" }, contactSub(c)),
        h("span", { class: "sub" }, "Heard " + ago(c.lastSeen), dist ? " · " + dist : "", c.loc && !dist ? " · location known" : "")),
      h("div", { class: "item-actions" },
        h("button", { onclick: () => messageContact(c) }, "Message"),
        c.loc ? h("button", { class: "ghost", onclick: () => showOnMap(c.loc, c.name) }, "Map") : null,
        h("button", { class: "ghost", onclick: () => editContact(c) }, "Edit")));
  }) : [h("div", { class: "note" }, "No contacts yet. Scan a friend's Backtrail QR code, add one from a Meshtastic node below, or add an ID manually.")]));

  const nodes = mt.connected ? mt.nodesList() : [];
  $("nodesNone").classList.toggle("hidden", mt.connected);
  $("nodeCount").textContent = mt.connected ? `(${nodes.length})` : "";
  $("nodeList").replaceChildren(...(mt.connected && !nodes.length ? [h("div", { class: "note" }, "No other nodes heard yet. They appear as their radios announce themselves.")] : nodes.map((n) => {
    const c = store.findContact({ node: n.num });
    const stats = [];
    stats.push("heard " + ago(n.lastHeard ? n.lastHeard * 1000 : null));
    if (n.hops != null) stats.push(n.hops === 0 ? "direct" : `${n.hops} hop${n.hops > 1 ? "s" : ""}`);
    if (n.snr != null) stats.push(`SNR ${(+n.snr).toFixed(1)}`);
    if (n.rssi != null) stats.push(`RSSI ${n.rssi}`);
    if (n.battery != null) stats.push(n.battery > 100 ? "🔌" : `🔋${n.battery}%`);
    if (n.position && myPos) stats.push(describe(myPos, n.position));
    const env = n.env && n.env.temp != null ? `${Math.round(n.env.temp * 9 / 5 + 32)}°F` + (n.env.humidity ? ` · ${Math.round(n.env.humidity)}% RH` : "") : null;
    return h("div", { class: "item" },
      h("div", { class: "avatar node" }, (n.shortName || n.id.slice(-4)).slice(0, 4)),
      h("div", { class: "item-main" },
        h("strong", {}, (c && c.name) || n.longName || n.id),
        h("span", { class: "sub mono" }, n.id, n.hwModel ? " · " + n.hwModel.replace(/_/g, " ") : "", n.role && n.role !== "CLIENT" ? " · " + n.role.replace(/_/g, " ") : ""),
        h("span", { class: "sub" }, stats.join(" · ")),
        env ? h("span", { class: "sub" }, "🌡 " + env) : null),
      h("div", { class: "item-actions" },
        h("button", { onclick: () => messageNode(n.num) }, "Message"),
        n.position ? h("button", { class: "ghost", onclick: () => showOnMap(n.position, n.shortName || n.longName) }, "Map") : null,
        h("button", { class: "ghost", onclick: () => nodeMenu(n) }, "More")));
  })));
}
function messageContact(c) {
  showTab("messages");
  if (dev.connected && mt.connected) $("netSel").value = c.gid && c.node != null ? "both" : c.gid ? "gotenna" : "meshtastic";
  buildToOptions();
  $("toSel").value = "c:" + c.id;
  if ($("toSel").value !== "c:" + c.id) { toast(`Connect a radio that ${c.name} uses.`); $("toSel").value = "all"; }
  $("toCustom").classList.add("hidden");
  $("text").focus();
}
function messageNode(num) {
  showTab("messages");
  if (dev.connected && mt.connected) $("netSel").value = "meshtastic";
  buildToOptions();
  const c = store.findContact({ node: num });
  $("toSel").value = c ? "c:" + c.id : "n:" + num;
  $("toCustom").classList.add("hidden");
  $("text").focus();
}
function nodeMenu(n) {
  const c = store.findContact({ node: n.num });
  const out = h("div", { class: "note" });
  openSheet(n.longName || n.id,
    h("div", { class: "kv" }, h("span", { class: "k" }, "Node ID"), h("span", { class: "v mono" }, n.id)),
    n.hwModel ? h("div", { class: "kv" }, h("span", { class: "k" }, "Hardware"), h("span", { class: "v" }, n.hwModel.replace(/_/g, " "))) : null,
    n.voltage ? h("div", { class: "kv" }, h("span", { class: "k" }, "Battery"), h("span", { class: "v" }, `${n.battery ?? "?"}% · ${(+n.voltage).toFixed(2)} V`)) : null,
    n.chUtil != null ? h("div", { class: "kv" }, h("span", { class: "k" }, "Channel use"), h("span", { class: "v" }, n.chUtil.toFixed(1) + "%")) : null,
    n.position ? h("div", { class: "kv" }, h("span", { class: "k" }, "Position"), h("span", { class: "v mono" }, fmtLL(n.position))) : null,
    h("div", { class: "btn-grid" },
      c ? h("button", { onclick: () => editContact(c) }, "Edit contact")
        : h("button", { class: "primary", onclick: () => editContact({ name: n.longName || n.shortName || n.id, node: n.num }) }, "Add to contacts"),
      h("button", { onclick: async () => {
        out.textContent = "Tracing route… (up to a minute)";
        const r = await mt.traceroute(n.num).catch(() => null);
        if (!r) { out.textContent = "No traceroute reply. The node may be out of range or asleep."; return; }
        const hops = [mt.nameOf(mt.myNodeNum), ...r.route.map((x) => mt.nameOf(x)), mt.nameOf(n.num)];
        out.textContent = "Route: " + hops.join(" → ") + (r.snrTowards.length ? `  (SNR ${r.snrTowards.map((s) => s.toFixed(1)).join(", ")} dB)` : "");
      } }, "Trace route"),
      h("button", { onclick: async () => { await mt.requestPosition(n.num).catch(() => {}); out.textContent = "Position requested. It appears when the node replies."; } }, "Request position")),
    out);
}
function editContact(c = {}) {
  const name = h("input", { value: c.name || "", maxlength: "30", placeholder: "Name" });
  const gid = h("input", { value: c.gid ? store.gidHex(c.gid) : "", class: "mono", placeholder: "goTenna ID (hex), optional", spellcheck: "false" });
  const node = h("input", { value: c.node != null ? nodeId(c.node) : "", class: "mono", placeholder: "Meshtastic node ID (!a1b2c3d4), optional", spellcheck: "false" });
  openSheet(c.id ? "Edit contact" : "New contact",
    h("label", {}, "Name"), name, h("label", {}, "goTenna ID"), gid, h("label", {}, "Meshtastic node"), node,
    h("div", { class: "row" },
      c.id ? h("button", { class: "danger", onclick: async () => {
        if (await confirmSheet("Delete contact?", `Remove ${c.name} from your contacts?`, "Delete", { danger: true })) { store.deleteContact(c.id); renderPeople(); buildToOptions(); }
      } }, "Delete") : null,
      h("button", { class: "primary", onclick: () => {
        const n = name.value.trim();
        const g = gid.value.replace(/[^0-9a-f]/gi, "").slice(0, 12).toLowerCase();
        const nd = node.value.trim() ? parseNodeId(node.value) : null;
        if (!n) { toast("Enter a name."); return; }
        if (!g && nd == null) { toast("Enter a goTenna ID or a Meshtastic node ID."); return; }
        store.saveContact({ ...c, name: n, gid: g || null, node: nd });
        closeSheet(); renderPeople(); buildToOptions(); toast("Contact saved.");
      } }, "Save")));
}
$("addContactBtn").onclick = () => editContact();

// ---------------------------------------------------------------- QR codes
function myQr() {
  const link = qr.contactLink({ nick: identity.nick, gid: identity.gid, node: mt.connected && mt.myNodeNum != null ? nodeId(mt.myNodeNum) : "" });
  openSheet("My QR code",
    h("div", { class: "qr" }),
    h("p", { class: "center" }, h("strong", {}, identity.nick || "No nickname set"), h("br"),
      h("span", { class: "mono" }, "goTenna " + gidLabel(identity.gid)), mt.connected ? h("span", { class: "mono" }, " · " + nodeId(mt.myNodeNum)) : null),
    h("p", { class: "note center" }, "Friends scan this in Backtrail (People → Scan QR) to add you as a contact."),
    h("button", { onclick: () => copy(link) }, "Copy link"));
  $("sheetBody").querySelector(".qr").innerHTML = qr.qrSvg(link);
}
$("myQrBtn").onclick = myQr;
$("myQrBtn2").onclick = myQr;
$("inviteBtn").onclick = () => {
  if (!identity.pass) { toast("Set and save a group passphrase first."); return; }
  const link = qr.channelLink({ name: identity.nick ? identity.nick + "'s group" : "", pass: identity.pass });
  openSheet("Group invite",
    h("div", { class: "warn" }, "Anyone who scans this code can read and send your group's encrypted goTenna messages. Show it only to people in your group."),
    h("div", { class: "qr" }),
    h("p", { class: "note center" }, "They scan it in Backtrail (People → Scan QR) to set the same passphrase."));
  $("sheetBody").querySelector(".qr").innerHTML = qr.qrSvg(link);
};
$("scanBtn").onclick = async () => {
  if (!isNative && !qr.webScanSupported()) { askForLink("Add from a link", "This browser can't use the camera to scan. Paste a Backtrail or Meshtastic link instead."); return; }
  try { const text = await qr.scan(); if (text) handleLink(text); }
  catch (e) { toast("Scan failed: " + e.message); }
};
function askForLink(title, hint) {
  const input = h("input", { placeholder: "backtrail://… or https://meshtastic.org/e/#…", spellcheck: "false", autocapitalize: "off" });
  openSheet(title, h("p", { class: "note" }, hint), input,
    h("button", { class: "primary", onclick: () => { const v = input.value.trim(); if (v) { closeSheet(); handleLink(v); } } }, "Use link"));
  input.focus();
}
async function handleLink(text) {
  const l = qr.parseLink(text);
  if (l.type === "contact") {
    const existing = (l.gid && store.findContact({ gid: l.gid })) || (l.node && store.findContact({ node: parseNodeId(l.node) }));
    editContact({ ...(existing || {}), name: l.nick || existing?.name || "", gid: l.gid || existing?.gid || null, node: l.node ? parseNodeId(l.node) : existing?.node ?? null });
  } else if (l.type === "channel") {
    if (!(await confirmSheet("Join group?", `Use this group passphrase${l.name ? " (" + l.name + ")" : ""}? It replaces your current passphrase.`, "Join"))) return;
    identity.pass = l.pass; $("passphrase").value = l.pass; saveId(identity);
    await applyPassphrase(l.pass); toast("Group passphrase set.");
  } else if (l.type === "meshtastic") {
    if (!mt.connected) { toast("Connect your Meshtastic radio first, then scan again."); return; }
    let n = 0;
    try { n = MeshtasticRadio.decodeChannelUrl(l.url).settings.length; } catch { toast("That Meshtastic link is not valid."); return; }
    if (!(await confirmSheet("Replace channels?", `This sets your Meshtastic radio to the ${n} channel${n > 1 ? "s" : ""} and LoRa settings in the link, replacing its current channels.`, "Replace", { danger: true }))) return;
    try { await mt.importChannelUrl(l.url); toast("Channels updated."); showMeshtastic(); } catch (e) { toast("Couldn't update channels: " + e.message); }
  } else {
    openSheet("Scanned text", h("div", { class: "mono linkbox" }, l.text), h("button", { onclick: () => copy(l.text) }, "Copy"));
  }
}

// ---------------------------------------------------------------- map & breadcrumbs
const radar = new RadarView($("radar"), (p) => pickPoint(p));
const street = new StreetView($("street"), (p) => pickPoint(p));
let streetOn = false, stopWatch = null, stopHeading = null, recording = false, heading = null, target = null;
const places = new Map(); // sender key -> {lat, lon, label, type, ts}

function learnPlace(m) {
  if (m.dir !== "in" || !m.loc || m.fromId == null) return;
  if (m.kind === "sos" && Date.now() - m.ts > 86400e3) return;
  const key = (m.net === "meshtastic" ? "n:" : "g:") + m.fromId;
  places.set(key, { id: key, lat: m.loc.lat, lon: m.loc.lon, label: m.fromName, type: m.kind === "sos" ? "sos" : "contact", ts: m.ts });
}
function mapPoints() {
  const pts = new Map(places);
  if (mt.connected) for (const n of mt.nodesList()) {
    if (!n.position) continue;
    const key = "n:" + n.num, c = store.findContact({ node: n.num }), prev = pts.get(key);
    if (prev && prev.type === "sos") continue;
    pts.set(key, { id: key, lat: n.position.lat, lon: n.position.lon, label: (c && c.name) || n.shortName || n.id, type: c ? "contact" : "node", ts: (n.lastHeard || 0) * 1000 });
  }
  for (const c of store.contacts()) {
    if (!c.loc) continue;
    const key = c.node != null ? "n:" + c.node : c.gid ? "g:" + store.gidHex(c.gid) : "c:" + c.id;
    const prev = pts.get(key);
    if (!prev || (prev.ts || 0) < (c.loc.ts || 0)) pts.set(key, { id: key, lat: c.loc.lat, lon: c.loc.lon, label: c.name, type: prev?.type === "sos" ? "sos" : "contact", ts: c.loc.ts });
  }
  const t = store.track();
  if (t.length) pts.set("start", { id: "start", lat: t[0].lat, lon: t[0].lon, label: "Start", type: "start", ts: t[0].ts });
  if (target && !target.id) pts.set("target", { ...target, id: "target", type: "contact" });
  return [...pts.values()];
}
function refreshMap() {
  const track = store.track();
  const data = { me: myPos, points: mapPoints(), track, heading };
  if (streetOn) street.set(data); else radar.set(data);
  $("trailStats").textContent = track.length > 1
    ? `Trail: ${geo.formatDistance(geo.trackLength(track))} · ${track.length} points${recording ? " · recording" : ""}`
    : recording ? "Recording… walk to lay down a trail" : "";
  if (target) showTarget(target);
}
function updateMyPos() {
  $("myPos").textContent = myPos ? `You: ${fmtLL(myPos)}${myPos.acc ? ` ±${geo.formatDistance(myPos.acc)}` : ""}` : "Locating…";
}
function pickPoint(p) { target = p; if (p) showTarget(p); else $("mapCard").classList.add("hidden"); }
function showTarget(p) {
  const card = $("mapCard");
  const d = myPos ? geo.distance(myPos, p) : null, b = myPos ? geo.bearing(myPos, p) : null;
  const arrow = b != null ? h("div", { class: "arrow", style: `transform: rotate(${(b - (heading ?? 0)).toFixed(0)}deg)` }, "➤") : null;
  card.replaceChildren(arrow,
    h("div", { class: "item-main" }, h("strong", {}, p.label || "Point"),
      h("span", { class: "sub" }, myPos ? `${geo.formatDistance(d)} ${geo.cardinal(b)} · ${Math.round(b)}°${heading == null ? " true" : ""}` : "Waiting for your location"),
      p.ts ? h("span", { class: "sub" }, "as of " + ago(p.ts)) : null),
    h("button", { class: "ghost icon-btn", "aria-label": "Close", onclick: () => pickPoint(null) }, "✕"));
  card.classList.remove("hidden");
}
function showOnMap(loc, label) {
  target = { lat: loc.lat, lon: loc.lon, label, ts: loc.ts || null };
  showTab("map");
  street.recenter();
}
async function startLocation() {
  if (stopWatch || demoPos) return;
  try {
    stopWatch = await geo.watch((p) => {
      myPos = p; updateMyPos();
      if (recording) addCrumb(p);
      if (document.body.dataset.tab === "map") refreshMap();
    }, () => {});
  } catch (e) { $("myPos").textContent = "Location unavailable: " + e.message; }
  if (!stopHeading) stopHeading = geo.watchHeading((hd) => { heading = hd; if (document.body.dataset.tab === "map") { radar.heading = hd; radar.draw(); if (target) showTarget(target); } });
}
function stopLocation() {
  if (recording) return;
  if (stopWatch) { stopWatch(); stopWatch = null; }
  if (stopHeading) { stopHeading(); stopHeading = null; heading = null; }
}
function addCrumb(p) {
  if (p.acc != null && p.acc > 60) return; // too inaccurate to plot
  const t = store.track(), last = t[t.length - 1];
  if (last && geo.distance(last, p) < 8 && p.ts - last.ts < 60000) return;
  store.addTrackPoint({ lat: p.lat, lon: p.lon, acc: p.acc, alt: p.alt, ts: p.ts });
}
$("recBtn").onclick = async () => {
  recording = !recording;
  $("recBtn").classList.toggle("rec-on", recording);
  $("recBtn").textContent = recording ? "■ Stop recording" : "● Record trail";
  if (recording) { await startLocation(); if (myPos) addCrumb(myPos); toast("Recording your trail. Keep Backtrail open."); }
  else if (document.body.dataset.tab !== "map") stopLocation();
  refreshMap();
};
$("backBtn").onclick = () => {
  const t = store.track();
  if (!t.length) { toast("No trail yet. Tap Record trail where you start."); return; }
  pickPoint({ id: "start", lat: t[0].lat, lon: t[0].lon, label: "Start of trail", type: "start", ts: t[0].ts });
};
$("clearTrailBtn").onclick = async () => {
  if (!store.track().length) return;
  if (await confirmSheet("Clear trail?", "Delete your recorded breadcrumb trail from this device?", "Clear", { danger: true })) { store.clearTrack(); refreshMap(); }
};
$("gpxBtn").onclick = async () => {
  const t = store.track();
  if (t.length < 2) { toast("Record a trail first."); return; }
  const name = `backtrail-${new Date(t[0].ts).toISOString().slice(0, 10)}.gpx`;
  const gpx = geo.toGpx(t, "Backtrail " + new Date(t[0].ts).toLocaleString());
  if (isNative) {
    try {
      const { Filesystem, Directory, Encoding, Share } = await import("./vendor/native.js");
      const w = await Filesystem.writeFile({ path: name, data: gpx, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: name, files: [w.uri], dialogTitle: "Save or send your trail" });
    } catch (e) { if (!/cancel/i.test(e?.message || "")) toast("Couldn't share: " + e.message); }
    return;
  }
  const a = h("a", { href: URL.createObjectURL(new Blob([gpx], { type: "application/gpx+xml" })), download: name });
  document.body.append(a); a.click(); a.remove();
};
function setStreet(on) {
  streetOn = on;
  $("street").classList.toggle("hidden", !on);
  $("radar").classList.toggle("hidden", on);
  $("mapModeBtn").textContent = on ? "Radar" : "Street map";
  refreshMap();
}
$("mapModeBtn").onclick = () => {
  if (!streetOn && !store.settings().mapTiles) {
    toast("Turn on Street map in Settings first. The radar works with no internet.");
    return;
  }
  setStreet(!streetOn);
};

// ---------------------------------------------------------------- data
async function showDataStats() {
  const n = (await store.listMessages(2000).catch(() => [])).length;
  $("dataStats").textContent = `${n} message${n === 1 ? "" : "s"}, ${store.contacts().length} contact${store.contacts().length === 1 ? "" : "s"}, ${store.track().length} trail points stored on this device.`;
}
$("clearHistoryBtn").onclick = async () => {
  if (!(await confirmSheet("Clear history?", "Delete every saved message from this device? This can't be undone.", "Delete", { danger: true }))) return;
  await store.clearMessages(); msgEls.clear(); places.clear(); $("history").replaceChildren(); refreshHero(); showDataStats();
};
$("clearContactsBtn").onclick = async () => {
  if (!store.contacts().length) return;
  if (!(await confirmSheet("Delete all contacts?", "Remove every contact from this device?", "Delete", { danger: true }))) return;
  for (const c of store.contacts()) store.deleteContact(c.id);
  renderPeople(); buildToOptions(); showDataStats();
};

// ---------------------------------------------------------------- identity form
$("showPass").onclick = () => { const p = $("passphrase"); p.type = p.type === "password" ? "text" : "password"; };
$("saveId").onclick = async () => {
  identity.nick = $("nick").value.trim();
  identity.gid = ($("gid").value.trim() || randGid()).replace(/[^0-9a-fA-F]/g, "").slice(0, 12).padStart(12, "0").toLowerCase();
  identity.pass = $("passphrase").value;
  $("gid").value = identity.gid;
  saveId(identity);
  await applyPassphrase(identity.pass);
  if (dev.connected) await dev.setIdentity(myGid()).catch(() => false);
  toast("Identity saved.");
};

// ---------------------------------------------------------------- tabs & navigation
function showTab(tab) {
  const prev = document.body.dataset.tab;
  document.body.dataset.tab = tab;
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  if (tab === "messages") { unread = 0; showUnread(); requestAnimationFrame(scrollDown); }
  if (tab === "map") { startLocation(); requestAnimationFrame(refreshMap); }
  else if (prev === "map") stopLocation();
  if (tab === "people") { renderPeople(); if (!myPos) fix().then(renderPeople); }
  if (tab === "settings") showDataStats();
}
document.querySelectorAll("#tabbar button").forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
document.querySelectorAll("[data-connect]").forEach((b) => {
  b.onclick = () => (b.dataset.connect === "gotenna" ? connectGotenna() : connectMeshtastic("bluetooth"));
});

// Android back button (MainActivity → OnBackPressedDispatcher). true = handled.
window.__backtrailBack = () => {
  if ($("sheet").open) { closeSheet(); return true; }
  if ($("aboutDlg").open) { $("aboutDlg").close(); return true; }
  if (document.querySelector(".scan-overlay")) { document.querySelector(".scan-cancel").click(); return true; }
  if (document.body.dataset.tab !== "messages") { showTab("messages"); return true; }
  return false;
};

// ---------------------------------------------------------------- About / legal
$("aboutBtn").onclick = () => $("aboutDlg").showModal();
$("aboutBtn2").onclick = () => $("aboutDlg").showModal();
$("aboutClose").onclick = () => $("aboutDlg").close();
$("aboutDlg").addEventListener("click", (e) => { if (e.target === $("aboutDlg")) $("aboutDlg").close(); });
if (location.hash === "#about") $("aboutDlg").showModal();

// ---------------------------------------------------------------- startup
applyPassphrase(identity.pass);
showMeshtastic();
renderPeople();
loadHistory();
if (!isNative) navigator.serviceWorker?.register("sw.js").catch(() => {});
(() => {
  const splash = $("splash");
  if (!splash) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const minShow = location.hash === "#about" ? 0 : reduced ? 300 : 1500;
  setTimeout(() => { splash.classList.add("done"); setTimeout(() => splash.remove(), 700); }, minShow);
})();
// Refresh relative times ("5 min ago") once a minute.
setInterval(() => { if (document.body.dataset.tab === "people") renderPeople(); }, 60000);

// Store-screenshot demo hook. Inert unless a developer sets "backtrail.demo" in
// local storage through the WebView debugger (tools/store-demo.js); never set by the app.
try {
  if (localStorage.getItem("backtrail.demo") === "1") {
    window.__bt = {
      dev, mt, store, showTab, showMeshtastic, setGotennaUi, showGotennaInfo, renderPeople, refreshMap, pickPoint,
      updateComposer, openSheet, closeSheet, myQr, showSos, loadHistory, buildToOptions,
      setPos: (p, heading = null) => { demoPos = true; myPos = { ts: Date.now(), ...p }; updateMyPos(); radar.heading = heading; },
    };
  }
} catch { /* storage unavailable */ }
