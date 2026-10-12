// Notifications for incoming messages, plus (Android) an optional foreground
// service that keeps the Bluetooth radio links alive while the app is in the
// background. Notifications are local only; nothing is sent to any server.
import { isNative } from "./native-ble.js";

const FGS_ID = 7001;
const SERVICE_CONNECTED_DEVICE = 16; // android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
const platform = () => globalThis.Capacitor?.getPlatform?.() || "web";
let mod = null;
const plugins = async () => (mod ??= await import("./vendor/native.js"));
let nextId = 1;
let channelsMade = false;

async function ensureChannels(LN) {
  if (channelsMade || platform() !== "android") return;
  channelsMade = true;
  await LN.createChannel({ id: "messages", name: "Messages", description: "Incoming radio messages", importance: 4, visibility: 0 }).catch(() => {});
  await LN.createChannel({ id: "sos", name: "SOS alerts", description: "Emergency messages from your group", importance: 5, visibility: 1, vibration: true }).catch(() => {});
}

export async function permission(request = false) {
  if (isNative) {
    const { LocalNotifications: LN } = await plugins();
    let st = await LN.checkPermissions();
    if (st.display !== "granted" && request) st = await LN.requestPermissions();
    return st.display === "granted";
  }
  if (!("Notification" in window)) return false;
  if (Notification.permission === "default" && request) await Notification.requestPermission();
  return Notification.permission === "granted";
}

// Show a notification when the app isn't in front (or always, for SOS).
export async function notify(title, body, { sos = false } = {}) {
  if (!sos && document.visibilityState === "visible") return;
  try {
    if (isNative) {
      const { LocalNotifications: LN } = await plugins();
      if (!(await permission(false))) return;
      await ensureChannels(LN);
      await LN.schedule({ notifications: [{ id: nextId++, title, body, largeBody: body, channelId: sos ? "sos" : "messages", smallIcon: "ic_stat_backtrail" }] });
    } else if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body, icon: "assets/icon-192.png", tag: sos ? "sos" : undefined });
    }
  } catch { /* notifications are best-effort */ }
}

// ---- background link (Android foreground service) ----
export const backgroundSupported = () => isNative && platform() === "android";
let fgsOn = false;
export async function setBackground(on, body = "Keeping your radios connected") {
  if (!backgroundSupported()) return false;
  const { ForegroundService: FS } = await plugins();
  try {
    if (on) {
      if (!(await permission(true))) return false;
      await FS.startForegroundService({ id: FGS_ID, title: "Backtrail is listening", body, smallIcon: "ic_stat_backtrail", serviceType: SERVICE_CONNECTED_DEVICE, silent: true });
      fgsOn = true;
    } else if (fgsOn) {
      await FS.stopForegroundService();
      fgsOn = false;
    }
    return true;
  } catch { return false; }
}
