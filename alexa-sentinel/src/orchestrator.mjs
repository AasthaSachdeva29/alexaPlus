// A tiny stand-in for the Alexa+ "brain".
// Real Alexa+ uses an LLM to pick MCP tools. For the simulator we use a transparent intent router so the
// demo is deterministic (no API keys, no flakiness) while the transport is the REAL MCP protocol:
// every request below goes through an MCP Client -> Streamable HTTP -> the Sentinel MCP server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const pendingByConversation = new Map(); // conversationId -> { device }

const YES = /^(yes|yeah|yep|sure|do it|go ahead|confirm|please do|okay|ok)\b/i;
const NO = /^(no|nope|cancel|don't|do not|stop|never mind)\b/i;

export function route(text, pending) {
  const t = text.toLowerCase().trim();
  if (pending && YES.test(t)) return { kind: "confirm", tool: "quarantine_device", args: { device: pending.device, confirm: true } };
  if (pending && NO.test(t)) return { kind: "cancel" };

  const device = matchDevice(t);
  if (/\b(restore|unblock|bring back|reconnect|un-?isolate)\b/.test(t)) return { tool: "restore_device", args: { device: device || "" } };
  if (/\b(quarantine|isolate|block|cut off|disconnect|kick)\b/.test(t)) return { tool: "quarantine_device", args: { device: device || "", confirm: false } };
  if (/\bguest\b/.test(t)) {
    const hrs = t.match(/(\d+)\s*(hour|hr)/);
    return { tool: "set_guest_mode", args: { enabled: !/\b(off|disable|stop|end)\b/.test(t), hours: hrs ? Number(hrs[1]) : 4 } };
  }
  if (/\b(bedtime|good ?night|going to bed|leaving|heading out|audit|safety check)\b/.test(t))
    return { tool: "run_safety_check", args: { routine: /leav|heading out/.test(t) ? "leaving_home" : /bed|night/.test(t) ? "bedtime" : "general" } };
  if (/\b(digest|summary|this week|weekly|report)\b/.test(t)) return { tool: "weekly_digest", args: {} };
  if (/\bscan\b/.test(t)) return { tool: "scan_device", args: { device: device || "" } };
  if (/\b(explain|why|what happened|what does|tell me more|technical|details?)\b/.test(t) || /\b(alert|suspicious|threat)\b/.test(t)) {
    const id = t.match(/a-?\d{3}/i);
    return { tool: "explain_alert", args: { ...(id ? { alert_id: id[0].toUpperCase().replace(/^A(\d)/, "A-$1") } : {}), ...(device ? { device } : {}), detail: /technical|engineer|geek/.test(t) ? "technical" : "simple" } };
  }
  const roomMatch = t.match(/\b(kitchen|living room|garage|nursery|office|bedroom|hallway|study|front door)\b/);
  if (/\b(devices?|connected|on my (network|wifi|wi-fi)|what's on|risky|dangerous)\b/.test(t))
    return { tool: "list_devices", args: { ...(roomMatch ? { room: roomMatch[1] } : {}), ...(/risky|dangerous|high risk/.test(t) ? { risk: "high" } : {}) } };
  if (/\b(safe|secure|security|status|score|okay|ok|protected|how am i|how's my)\b/.test(t)) return { tool: "get_security_status", args: {} };
  return { kind: "fallback" };
}

const ALIASES = {
  "plug-garage": ["garage plug", "smart plug", "plug", "garage"],
  "cam-nursery": ["nursery", "babycam", "baby cam", "baby camera", "baby monitor"],
  "unknown-9f": ["unknown device", "unknown", "stranger", "9f"],
  "printer-office": ["printer"],
  "thermo-hall": ["thermostat"],
  "cam-front": ["front door camera", "door camera", "front camera", "ring"],
  "tv-living": ["fire tv", "living room tv", "tv"],
  "echo-kitchen": ["echo show", "kitchen echo", "echo"],
  "nas-study": ["nas", "storage"],
  "laptop-saumya": ["laptop"],
  "phone-1": ["phone"],
  "bulb-bedroom": ["bulb", "light"],
};
function matchDevice(t) {
  let best = null;
  for (const [id, words] of Object.entries(ALIASES)) for (const w of words) if (t.includes(w) && (!best || w.length > best.len)) best = { id, len: w.length };
  return best?.id || null;
}

export async function handleUtterance({ text, conversationId, mcpUrl }) {
  const trace = [];
  const pending = pendingByConversation.get(conversationId);
  const decision = route(text, pending);

  if (decision.kind === "cancel") {
    pendingByConversation.delete(conversationId);
    return { speech: "Okay, I will leave it as is.", trace, structured: null };
  }
  if (decision.kind === "fallback") {
    return {
      speech: "I can check how safe your network is, list your devices, explain an alert, scan or isolate a device, or run a bedtime check. What would you like?",
      trace, structured: null,
    };
  }
  if (!decision.args.device && ["restore_device", "scan_device", "quarantine_device"].includes(decision.tool)) {
    return { speech: "Which device do you mean? For example, the garage smart plug or the nursery camera.", trace, structured: null };
  }

  const client = new Client({ name: "simulated-alexa-plus", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
  const t0 = Date.now();
  await client.connect(transport);
  trace.push({ step: "initialize", detail: `connected to ${client.getServerVersion()?.name ?? "server"} over MCP Streamable HTTP`, ms: Date.now() - t0 });
  try {
    const tools = await client.listTools();
    trace.push({ step: "tools/list", detail: `${tools.tools.length} tools discovered`, ms: Date.now() - t0 });

    const t1 = Date.now();
    const result = await client.callTool({ name: decision.tool, arguments: decision.args });
    trace.push({ step: "tools/call", tool: decision.tool, arguments: decision.args, isError: !!result.isError, structured: result.structuredContent ?? null, ms: Date.now() - t1 });

    const speech = result.content?.find((c) => c.type === "text")?.text ?? "Done.";
    const sc = result.structuredContent ?? null;

    // Two-step confirmation state lives in the orchestrator, exactly like a voice session would.
    if (decision.tool === "quarantine_device" && sc?.needsConfirmation) pendingByConversation.set(conversationId, { device: sc.deviceId });
    else pendingByConversation.delete(conversationId);

    return { speech, trace, structured: sc, tool: decision.tool, awaitingConfirmation: !!(sc && sc.needsConfirmation) };
  } finally {
    await client.close().catch(() => {});
  }
}
