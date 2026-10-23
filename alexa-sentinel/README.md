# Sentinel: a home-network guardian for Alexa+ (MCP server + simulator)

Built for the **Build, Ship, Shape: Amazon Developer Hackathon, Alexa+ track**.

> "Alexa, is my home safe tonight?" Sentinel turns scary network-security signals into calm, spoken answers and safe one-sentence actions.

## What is in this repo

| Path | What it is |
|---|---|
| `src/mcp-server.mjs` | **The real deliverable.** A self-hosted MCP server: 9 tools, 2 resources, 1 prompt. |
| `src/server.mjs` | HTTP host: serves the MCP endpoint (`POST /mcp`, Streamable HTTP, spec 2025-11-25) and the web app. |
| `src/orchestrator.mjs` | The simulated "Alexa+ brain". Uses a real MCP **Client** so every request is genuine MCP traffic. |
| `src/store.mjs` | Simulated home network (12 devices, 5 alerts). Swap for a real NIDS/router adapter in production. |
| `public/index.html` | Simulated Alexa+ web experience: voice in/out, score gauge, device grid, live MCP trace. |
| `test/e2e.mjs` | 7 automated end-to-end checks (`npm test`). |

## Run it (2 minutes)

```bash
npm install
npm start            # http://127.0.0.1:3000
npm test             # optional: runs 7 end-to-end checks
```

Open http://127.0.0.1:3000 in **Chrome or Edge** (voice input uses the Web Speech API). Click **Auto-play demo** to see the whole story hands-free.

Point any MCP client at `http://127.0.0.1:3000/mcp` (for example the MCP Inspector: `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP").

## Why this idea is strong against the four judging criteria

1. **Tech implementation**: real MCP over Streamable HTTP, protocol 2025-11-25 negotiated (verified in tests), typed `outputSchema`, tool `annotations`, resources, prompts, server `instructions`, stateless horizontally scalable design, Origin validation, optional bearer auth, localhost binding.
2. **Design**: voice-first. Every tool returns a *speakable sentence* plus `structuredContent` for screens (Echo Show / Fire TV). Destructive actions use a two-step confirmation that fits a voice conversation.
3. **Potential impact**: millions of homes run unmanaged IoT devices; non-technical people cannot read a firewall log but can answer "Should I isolate it?". Alexa+ is the natural place for that conversation.
4. **Quality of idea**: it turns MCP's *tool annotations and instructions* into a safety design (confirm before `destructiveHint` actions) instead of just wrapping an API. It also bridges Alexa+ with the Ring/Echo/Fire TV device ecosystem the hackathon is about.

## Every piece explained

### 1. The MCP server (`src/mcp-server.mjs`)

MCP (Model Context Protocol) lets an AI assistant discover and call tools on *your* server. Alexa+ is the assistant; Sentinel is your server.

`buildServer()` creates an `McpServer` with a name, version and **`instructions`**. The instructions are a system-prompt-like hint the assistant reads: they say to use `get_security_status` for "am I safe", and to always do the confirm=false → confirm=true dance before isolating a device.

Each tool is registered with `registerTool(name, config, handler)`:

- **`name`/`title`/`description`**: the description is what an LLM reads to decide *when* to call the tool, so each one starts with "Use when the customer asks…".
- **`inputSchema`**: zod shapes. The SDK validates arguments before your code runs and publishes JSON Schema to the client.
- **`outputSchema`**: describes `structuredContent`. Clients can validate results and screens can render them without parsing text.
- **`annotations`**: hints to the assistant. `readOnlyHint: true` = safe to call freely; `destructiveHint: true` = ask the human first; `idempotentHint` = repeating is harmless; `openWorldHint: false` = it only touches the user's own network, not the internet.
- **Handler return**: `content[0].text` is the sentence Alexa+ speaks; `structuredContent` is the data for the screen. `isError: true` marks a failure the model can recover from (for example "I could not find a device called X").

The nine tools:

| Tool | Purpose | Safety class |
|---|---|---|
| `get_security_status` | Score 0-100, grade, top issues | read-only |
| `list_devices` | Inventory, filter by room or risk | read-only |
| `explain_alert` | Plain-language or technical explanation | read-only |
| `scan_device` | On-demand device check | read-only |
| `quarantine_device` | Cut a device off (two-step confirm) | **destructive** |
| `restore_device` | Undo isolation | write, reversible |
| `run_safety_check` | Bedtime / leaving-home audit | read-only |
| `set_guest_mode` | Time-limited guest network | write, reversible |
| `weekly_digest` | 7-day summary | read-only |

**Resources** (`sentinel://devices`, `sentinel://alerts`) are read-only data a client can attach as context. **Prompt** `bedtime_routine` is a reusable conversation starter.

**Two-step confirmation**: `quarantine_device(confirm=false)` returns an impact sentence ("…will lose internet access. Should I go ahead?") and changes nothing. Only `confirm=true` acts. The test suite proves the device stays online until the customer says yes.

**Score model** (`store.mjs`): 100 minus a penalty per open alert (high 18, medium 9, low 3). Isolating a device moves its traffic-based alerts to `contained`, so the score visibly rises, which makes the demo satisfying and the model easy to explain.

### 2. Transport (`src/server.mjs`)

- `POST /mcp` uses `StreamableHTTPServerTransport`, the transport named in the track requirements.
- **Stateless**: a new server+transport per request (`sessionIdGenerator: undefined`), so any replica behind a load balancer can answer. `enableJsonResponse: true` returns plain JSON, which is simplest for simple tools.
- `GET`/`DELETE /mcp` return 405 (stateless servers have no SSE stream or session to delete).
- **Origin check** blocks browser-based DNS-rebinding attacks; the server binds to `127.0.0.1` by default.
- **`MCP_API_KEY`** env var enables bearer-token auth. For real Alexa+ integration use OAuth as Amazon's docs require (see "Going to production").
- `/api/chat`, `/api/state`, `/api/reset` exist only for the simulator.

### 3. The simulated Alexa+ (`src/orchestrator.mjs`, `public/index.html`)

The brief allows a simulated Alexa+ experience. To keep it honest and judge-friendly:

- The orchestrator is a **transparent intent router** (regex + device aliases), so the demo is deterministic with no API keys. In real Alexa+, an LLM does this choosing.
- It talks to the server through a real `Client` + `StreamableHTTPClientTransport` doing `initialize` → `tools/list` → `tools/call` on every utterance. The browser's **MCP trace panel** shows each step with arguments, `structuredContent` and latency. This is your proof that the MCP server is really being used.
- It keeps per-conversation `pending` state so "yes" after "Isolate the garage plug?" resolves correctly, like a voice session.
- The UI: orb states (listening/thinking/speaking), mic via Web Speech API, spoken replies via `speechSynthesis`, security-score ring, device cards that flash when risk changes, alerts list with strike-through when contained.

### 4. Tests (`test/e2e.mjs`)

Starts the server on port 3999 and checks: protocol + 9 tools + annotations/outputSchema on every tool, resources and prompts present, status values, two-step confirmation, score improvement, "no" cancels, restore/scan/explain/guest/digest/bedtime, bad Origin → 403, GET → 405, empty input → 400.

## Demo script (aim for 2:30, hard limit 3:00)

| Time | Show | Say |
|---|---|---|
| 0:00 | Title + home screen | "Your home has dozens of devices. Nobody can read a firewall log, but everybody can answer a question. This is Sentinel for Alexa+." |
| 0:15 | Ask: "How safe is my home network?" | Point to score 43 and the trace panel: "That is a real MCP tools/call over Streamable HTTP." |
| 0:45 | "Explain the top alert" | "Plain language, no jargon." |
| 1:05 | "Isolate the garage smart plug" → impact sentence | "Destructive tools need a spoken yes. Nothing changed yet." Show device still online. |
| 1:25 | "Yes" | Score rises, device turns green. |
| 1:45 | "Explain the nursery camera in technical detail" | "Same tool, a `detail` parameter: parents or engineers." |
| 2:05 | "Good night" | Bedtime audit. |
| 2:20 | Show repo + `npm test` green + MCP Inspector | "9 tools, outputSchema, annotations, stateless, tests." |
| 2:40 | Roadmap slide | "Real NIDS adapter, Ring + Fire TV displays, OAuth account linking." |

Record with the screen visible, voice on, YouTube/Vimeo **public**, English, no copyrighted music.

## Submission checklist (Devpost)

- [ ] Repo public **with a LICENSE file** (included: MIT) OR private and shared with: `knmeiss`, `giolaq`, `anishamalde`, `mosesroth`, `emersonsklar` (each must accept; invites expire in 7 days)
- [ ] Repo really calls the MCP tech in code (`src/mcp-server.mjs`, `src/orchestrator.mjs`)
- [ ] Text description (what it does, how it works)
- [ ] Demo video under 3 minutes (public)
- [ ] Product feedback on every tool/SDK you used (MCP SDK, Alexa+ docs, any simulator)
- [ ] Track: **Alexa+**
- [ ] Optional: **Open Source mini challenge** (include repo URL, GitHub username, short description)
- [ ] Optional: **Friction log** (up to 10% score bonus): see `FRICTION_LOG.md`
- [ ] Optional: feature requests

## Going to production (roadmap you can mention)

1. Replace `store.mjs` with adapters: router API, Suricata/Zeek alerts, Ring and Echo device graph.
2. OAuth 2.1 account linking so each household only reaches its own network (the MCP authorization spec).
3. Persist state (DynamoDB) and run stateless on Lambda/ECS behind HTTPS.
4. Add proactive notifications for new high-severity alerts.
5. Rich display cards on Echo Show and Fire TV using `structuredContent`.

## Optional extra: AWS Builder mini challenge

Not implemented in this repo. To qualify, route the orchestrator's intent choice through Amazon Bedrock (tool use) instead of regex, and describe it in your feedback answer.

## License

MIT, see `LICENSE`.
