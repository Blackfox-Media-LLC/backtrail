// DEV TOOL ONLY: never bundled into the app (it lives outside webapp/).
// Injected over the WebView DevTools protocol to stage store screenshots with a
// fictional hiking group, since emulators have no radios and a real phone holds
// the owner's own history and location.
//
//   await __storeDemoSetup()    back up this device's Backtrail data (kept on the
//                               device), seed the demo data, set the demo flag, reload
//   await __storeDemo(scene)    after the reload: fake radios, show a scene
//   await __storeDemoRestore()  put the owner's data back, clear the flag, reload
//
// Scenes: welcome, messages, map, people, sos, radios, radiocfg, qr, settings
(() => {
  const PREFIX = "backtrail.", BAK = "backtrail.bak.";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dbAll = () => new Promise((res, rej) => {
    const q = indexedDB.open("backtrail", 1);
    q.onupgradeneeded = () => q.result.createObjectStore("messages", { keyPath: "id", autoIncrement: true }).createIndex("ts", "ts");
    q.onsuccess = () => { const r = q.result.transaction("messages").objectStore("messages").getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); };
    q.onerror = () => rej(q.error);
  });

  // Guadalupe Mountains (public trail area); all people and IDs are fictional.
  const C = { lat: 31.8913, lon: -104.8607 };
  const at = (dLat, dLon) => ({ lat: +(C.lat + dLat).toFixed(5), lon: +(C.lon + dLon).toFixed(5) });
  const NODE = { me: 0xa1b2c3d4, maya: 0x5e11a7c2, ridge: 0x0b3d77e1, camp: 0x77c1d4a0, scout: 0x29fa61be, relay: 0xc0ffee42, ranger: 0x4d2e9b10 };

  window.__storeDemoSetup = async function () {
    if (localStorage.getItem("backtrail.demo") !== "1") {
      for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX) && !k.startsWith(BAK)) localStorage.setItem(BAK + k.slice(PREFIX.length), localStorage.getItem(k));
      localStorage.setItem(BAK + "msgs", JSON.stringify(await dbAll()));
      localStorage.setItem(BAK + "saved", "1");
    }
    const s = await import("./store.js");
    await s.clearMessages();
    localStorage.setItem("backtrail.id", JSON.stringify({ nick: "Pat", gid: "00c0ffee1234", pass: "demo-only-passphrase" }));
    localStorage.setItem("backtrail.settings", JSON.stringify({ notify: true, background: false, shareLocCheckin: true, mapTiles: false }));
    const now = Date.now(), min = 60000;
    localStorage.setItem("backtrail.contacts", JSON.stringify([
      { id: "c1", name: "Sam", gid: "0000a1b2c3d4", node: null, lastSeen: now - 4 * min, loc: { ...at(0.0072, 0.0051), acc: 6, ts: now - 4 * min } },
      { id: "c2", name: "Jo", gid: "0000beef0042", node: null, lastSeen: now - 2 * min, loc: { ...at(-0.0049, -0.0068), acc: 9, ts: now - 2 * min } },
      { id: "c3", name: "Maya", gid: null, node: NODE.maya, lastSeen: now - 11 * min, loc: { ...at(0.0021, -0.0094), acc: 12, ts: now - 11 * min } },
    ]));
    const track = [];
    for (let i = 0; i <= 40; i++) {
      const f = i / 40;
      track.push({ ...at(-0.0105 + f * 0.0105 + Math.sin(f * 7) * 0.0009, -0.0031 + f * 0.0031 + Math.cos(f * 5) * 0.0012), acc: 5, ts: now - (40 - i) * 3 * min });
    }
    localStorage.setItem("backtrail.track", JSON.stringify(track));
    const M = [
      { ts: now - 58 * min, net: "gotenna", dir: "in", kind: "text", text: "Made the ridge. Spring is running, filling up now.", fromName: "Sam", fromId: "0000a1b2c3d4", encrypted: true, hops: 1 },
      { ts: now - 56 * min, net: "gotenna", dir: "out", kind: "text", text: "Nice! We're about 20 minutes behind you.", direct: true, toName: "Sam", toId: "0000a1b2c3d4", encrypted: true, delivered: true },
      { ts: now - 41 * min, net: "meshtastic", dir: "in", kind: "text", text: "Wind is picking up on the north face. Layers on before the saddle.", fromName: "Ridge Lookout", fromId: NODE.ridge, channel: 1, channelName: "Ridge Crew", snr: 7.5, rssi: -91, hops: 1 },
      { ts: now - 22 * min, net: "meshtastic", dir: "in", kind: "checkin", text: "At camp", fromName: "Maya", fromId: NODE.maya, channel: 0, channelName: "Primary", loc: { ...at(0.0021, -0.0094), acc: 12 }, snr: 9.25, rssi: -84, hops: 0 },
      { ts: now - 14 * min, net: "gotenna", dir: "out", kind: "checkin", text: "On my way", loc: { ...at(0, 0), acc: 5 }, encrypted: true },
      { ts: now - 9 * min, net: "gotenna", dir: "in", kind: "loc", text: "", fromName: "Jo", fromId: "0000beef0042", loc: { ...at(-0.0049, -0.0068), acc: 9 }, encrypted: true },
      { ts: now - 2 * min, net: "gotenna", dir: "in", kind: "sos", text: "Rolled my ankle below the saddle. Can walk slowly.", fromName: "Jo", fromId: "0000beef0042", loc: { ...at(-0.0049, -0.0068), acc: 9 }, encrypted: true, hops: 1 },
    ];
    for (const m of M) await s.addMessage(m);
    localStorage.setItem("backtrail.demo", "1");
    location.reload();
    return "seeded";
  };

  function fakeRadios() {
    const bt = window.__bt;
    if (!bt) throw new Error("demo hook not active (setup first)");
    const { dev, mt } = bt, now = Math.floor(Date.now() / 1000);
    Object.defineProperty(dev, "connected", { configurable: true, get: () => true });
    mt.connected = true;
    mt.myNodeNum = NODE.me;
    mt.metadata = { firmwareVersion: "2.7.12.784e71f" };
    mt.config = { lora: { region: 1, modemPreset: 0, hopLimit: 3, usePreset: true }, device: { role: 0 }, power: { isPowerSaving: true, waitBluetoothSecs: 300 } };
    mt.channels = new Map([
      [0, { index: 0, role: 1, name: "Primary", psk: new Uint8Array([1]) }],
      [1, { index: 1, role: 2, name: "Ridge Crew", psk: new Uint8Array(32).fill(7) }],
    ]);
    const n = (num, longName, shortName, hwModel, extra) => [num, { num, id: "!" + num.toString(16).padStart(8, "0"), longName, shortName, hwModel, role: "CLIENT",
      lastHeard: null, snr: null, rssi: null, hops: null, position: null, battery: null, voltage: null, chUtil: null, airUtil: null, env: null, ...extra }];
    mt.nodes = new Map([
      n(NODE.me, "Pat's Radio", "PAT", "HELTEC_V3", { battery: 87, voltage: 4.02, chUtil: 4.2, airUtil: 0.9, lastHeard: now }),
      n(NODE.maya, "Maya", "MAYA", "RAK4631", { lastHeard: now - 660, snr: 9.25, rssi: -84, hops: 0, battery: 64, position: { ...at(0.0021, -0.0094) } }),
      n(NODE.ridge, "Ridge Lookout", "RDG1", "STATION_G2", { role: "ROUTER", lastHeard: now - 95, snr: 7.5, rssi: -91, hops: 1, battery: 101, position: { ...at(0.0131, 0.0042) }, env: { temp: 14.5, humidity: 38 } }),
      n(NODE.camp, "Base Camp", "CAMP", "T_ECHO", { lastHeard: now - 300, snr: 3.0, rssi: -104, hops: 1, battery: 92, position: { ...at(-0.0118, -0.0035) } }),
      n(NODE.scout, "Scout 2", "SC2", "TBEAM", { lastHeard: now - 1260, snr: -4.5, rssi: -116, hops: 2, battery: 41 }),
      n(NODE.relay, "Saddle Relay", "SDL", "RAK4631", { role: "ROUTER", lastHeard: now - 40, snr: 5.75, rssi: -97, hops: 1, battery: 101, position: { ...at(0.0054, 0.0118) } }),
      n(NODE.ranger, "Trailhead Info", "THD", "HELTEC_V3", { lastHeard: now - 2900, snr: -9.0, rssi: -121, hops: 3, battery: 78 }),
    ]);
    bt.setGotennaUi(true);
    bt.showGotennaInfo({ model: "goTenna Mesh", fwRev: "1.1.8", serial: "MX########", battery: 82, region: 1 });
    bt.showMeshtastic();
    bt.setPos({ ...at(0, 0), acc: 5 }, 35);
    bt.updateComposer();
    bt.renderPeople();
  }

  window.__storeDemo = async function (scene) {
    const bt = window.__bt, $ = (id) => document.getElementById(id);
    document.querySelector("#splash")?.remove();
    bt.closeSheet();
    $("aboutDlg").open && $("aboutDlg").close();
    $("sosBanner").classList.add("hidden");
    if (scene === "welcome") { // first-run look: no radios, no history
      delete bt.dev.connected; // drop the fake getter; the real one reports false
      bt.mt.connected = false;
      bt.setGotennaUi(false); bt.showMeshtastic();
      $("history").replaceChildren(); $("hero").classList.remove("hidden"); $("connectStrip").classList.add("hidden");
      bt.showTab("messages"); return "ok";
    }
    fakeRadios();
    document.querySelectorAll("main, .messages, .view").forEach((e) => { e.scrollTop = 0; });
    if (scene === "messages") { bt.showTab("messages"); }
    else if (scene === "sos") {
      bt.showTab("messages");
      const list = await bt.store.listMessages(50);
      bt.showSos(list.filter((m) => m.kind === "sos").pop());
    } else if (scene === "map") {
      bt.showTab("map"); await sleep(400);
      bt.pickPoint({ id: "g:0000beef0042", lat: at(-0.0049, -0.0068).lat, lon: at(-0.0049, -0.0068).lon, label: "Jo", type: "sos", ts: Date.now() - 120000 });
      bt.refreshMap();
    } else if (scene === "people") { bt.showTab("people"); }
    else if (scene === "radios") { bt.showTab("radios"); }
    else if (scene === "radiocfg") {
      bt.showTab("radios"); document.querySelector("details.cfg").open = true; await sleep(200);
      $("mtInfo").querySelector("h3.sub").scrollIntoView({ block: "start" });
    } else if (scene === "qr") { bt.showTab("people"); bt.myQr(); }
    else if (scene === "settings") { bt.showTab("settings"); }
    else throw new Error("unknown scene " + scene);
    await sleep(500);
    document.querySelector(".messages") && ($("messages").scrollTop = $("messages").scrollHeight);
    return "ok";
  };

  window.__storeDemoRestore = async function () {
    if (localStorage.getItem(BAK + "saved") !== "1") throw new Error("no backup on this device");
    const s = await import("./store.js");
    await s.clearMessages();
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX) && !k.startsWith(BAK)) localStorage.removeItem(k);
    const msgs = JSON.parse(localStorage.getItem(BAK + "msgs") || "[]");
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(BAK) || k === BAK + "msgs" || k === BAK + "saved") continue;
      localStorage.setItem(PREFIX + k.slice(BAK.length), localStorage.getItem(k));
    }
    for (const m of msgs) { const { id, ...rest } = m; await s.addMessage(rest); }
    for (const k of Object.keys(localStorage)) if (k.startsWith(BAK)) localStorage.removeItem(k);
    localStorage.removeItem("backtrail.demo");
    location.reload();
    return `restored ${msgs.length} messages`;
  };
})();
