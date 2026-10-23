// Simulated home network state. In production this module would be replaced by real
// adapters (router API, a NIDS such as Suricata/Zeek, Ring/Alexa device graph).
// Keeping it behind one small interface means the MCP layer never changes.

const SEVERITY_WEIGHT = { high: 18, medium: 9, low: 3 };

function seed() {
  const now = Date.now();
  const mins = (m) => new Date(now - m * 60_000).toISOString();
  return {
    quarantineLog: [],
    guestMode: { enabled: false, expiresAt: null },
    devices: [
      { id: "tv-living", name: "Living Room Fire TV", type: "fire_tv", room: "living room", ip: "192.168.1.21", vendor: "Amazon", status: "online", firmware: "up_to_date" },
      { id: "cam-front", name: "Front Door Camera", type: "ring_camera", room: "front door", ip: "192.168.1.30", vendor: "Ring", status: "online", firmware: "up_to_date" },
      { id: "echo-kitchen", name: "Kitchen Echo Show", type: "echo", room: "kitchen", ip: "192.168.1.14", vendor: "Amazon", status: "online", firmware: "up_to_date" },
      { id: "plug-garage", name: "Garage Smart Plug", type: "smart_plug", room: "garage", ip: "192.168.1.57", vendor: "NoName-Tech", status: "online", firmware: "unknown" },
      { id: "cam-nursery", name: "Nursery BabyCam", type: "ip_camera", room: "nursery", ip: "192.168.1.62", vendor: "BabyCam-X", status: "online", firmware: "outdated" },
      { id: "printer-office", name: "Office Printer", type: "printer", room: "office", ip: "192.168.1.70", vendor: "Brother", status: "online", firmware: "up_to_date" },
      { id: "thermo-hall", name: "Hallway Thermostat", type: "thermostat", room: "hallway", ip: "192.168.1.44", vendor: "Nest-like", status: "online", firmware: "outdated" },
      { id: "laptop-saumya", name: "Work Laptop", type: "laptop", room: "office", ip: "192.168.1.101", vendor: "Dell", status: "online", firmware: "up_to_date" },
      { id: "phone-1", name: "Family Phone", type: "phone", room: "bedroom", ip: "192.168.1.102", vendor: "Samsung", status: "online", firmware: "up_to_date" },
      { id: "nas-study", name: "Study NAS", type: "nas", room: "study", ip: "192.168.1.80", vendor: "Synology", status: "online", firmware: "up_to_date" },
      { id: "bulb-bedroom", name: "Bedroom Smart Bulb", type: "bulb", room: "bedroom", ip: "192.168.1.91", vendor: "Philips", status: "online", firmware: "up_to_date" },
      { id: "unknown-9f", name: "Unknown device 9F:2A", type: "unknown", room: "unknown", ip: "192.168.1.133", vendor: "Unknown", status: "online", firmware: "unknown", firstSeen: mins(512) },
    ],
    alerts: [
      { id: "A-101", deviceId: "plug-garage", severity: "high", category: "c2_beaconing", status: "open", detectedAt: mins(95),
        title: "Garage Smart Plug is talking to a suspicious server",
        technical: "Periodic outbound TCP/8443 beacon every 60s (±2s) to 185.220.x.x, a host flagged on public threat-intel lists. Low-entropy payload, consistent size 312B: classic command-and-control keepalive.",
        plain: "The garage smart plug has been quietly phoning a server that is on known bad-actor lists, once every minute. That is how infected gadgets check in for instructions.",
        action: "Isolate the plug, then replace or factory reset it." },
      { id: "A-102", deviceId: "cam-nursery", severity: "high", category: "weak_credentials", status: "open", detectedAt: mins(240),
        title: "Nursery camera still uses its default password and is reachable from the internet",
        technical: "Port 554 (RTSP) forwarded via UPnP. Camera accepts admin/admin. Firmware 2.1.4 has CVE-listed auth bypass.",
        plain: "Your nursery camera still has its factory password and its video port is open to the internet. Strangers could potentially watch the stream.",
        action: "Isolate it now, change the password, update firmware, then restore it." },
      { id: "A-103", deviceId: "unknown-9f", severity: "medium", category: "unknown_device", status: "open", detectedAt: mins(512),
        title: "An unrecognised device joined at 2:14 AM",
        technical: "MAC 9F:2A:.. locally administered (randomised), no hostname, DHCP only, 38MB uploaded in the first hour.",
        plain: "A device you have not seen before joined your Wi-Fi in the middle of the night and uploaded a fair amount of data.",
        action: "Check whether a guest or family member added it; if not, isolate it." },
      { id: "A-104", deviceId: "printer-office", severity: "medium", category: "exposed_service", status: "open", detectedAt: mins(1300),
        title: "Office printer management page is exposed beyond your home network",
        technical: "UPnP IGD mapping exposes TCP/631 and the web admin on 80 to WAN.",
        plain: "Your printer's admin page is reachable from outside your home. Printers are a favourite way in for attackers.",
        action: "Turn off UPnP port mapping for the printer." },
      { id: "A-105", deviceId: "thermo-hall", severity: "low", category: "outdated_firmware", status: "open", detectedAt: mins(4000),
        title: "Hallway Thermostat is running old firmware",
        technical: "Firmware 3.2.1, vendor advisory recommends 3.4.0 or later.",
        plain: "The thermostat is a few updates behind. Not urgent, but worth doing this weekend.",
        action: "Install the pending firmware update." },
    ],
    weeklyStats: { blockedConnections: 1284, newDevices: 2, alertsRaised: 7, alertsResolved: 3, topTalker: "Living Room Fire TV" },
  };
}

let state = seed();

export const store = {
  reset() { state = seed(); },
  snapshot() { return structuredClone(state); },
  devices() { return state.devices; },
  alerts() { return state.alerts; },
  guest() { return state.guestMode; },
  stats() { return state.weeklyStats; },
  log() { return state.quarantineLog; },
  device(id) { return state.devices.find((d) => d.id === id); },
  alert(id) { return state.alerts.find((a) => a.id === id); },
  openAlerts() { return state.alerts.filter((a) => a.status === "open"); },
  score() {
    const open = state.alerts.filter((a) => a.status === "open");
    const penalty = open.reduce((s, a) => s + SEVERITY_WEIGHT[a.severity], 0);
    return Math.max(0, 100 - penalty);
  },
  grade() {
    const s = this.score();
    return s >= 90 ? "A" : s >= 75 ? "B" : s >= 60 ? "C" : s >= 40 ? "D" : "F";
  },
  riskOf(deviceId) {
    const open = state.alerts.filter((a) => a.status === "open" && a.deviceId === deviceId);
    if (state.devices.find((d) => d.id === deviceId)?.status === "quarantined") return "contained";
    if (open.some((a) => a.severity === "high")) return "high";
    if (open.some((a) => a.severity === "medium")) return "medium";
    if (open.length) return "low";
    return "none";
  },
  quarantine(deviceId, reason) {
    const d = this.device(deviceId);
    d.status = "quarantined";
    state.quarantineLog.push({ deviceId, reason, at: new Date().toISOString() });
    // Containing a device neutralises its live-traffic alerts (not firmware advisories).
    for (const a of state.alerts) {
      if (a.deviceId === deviceId && a.status === "open" && a.category !== "outdated_firmware") a.status = "contained";
    }
  },
  restore(deviceId) {
    const d = this.device(deviceId);
    d.status = "online";
    for (const a of state.alerts) if (a.deviceId === deviceId && a.status === "contained") a.status = "resolved";
  },
  setGuest(enabled, hours) {
    state.guestMode = { enabled, expiresAt: enabled ? new Date(Date.now() + hours * 3600_000).toISOString() : null };
  },
};
