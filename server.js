// Ejecutar con: node server.js
// Opcional: ADMIN_TOKEN="xxx" ATTENDANT_TOKEN="yyy" node server.js

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { randomUUID } = require("crypto");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin123";
const ATTENDANT_TOKEN = process.env.ATTENDANT_TOKEN || "scan123";
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "checkins.json");

const app = express();
app.use(cors());
app.use(express.json());

// Cargar base
let db = { checkins: [] };
try {
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }
} catch {}

// Helpers
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
const nowISO = () => new Date().toISOString();

// SSE (panel admin en tiempo real)
const clients = new Set();
function broadcast(evt) {
  const data = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) res.write(data);
}

// Auth por Bearer
function requireBearer(expected) {
  return (req, res, next) => {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    if (token !== expected) return res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
    next();
  };
}

// Azafatas: registrar check-in
app.post("/api/checkin", requireBearer(ATTENDANT_TOKEN), (req, res) => {
  const { eventId, code, attendant, deviceId, scannedAt } = req.body || {};
  if (!eventId || !code) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

  const existing = db.checkins.find((c) => c.eventId === eventId && c.code === code);
  if (existing) return res.json({ ok: true, duplicate: true, firstSeenAt: existing.createdAt });

  const row = {
    id: randomUUID(),
    eventId,
    code: String(code),
    attendant: attendant || null,
    deviceId: deviceId || null,
    scannedAt: scannedAt || nowISO(),
    createdAt: nowISO(),
  };
  db.checkins.push(row);
  save();
  broadcast({ type: "checkin", payload: row });
  res.json({ ok: true, duplicate: false, createdAt: row.createdAt });
});

// Admin: listado
app.get("/admin/checkins", requireBearer(ADMIN_TOKEN), (req, res) => {
  const { eventId } = req.query;
  let rows = db.checkins;
  if (eventId) rows = rows.filter((r) => r.eventId === eventId);
  rows = rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json({ ok: true, rows, total: rows.length });
});

// ⚠️ Admin: stream en vivo (SSE)
// Nota: EventSource NO envía Authorization. Para que funcione ya mismo,
// NO pedimos token aquí. El listado /admin/checkins sí requiere token.
app.get("/admin/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: "hello", ts: nowISO() })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// Servir estáticos (azafatas + admin)
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log(`Admin token: ${ADMIN_TOKEN} | Attendant token: ${ATTENDANT_TOKEN}`);
});
