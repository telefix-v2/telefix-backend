const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Security: strict CORS ──────────────────────────────────────
// Change this to your actual Expo tunnel domain or leave * for dev
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20kb" })); // Limit request body size

// ── Simple in-memory rate limiter ─────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT = 30;        // max requests
const RATE_WINDOW = 60 * 1000; // per 60 seconds

function rateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };

  if (now - entry.start > RATE_WINDOW) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count += 1;
  }

  rateLimitMap.set(ip, entry);

  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests. Slow down." });
  }
  next();
}

// ── Stricter rate limit for AI endpoint ───────────────────────
const aiRateLimitMap = new Map();
const AI_RATE_LIMIT = 10; // max 10 AI calls per minute per IP

function aiRateLimit(req, res, next) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const entry = aiRateLimitMap.get(ip) || { count: 0, start: now };

  if (now - entry.start > RATE_WINDOW) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count += 1;
  }

  aiRateLimitMap.set(ip, entry);

  if (entry.count > AI_RATE_LIMIT) {
    return res.status(429).json({ error: "AI rate limit reached. Wait 1 minute." });
  }
  next();
}

app.use(rateLimit);

// ── Health check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    ai: ANTHROPIC_KEY ? "configured" : "missing",
  });
});

// ── Tickets ───────────────────────────────────────────────────
let tickets = [];

app.get("/tickets", (req, res) => {
  res.json(tickets);
});

app.get("/tickets/:id", (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  res.json(ticket);
});

app.post("/tickets", (req, res) => {
  const { title, description, priority, status, carrier } = req.body;
  if (!title || typeof title !== "string" || title.trim().length === 0) {
    return res.status(400).json({ error: "Title is required" });
  }
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
  if (index === -1) return res.status(404).json({ error: "Ticket not found" });
  const allowed = ["status", "priority", "title", "description", "carrier"];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  tickets[index] = { ...tickets[index], ...updates, updated_at: new Date().toISOString() };
  res.json(tickets[index]);
});

app.delete("/tickets/:id", (req, res) => {
  const index = tickets.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Ticket not found" });
  tickets.splice(index, 1);
  res.json({ deleted: true });
});

// ── AI Proxy ──────────────────────────────────────────────────
// The app sends messages here — the key never leaves the server
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

### UNIVERSAL TELECOM ALARMS:
- LOS, LOF, AIS, BER, OSNR, RSL, TX/RX power alarms
- Cell outages: RF, baseband, transport, power
- Power: rectifier, battery, generator, AC/DC
- Environmental: high temp, door intrusion, flood, HVAC
- Transport: Ethernet OAM, MPLS-TP, pseudowire
- Core: HSS, MME, SGW/PGW (4G), AMF/SMF (5G)
- Sync/timing: GPS loss, PTP/SyncE, holdover
- Fiber: OTDR events, connector loss, splice, cable cut
- DWDM: amplifier, mux/demux, wavelength drift

## HOW YOU WORK:
1. Immediately identify carrier, alarm severity, and category
2. Ask max 3 targeted diagnostic questions (one at a time)
3. Provide numbered step-by-step resolution with CLI commands, expected results, and escalation path

Be direct and technical. Use proper telecom terminology. Flag safety hazards when relevant.`;

app.post("/ai/troubleshoot", aiRateLimit, async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: "AI not configured on server." });
  }

  const { messages } = req.body;

  // Validate messages
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 50) {
    return res.status(400).json({ error: "Invalid messages." });
  }

  for (const msg of messages) {
    if (!["user", "assistant"].includes(msg.role) || typeof msg.content !== "string") {
      return res.status(400).json({ error: "Invalid message format." });
    }
    if (msg.content.length > 4000) {
      return res.status(400).json({ error: "Message too long." });
    }
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages,
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

// ── 404 fallback ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.listen(PORT, () => {
  console.log(`TeleFix backend running on port ${PORT}`);
  if (!ANTHROPIC_KEY) console.warn("WARNING: ANTHROPIC_API_KEY not set!");
});
