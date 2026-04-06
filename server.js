const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// In-memory ticket store
let tickets = [];

// ── Health check ──────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── GET all tickets ───────────────────────────────────────────
app.get("/tickets", (req, res) => {
  res.json(tickets);
});

// ── GET single ticket ─────────────────────────────────────────
app.get("/tickets/:id", (req, res) => {
  const ticket = tickets.find((t) => t.id === req.params.id);
  if (!ticket) return res.status(404).json({ error: "Ticket not found" });
  res.json(ticket);
});

// ── POST create ticket ────────────────────────────────────────
app.post("/tickets", (req, res) => {
  const { title, description, priority, status } = req.body;
  if (!title) return res.status(400).json({ error: "Title is required" });

  const ticket = {
    id: uuidv4(),
    title,
    description: description || "",
    priority: priority || "medium",
    status: status || "open",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  tickets.unshift(ticket);
  res.status(201).json(ticket);
});

// ── PATCH update ticket ───────────────────────────────────────
app.patch("/tickets/:id", (req, res) => {
  const index = tickets.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Ticket not found" });

  tickets[index] = {
    ...tickets[index],
    ...req.body,
    id: tickets[index].id,
    updated_at: new Date().toISOString(),
  };

  res.json(tickets[index]);
});

// ── DELETE ticket ─────────────────────────────────────────────
app.delete("/tickets/:id", (req, res) => {
  const index = tickets.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Ticket not found" });
  tickets.splice(index, 1);
  res.json({ deleted: true });
});

// ── 404 fallback ──────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.listen(PORT, () => {
  console.log(`TeleFix backend running on port ${PORT}`);
});