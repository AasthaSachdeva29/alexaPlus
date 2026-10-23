// End-to-end test: starts the server, speaks to the simulated Alexa+ and checks MCP behaviour.
// Run: npm test   (uses PORT 3999)
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 3999, BASE = `http://127.0.0.1:${PORT}`;
const proc = spawn("node", ["src/server.mjs"], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
const chat = (text) => fetch(`${BASE}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, conversationId: "t" }) }).then((r) => r.json());
let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log("  ✓", name); };

try {
  await fetch(`${BASE}/api/reset`, { method: "POST" });

  await t("MCP: initialize negotiates 2025-11-25 and lists 9 tools", async () => {
    const c = new Client({ name: "test", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
    const { tools } = await c.listTools();
    assert.equal(tools.length, 9);
    assert.ok(tools.every((x) => x.annotations && x.outputSchema), "every tool has annotations + outputSchema");
    const res = await c.listResources(); assert.equal(res.resources.length, 2);
    const pr = await c.listPrompts(); assert.equal(pr.prompts.length, 1);
    await c.close();
  });

  await t("status reports a low score with open high alerts", async () => {
    const r = await chat("Alexa, how safe is my home network?");
    assert.equal(r.tool, "get_security_status");
    assert.ok(r.structured.score < 60 && r.structured.openAlerts === 5);
  });

  await t("destructive action requires confirmation (two-step)", async () => {
    const a = await chat("Isolate the garage smart plug");
    assert.equal(a.structured.needsConfirmation, true);
    assert.equal(a.state.devices.find((d) => d.id === "plug-garage").status, "online", "not isolated before yes");
    const b = await chat("yes");
    assert.equal(b.structured.isolated, true);
    assert.equal(b.state.devices.find((d) => d.id === "plug-garage").status, "quarantined");
  });

  await t("score improves after containment", async () => {
    const r = await chat("how secure am I");
    assert.ok(r.structured.score > 43, `score ${r.structured.score}`);
  });

  await t("saying no cancels a pending isolation", async () => {
    await chat("block the nursery camera");
    const r = await chat("no");
    assert.match(r.speech, /leave it/i);
    assert.equal(r.state.devices.find((d) => d.id === "cam-nursery").status, "online");
  });

  await t("restore, scan, explain (technical), guest mode, digest, bedtime", async () => {
    assert.equal((await chat("restore the garage plug")).structured.restored, true);
    assert.ok((await chat("scan the printer")).structured.findings.length >= 1);
    assert.match((await chat("explain the nursery camera in technical detail")).speech, /RTSP/);
    assert.equal((await chat("turn on guest wifi for 2 hours")).structured.enabled, true);
    assert.ok((await chat("weekly summary")).structured.blockedConnections > 0);
    assert.equal((await chat("good night")).structured.routine, "bedtime");
  });

  await t("security: bad Origin rejected, GET not allowed, input validated", async () => {
    const o = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}" });
    assert.equal(o.status, 403);
    assert.equal((await fetch(`${BASE}/mcp`)).status, 405);
    assert.equal((await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "" }) })).status, 400);
  });

  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1;
} finally {
  proc.kill();
}
