// Sentinel MCP server: exposes a home-network guardian to Alexa+ over MCP.
// Every tool returns TWO things on purpose:
//   content[0].text      -> short, speakable sentence(s) Alexa+ can read aloud
//   structuredContent    -> machine-readable data a screen (Echo Show / Fire TV) can render
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { store } from "./store.mjs";

const sev = z.enum(["high", "medium", "low"]);

const ok = (speech, data) => ({ content: [{ type: "text", text: speech }], structuredContent: data });
const fail = (speech) => ({ content: [{ type: "text", text: speech }], isError: true });

function resolveDevice(idOrName) {
  const q = idOrName.toLowerCase().trim();
  return (
    store.device(q) ||
    store.devices().find((d) => d.name.toLowerCase() === q) ||
    store.devices().find((d) => d.name.toLowerCase().includes(q) || q.includes(d.name.toLowerCase()))
  );
}

export function buildServer() {
  const server = new McpServer(
    { name: "sentinel-home-guardian", version: "1.0.0", title: "Sentinel Home Guardian" },
    {
      instructions:
        "Sentinel helps a household understand and control the security of devices on their home network. " +
        "Always prefer get_security_status for general 'am I safe' questions. Before isolating a device, " +
        "describe the impact in one sentence and call quarantine_device with confirm=false; only call it again " +
        "with confirm=true after the customer says yes. Speak in plain language, never in jargon.",
    },
  );

  // 1) Overall status ------------------------------------------------------
  server.registerTool(
    "get_security_status",
    {
      title: "Get home security status",
      description:
        "Use when the customer asks if their home network is safe, secure, or okay. Returns a 0-100 score, a letter grade and the most urgent open issues.",
      inputSchema: {},
      outputSchema: {
        score: z.number(), grade: z.string(), openAlerts: z.number(),
        topIssues: z.array(z.object({ id: z.string(), severity: sev, title: z.string(), deviceId: z.string() })),
        quarantinedDevices: z.number(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const open = store.openAlerts().sort((a, b) => ["high", "medium", "low"].indexOf(a.severity) - ["high", "medium", "low"].indexOf(b.severity));
      const score = store.score();
      const grade = store.grade();
      const quarantined = store.devices().filter((d) => d.status === "quarantined").length;
      const speech = open.length
        ? `Your home network scores ${score} out of 100, grade ${grade}. I found ${open.length} open ${open.length === 1 ? "issue" : "issues"}. The most urgent: ${open[0].title}. Want me to explain it?`
        : `Your home network scores ${score} out of 100. Everything looks healthy right now.`;
      return ok(speech, {
        score, grade, openAlerts: open.length, quarantinedDevices: quarantined,
        topIssues: open.slice(0, 3).map((a) => ({ id: a.id, severity: a.severity, title: a.title, deviceId: a.deviceId })),
      });
    },
  );

  // 2) Device inventory ----------------------------------------------------
  server.registerTool(
    "list_devices",
    {
      title: "List connected devices",
      description: "List devices on the home network. Optionally filter by room or by risk level (high, medium, low, none, contained).",
      inputSchema: {
        room: z.string().optional().describe("Room name such as kitchen or nursery"),
        risk: z.enum(["high", "medium", "low", "none", "contained"]).optional(),
      },
      outputSchema: {
        count: z.number(),
        devices: z.array(z.object({ id: z.string(), name: z.string(), room: z.string(), type: z.string(), risk: z.string(), status: z.string() })),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ room, risk }) => {
      let list = store.devices().map((d) => ({ id: d.id, name: d.name, room: d.room, type: d.type, status: d.status, risk: store.riskOf(d.id) }));
      if (room) list = list.filter((d) => d.room.toLowerCase().includes(room.toLowerCase()));
      if (risk) list = list.filter((d) => d.risk === risk);
      const risky = list.filter((d) => d.risk === "high" || d.risk === "medium");
      const speech = list.length === 0
        ? "I did not find any devices matching that."
        : `I see ${list.length} ${list.length === 1 ? "device" : "devices"}${room ? ` in the ${room}` : ""}. ${risky.length ? `${risky.length} need attention, starting with ${risky[0].name}.` : "None of them need attention."}`;
      return ok(speech, { count: list.length, devices: list });
    },
  );

  // 3) Explain an alert in plain language ---------------------------------
  server.registerTool(
    "explain_alert",
    {
      title: "Explain a security alert",
      description:
        "Explain a specific alert in plain language and say what to do. If no alert_id is given, explains the most severe open alert. Can also look up by device name.",
      inputSchema: {
        alert_id: z.string().optional().describe("Alert id such as A-101"),
        device: z.string().optional().describe("Device name or id to find its alert"),
        detail: z.enum(["simple", "technical"]).default("simple"),
      },
      outputSchema: {
        id: z.string(), severity: sev, deviceId: z.string(), title: z.string(), explanation: z.string(), recommendedAction: z.string(), status: z.string(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ alert_id, device, detail }) => {
      let alert = alert_id ? store.alert(alert_id.toUpperCase()) : undefined;
      if (!alert && device) {
        const d = resolveDevice(device);
        if (d) alert = store.alerts().find((a) => a.deviceId === d.id && a.status === "open") || store.alerts().find((a) => a.deviceId === d.id);
      }
      if (!alert && !alert_id && !device) {
        alert = store.openAlerts().sort((a, b) => ["high", "medium", "low"].indexOf(a.severity) - ["high", "medium", "low"].indexOf(b.severity))[0];
      }
      if (!alert) return fail("I could not find an alert matching that. Try asking how safe your network is.");
      const explanation = detail === "technical" ? alert.technical : alert.plain;
      return ok(`${explanation} My advice: ${alert.action}`, {
        id: alert.id, severity: alert.severity, deviceId: alert.deviceId, title: alert.title,
        explanation, recommendedAction: alert.action, status: alert.status,
      });
    },
  );

  // 4) Active scan --------------------------------------------------------
  server.registerTool(
    "scan_device",
    {
      title: "Scan a device",
      description: "Run a quick security scan of one device (open ports, default credentials, firmware, suspicious traffic).",
      inputSchema: { device: z.string().describe("Device name or id") },
      outputSchema: {
        deviceId: z.string(), findings: z.array(z.string()), risk: z.string(),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ device }) => {
      const d = resolveDevice(device);
      if (!d) return fail(`I could not find a device called ${device}.`);
      const findings = store.alerts().filter((a) => a.deviceId === d.id && a.status !== "resolved").map((a) => a.title);
      if (d.firmware === "outdated" && !findings.some((f) => /firmware/i.test(f))) findings.push("Firmware is out of date");
      const risk = store.riskOf(d.id);
      const speech = findings.length
        ? `Scan finished for ${d.name}. I found ${findings.length} ${findings.length === 1 ? "thing" : "things"}: ${findings.join("; ")}.`
        : `Scan finished for ${d.name}. It looks clean.`;
      return ok(speech, { deviceId: d.id, findings, risk });
    },
  );

  // 5) Containment (destructive, two-step confirmation) ---------------------
  server.registerTool(
    "quarantine_device",
    {
      title: "Isolate a device",
      description:
        "Cut a device off from the internet and other devices (it stays powered on). This interrupts the device, so FIRST call with confirm=false to get the impact statement, and only call with confirm=true after the customer explicitly agrees.",
      inputSchema: {
        device: z.string().describe("Device name or id"),
        confirm: z.boolean().default(false).describe("true only after the customer said yes"),
        reason: z.string().optional(),
      },
      outputSchema: { deviceId: z.string(), needsConfirmation: z.boolean(), isolated: z.boolean(), impact: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ device, confirm, reason }) => {
      const d = resolveDevice(device);
      if (!d) return fail(`I could not find a device called ${device}.`);
      if (d.status === "quarantined") return ok(`${d.name} is already isolated.`, { deviceId: d.id, needsConfirmation: false, isolated: true });
      const critical = ["cam-front", "echo-kitchen", "tv-living"].includes(d.id);
      const impact = critical
        ? `${d.name} is part of your everyday setup, isolating it will stop it working until you restore it.`
        : `${d.name} will lose internet and local network access until you restore it.`;
      if (!confirm) {
        return ok(`${impact} Should I go ahead and isolate it?`, { deviceId: d.id, needsConfirmation: true, isolated: false, impact });
      }
      store.quarantine(d.id, reason || "customer requested via Alexa+");
      return ok(`Done. ${d.name} is isolated. Its suspicious connections are cut. Say restore ${d.name} whenever you are ready.`, { deviceId: d.id, needsConfirmation: false, isolated: true });
    },
  );

  server.registerTool(
    "restore_device",
    {
      title: "Restore an isolated device",
      description: "Bring a previously isolated device back onto the network.",
      inputSchema: { device: z.string() },
      outputSchema: { deviceId: z.string(), restored: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ device }) => {
      const d = resolveDevice(device);
      if (!d) return fail(`I could not find a device called ${device}.`);
      if (d.status !== "quarantined") return ok(`${d.name} was not isolated.`, { deviceId: d.id, restored: false });
      store.restore(d.id);
      return ok(`${d.name} is back on the network. I will keep watching it closely.`, { deviceId: d.id, restored: true });
    },
  );

  // 6) Bedtime audit ------------------------------------------------------
  server.registerTool(
    "run_safety_check",
    {
      title: "Run a home safety check",
      description: "Full home audit, suited to a bedtime or leaving-home routine. Summarises score, door camera state and what is still open.",
      inputSchema: { routine: z.enum(["bedtime", "leaving_home", "general"]).default("general") },
      outputSchema: { routine: z.string(), score: z.number(), checks: z.array(z.object({ name: z.string(), passed: z.boolean(), note: z.string() })) },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ routine }) => {
      const open = store.openAlerts();
      const highOpen = open.filter((a) => a.severity === "high").length;
      const cam = store.device("cam-front");
      const checks = [
        { name: "Front door camera online", passed: cam.status === "online", note: cam.status },
        { name: "No high-severity threats", passed: highOpen === 0, note: highOpen ? `${highOpen} open` : "clear" },
        { name: "No unrecognised devices", passed: !open.some((a) => a.category === "unknown_device"), note: "device inventory reviewed" },
        { name: "No services exposed to internet", passed: !open.some((a) => a.category === "exposed_service" || a.category === "weak_credentials"), note: "port exposure reviewed" },
        { name: "Guest network off", passed: !store.guest().enabled, note: store.guest().enabled ? "guest network is on" : "off" },
      ];
      const passed = checks.filter((c) => c.passed).length;
      const label = routine === "bedtime" ? "bedtime check" : routine === "leaving_home" ? "leaving home check" : "safety check";
      const speech = passed === checks.length
        ? `${label} complete. Everything passes, sleep well.`
        : `${label} complete. ${passed} of ${checks.length} checks passed. ${checks.filter((c) => !c.passed).map((c) => c.name).slice(0, 2).join(" and ")} need attention.`;
      return ok(speech, { routine, score: store.score(), checks });
    },
  );

  // 7) Guest network --------------------------------------------------------
  server.registerTool(
    "set_guest_mode",
    {
      title: "Turn guest network on or off",
      description: "Enable a time-limited guest network (separate from family devices) or turn it off.",
      inputSchema: { enabled: z.boolean(), hours: z.number().min(1).max(72).default(4) },
      outputSchema: { enabled: z.boolean(), expiresAt: z.string().nullable() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ enabled, hours }) => {
      store.setGuest(enabled, hours);
      const g = store.guest();
      return ok(enabled ? `Guest network is on for ${hours} hours. It is separate from your family devices and switches off automatically.` : "Guest network is off.", g);
    },
  );

  // 8) Weekly digest ------------------------------------------------------
  server.registerTool(
    "weekly_digest",
    {
      title: "Weekly security digest",
      description: "A short summary of the last 7 days: blocked connections, new devices, alerts raised and resolved.",
      inputSchema: {},
      outputSchema: { blockedConnections: z.number(), newDevices: z.number(), alertsRaised: z.number(), alertsResolved: z.number(), topTalker: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const s = store.stats();
      return ok(
        `This week I blocked ${s.blockedConnections} suspicious connections, saw ${s.newDevices} new devices, and raised ${s.alertsRaised} alerts of which ${s.alertsResolved} are resolved. Your busiest device was the ${s.topTalker}.`,
        s,
      );
    },
  );

  // Resources: data a client can attach as context ---------------------
  server.registerResource(
    "devices",
    "sentinel://devices",
    { title: "Device inventory", description: "All devices with risk level", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(store.devices().map((d) => ({ ...d, risk: store.riskOf(d.id) })), null, 2) }] }),
  );
  server.registerResource(
    "alerts",
    "sentinel://alerts",
    { title: "Open alerts", description: "Current alerts, newest first", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(store.alerts(), null, 2) }] }),
  );

  // Prompt: a ready-made conversation starter ---------------------------
  server.registerPrompt(
    "bedtime_routine",
    { title: "Bedtime security routine", description: "Walk the household through a calm nightly security check", argsSchema: {} },
    async () => ({
      messages: [{ role: "user", content: { type: "text", text: "Run my bedtime security check. If anything is risky, explain it calmly in one or two sentences and offer one clear next step." } }],
    }),
  );

  return server;
}
