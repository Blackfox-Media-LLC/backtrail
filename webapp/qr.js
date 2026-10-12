// QR codes: share your contact card or a channel invite, and scan someone
// else's. Links are plain text and never touch a server:
//   backtrail://c?n=<nick>&g=<goTenna ID hex>&m=<Meshtastic node ID>
//   backtrail://ch?n=<channel name>&p=<passphrase>
//   https://meshtastic.org/e/#...   (standard Meshtastic channel link)
import { isNative } from "./native-ble.js";
import { qrcode } from "./vendor/libs.js";

// SVG markup for a QR code (dark modules on a white quiet zone, scanner-friendly).
export function qrSvg(text) {
  const q = qrcode(0, "M");
  q.addData(unescape(encodeURIComponent(text)));   // UTF-8 bytes
  q.make();
  const n = q.getModuleCount(), m = 4, size = n + m * 2;
  let path = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path += `M${c + m} ${r + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

export function contactLink({ nick = "", gid = "", node = "" }) {
  const p = new URLSearchParams();
  if (nick) p.set("n", nick);
  if (gid) p.set("g", gid);
  if (node) p.set("m", node);
  return "backtrail://c?" + p.toString();
}
export function channelLink({ name = "", pass }) {
  const p = new URLSearchParams();
  if (name) p.set("n", name);
  p.set("p", pass);
  return "backtrail://ch?" + p.toString();
}

// Returns {type:"contact", nick, gid, node} | {type:"channel", name, pass} |
// {type:"meshtastic", url} | {type:"text", text}.
export function parseLink(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^backtrail:\/\/(c|ch)\?(.*)$/i);
  if (m) {
    const p = new URLSearchParams(m[2]);
    if (m[1].toLowerCase() === "c") {
      const gid = (p.get("g") || "").replace(/[^0-9a-f]/gi, "").slice(0, 12).toLowerCase();
      const node = (p.get("m") || "").trim();
      return { type: "contact", nick: (p.get("n") || "").slice(0, 30), gid, node };
    }
    if (p.get("p")) return { type: "channel", name: p.get("n") || "", pass: p.get("p") };
  }
  if (/^https:\/\/meshtastic\.org\/e\/#/i.test(s)) return { type: "meshtastic", url: s };
  return { type: "text", text: s };
}

// Scan a QR code with the camera. Resolves the text, or null if cancelled.
export async function scan() {
  if (isNative) {
    const { CapacitorBarcodeScanner, CapacitorBarcodeScannerTypeHint } = await import("./vendor/native.js");
    try {
      const r = await CapacitorBarcodeScanner.scanBarcode({
        hint: CapacitorBarcodeScannerTypeHint.QR_CODE, scanInstructions: "Point at a Backtrail or Meshtastic QR code",
        scanButton: false, cameraDirection: 1,
      });
      return r && r.ScanResult ? r.ScanResult : null;
    } catch (e) {
      if (/cancel/i.test(e?.message || "")) return null;
      throw e;
    }
  }
  return webScan();
}

// Browser fallback: BarcodeDetector over a live camera preview (Chrome/Edge on
// Android, ChromeOS, macOS). Elsewhere the caller offers "paste a link".
export const webScanSupported = () => !isNative && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
async function webScan() {
  if (!webScanSupported()) throw new Error("This browser can't scan QR codes. Paste the link instead.");
  const det = new BarcodeDetector({ formats: ["qr_code"] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  const wrap = document.createElement("div");
  wrap.className = "scan-overlay";
  wrap.innerHTML = `<video playsinline muted></video><div class="scan-frame"></div><button class="ghost scan-cancel">Cancel</button>`;
  document.body.appendChild(wrap);
  const video = wrap.querySelector("video");
  video.srcObject = stream;
  await video.play();
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; stream.getTracks().forEach((t) => t.stop()); wrap.remove(); resolve(v); };
    wrap.querySelector(".scan-cancel").onclick = () => finish(null);
    const tick = async () => {
      if (done) return;
      try { const codes = await det.detect(video); if (codes.length) return finish(codes[0].rawValue); } catch { /* frame not ready */ }
      setTimeout(tick, 250);
    };
    tick();
  });
}
