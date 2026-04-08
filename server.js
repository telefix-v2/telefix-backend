const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" })); // Large limit for PDFs and images

// ── Rate limiter ───────────────────────────────────────────────
const rateLimitMap = new Map();
const aiRateLimitMap = new Map();
const RATE_WINDOW = 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) { entry.count = 1; entry.start = now; }
  else entry.count += 1;
  rateLimitMap.set(ip, entry);
  if (entry.count > 60) return res.status(429).json({ error: "Too many requests." });
  next();
}

function aiRateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = aiRateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) { entry.count = 1; entry.start = now; }
  else entry.count += 1;
  aiRateLimitMap.set(ip, entry);
  if (entry.count > 15) return res.status(429).json({ error: "AI rate limit reached. Wait 1 minute." });
  next();
}

app.use(rateLimit);

// ── Health ─────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), ai: ANTHROPIC_KEY ? "configured" : "missing" });
});

// ── Tickets ────────────────────────────────────────────────────
let tickets = [];

app.get("/tickets", (req, res) => res.json(tickets));

app.get("/tickets/:id", (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: "Not found" });
  res.json(ticket);
});

app.post("/tickets", (req, res) => {
  const { title, description, priority, status, carrier } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: "Title required" });
  const ticket = {
    id: uuidv4(),
    title: title.trim().slice(0, 200),
    description: (description || "").slice(0, 2000),
    priority: ["low", "medium", "high", "critical"].includes(priority) ? priority : "medium",
    status: ["open", "in_progress", "resolved"].includes(status) ? status : "open",
    carrier: ["Verizon", "AT&T", "T-Mobile", "Unknown"].includes(carrier) ? carrier : "Unknown",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  tickets.unshift(ticket);
  res.status(201).json(ticket);
});

app.patch("/tickets/:id", (req, res) => {
  const index = tickets.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Not found" });
  const allowed = ["status", "priority", "title", "description", "carrier"];
  const updates = {};
  for (const key of allowed) if (req.body[key] !== undefined) updates[key] = req.body[key];
  tickets[index] = { ...tickets[index], ...updates, updated_at: new Date().toISOString() };
  res.json(tickets[index]);
});

app.delete("/tickets/:id", (req, res) => {
  const index = tickets.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Not found" });
  tickets.splice(index, 1);
  res.json({ deleted: true });
});

// ── AI System Prompt ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are TeleFix AI, an expert telecommunications field operations assistant with deep knowledge of Verizon, AT&T, and T-Mobile networks, hardware, alarm systems, and troubleshooting procedures.

## YOUR EXPERTISE COVERS:

### VERIZON
- Network alarms: NMS, SONET/SDH, IP/MPLS, LTE/5G NR alarms
- Hardware: Ciena, Nokia (ALU), Ericsson RBS, Samsung RRH, CommScope
- Alarm codes: VZW-specific codes, Remedy tickets, MFST alarms
- Systems: BOSS, GDOT, IOMT, Granite, ECPD
- Technologies: FiOS ONT (Calix, Motorola), GPON, FTTP, 5G UW mmWave/Sub-6

### AT&T
- Network alarms: SNET, TIRKS, ARIS, NetCracker NMS alarms
- Hardware: Nokia ISAM/7750, Fujitsu, Ciena 6500, Ericsson, Huawei (legacy)
- Alarm codes: AT&T ALOA, CMISE alarms, U-verse/FirstNet specific
- Systems: LMOS, LFACS, SWITCH, CSAS, DSET
- Technologies: U-verse (VDSL2), GPON, AT&T Fiber, FirstNet LTE Band 14, 5G mmWave

### T-MOBILE
- Network alarms: NetAct, Navisite NMS, SON alarms
- Hardware: Ericsson (Radio 4480/6626), Nokia AirScale, Commscope ONEX
- Alarm codes: T-Mobile NOC alarm taxonomy, TMUS-specific codes
- Systems: TNET, PRISM, WFMS, ServiceNow TMUS
- Technologies: Band 71 (600MHz), Band 41 (2.5GHz) massive MIMO, 5G SA/NSA, CBRS

### UNIVERSAL TELECOM:
- LOS, LOF, AIS, BER, OSNR, RSL, TX/RX power alarms
- Cell outages: RF, baseband, transport, power
- Power: rectifier, battery, generator, AC/DC
- Environmental: high temp, door intrusion, flood, HVAC
- Transport: Ethernet OAM, MPLS-TP, pseudowire
- Core: HSS, MME, SGW/PGW (4G), AMF/SMF (5G)
- Sync/timing: GPS loss, PTP/SyncE, holdover
- Fiber: OTDR events, connector loss, splice, cable cut
- DWDM: amplifier, mux/demux, wavelength drift

## WHEN ANALYZING FILES OR IMAGES:
- For PDF reports: extract all alarm codes, readings, and anomalies. Provide specific fixes.
- For OTDR traces: identify event locations, loss values, reflections, and fiber faults.
- For site photos: identify equipment type, alarm LED states, physical damage, installation issues.
- For spreadsheets/CSVs: identify out-of-range values, patterns, and problem areas.
- Always provide numbered step-by-step resolution procedures.

Be direct and technical. Use proper telecom terminology. Flag safety hazards when relevant.`;

// ── AI Proxy — handles text, images, AND PDFs ──────────────────
app.post("/ai/troubleshoot", aiRateLimit, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: "AI not configured." });

  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50) {
    return res.status(400).json({ error: "Invalid messages." });
  }

  // Build Claude-compatible messages — supports text, images, and PDFs
  const claudeMessages = [];

  for (const msg of messages) {
    if (!["user", "assistant"].includes(msg.role)) continue;

    // If content is a string — plain text message
    if (typeof msg.content === "string") {
      if (msg.content.length > 10000) {
        return res.status(400).json({ error: "Message too long." });
      }
      claudeMessages.push({ role: msg.role, content: msg.content });
      continue;
    }

    // If content is an array — could contain images, PDFs, text blocks
    if (Array.isArray(msg.content)) {
      const contentBlocks = [];

      for (const block of msg.content) {
        // Text block
        if (block.type === "text") {
          contentBlocks.push({ type: "text", text: block.text ?? "" });
          continue;
        }

        // Image block (from camera or gallery)
        if (block.type === "image" && block.source?.data) {
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: block.source.media_type ?? "image/jpeg",
              data: block.source.data,
            },
          });
          continue;
        }

        // PDF document block
        if (block.type === "document" && block.source?.data) {
          contentBlocks.push({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: block.source.data,
            },
          });
          continue;
        }
      }

      if (contentBlocks.length > 0) {
        claudeMessages.push({ role: msg.role, content: contentBlocks });
      }
      continue;
    }
  }

  if (claudeMessages.length === 0) {
    return res.status(400).json({ error: "No valid messages." });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "pdfs-2024-09-25",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: claudeMessages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err?.error?.message ?? "AI error" });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text ?? "No response.";
    res.json({ text });
  } catch (e) {
    console.error("AI proxy error:", e);
    res.status(500).json({ error: "AI request failed." });
  }
});

// ── 404 ────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: "Route not found" }));

app.listen(PORT, () => {
  console.log(`TeleFix backend running on port ${PORT}`);
  if (!ANTHROPIC_KEY) console.warn("WARNING: ANTHROPIC_API_KEY not set!");
});
